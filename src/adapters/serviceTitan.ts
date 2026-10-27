import { z } from "zod";
import { technicianIdKey } from "../domain/commissionLabor.js";
import { allowlistedGet } from "../domain/commissionProbe.js";
import { classifyInvoiceItem, JOB_LIST_STATUSES } from "../domain/projectFinancials.js";
import type { EstimateRead, InvoiceHeaderRead } from "../domain/stFinancialSummary.js";
import { LABOR_SERVICE_CODE } from "../domain/stLaborCode.js";

const sourceId = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()])
  .transform(String);

const optionalRate = z.preprocess((value) => {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}, z.number().finite().nullable());

const activeFlag = z.preprocess((value) => {
  if (value === "True" || value === "true") return true;
  if (value === "False" || value === "false") return false;
  return value;
}, z.boolean());

const technicianRowSchema = z.object({
  id: sourceId,
  name: z.string().min(1),
  active: activeFlag,
  hourlyRate: optionalRate.optional(),
  burdenRate: optionalRate.optional(),
  commissionRate: optionalRate.optional(),
  isManagedTech: z.boolean().optional(),
});

const technicianPageSchema = z.object({
  data: z.array(z.unknown()),
  hasMore: z.preprocess((value) => {
    if (value === "true" || value === "True") return true;
    if (value === "false" || value === "False") return false;
    return value;
  }, z.boolean().optional()),
  pageSize: z.preprocess((value) => {
    if (value == null || value === "") return undefined;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
    return value;
  }, z.number().int().positive().optional()),
});

function staffNameFrom(body: unknown, id: string): string | null {
  const candidates: unknown[] = [];
  if (body && typeof body === "object") {
    const record = body as { data?: unknown };
    if (Array.isArray(record.data)) candidates.push(...record.data);
    else if (record.data && typeof record.data === "object") candidates.push(record.data);
    candidates.push(body);
  }
  const row = z.object({ id: sourceId, name: z.string().min(1) });
  for (const candidate of candidates) {
    const parsed = row.safeParse(candidate);
    if (!parsed.success) continue;
    const name = parsed.data.name.trim();
    if (parsed.data.id === id && name) return name;
  }
  return null;
}
const projectSchema = z.object({
  id: sourceId,
  number: z.string(),
  name: z.string().nullish(),
  summary: z.string().nullish(),
  status: z.string().nullish(),
  customerId: sourceId,
  locationId: sourceId,
  jobIds: z.array(sourceId),
  startDate: z.string().nullish(),
  targetCompletionDate: z.string().nullish(),
  modifiedOn: z.string().nullish(),
});
export type ServiceTitanProject = z.infer<typeof projectSchema>;
const jobSchema = z.object({
  id: sourceId,
  jobNumber: z.string(),
  projectId: sourceId.nullish(),
  customerId: sourceId,
  locationId: sourceId,
  jobStatus: z.string(),
  summary: z.string().nullish(),
  modifiedOn: z.string(),
});
const appointmentSchema = z.object({
  arrivalWindowStart: z.string().datetime({ offset: true }).nullish(),
  arrivalWindowEnd: z.string().datetime({ offset: true }).nullish(),
  id: sourceId,
  jobId: sourceId,
  appointmentNumber: z.string(),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  status: z.string(),
  active: z.boolean(),
  isConfirmed: z.boolean(),
  modifiedOn: z.string(),
});
const assignmentSchema = z.object({
  id: sourceId,
  jobId: sourceId,
  appointmentId: sourceId,
  technicianId: sourceId,
  technicianName: z.string(),
  active: z.boolean(),
  status: z.string(),
  modifiedOn: z.string(),
});
export type ServiceTitanJob = z.infer<typeof jobSchema>;
export type ServiceTitanAppointment = z.infer<typeof appointmentSchema>;
export type ServiceTitanAssignment = z.infer<typeof assignmentSchema>;
export interface ServiceTitanConfig {
  environment: "production" | "integration";
  tenantId: string;
  clientId: string;
  clientSecret: string;
  appKey: string;
}
const RETRY_AFTER_CAP_MS = 60_000;
const RETRY_AFTER_DEFAULT_MS = 1_000;

/**
 * Retry-After is seconds, or an HTTP date. A missing or unreadable header
 * waits one second. Nothing waits longer than a minute. Zero is a real wait
 * of zero, which is how a polite limit can be honored without sleeping.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (header == null || header.trim() === "") return RETRY_AFTER_DEFAULT_MS;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.min(Math.max(0, Number(trimmed) * 1000), RETRY_AFTER_CAP_MS);
  }
  const when = Date.parse(trimmed);
  if (Number.isFinite(when)) {
    return Math.min(Math.max(0, when - now), RETRY_AFTER_CAP_MS);
  }
  return RETRY_AFTER_DEFAULT_MS;
}

export class ServiceTitanReadError extends Error {}
export class ServiceTitanWriteUncertainError extends ServiceTitanReadError {}

/** An explicitly configured ServiceTitan client. It does not use a process-global
 * token or default tenant: callers must supply the connection for their tenant.
 * It reads projects, jobs, appointments, and assignments. The writes it already
 * has are project notes, file attachments, appointment reschedule, and
 * technician assignment. It does not create or write customer invoices.
 * Reuses the PO application's host allowlist/authentication pattern, without
 * coupling this module to its singleton state or exposing source payloads. */
export interface GrossPayItem {
  id: string;
  technicianId: string | null;
  date: string | null;
  activity: string | null;
  amount: number | null;
  /** TimesheetTime, InvoiceRelatedBonus, CustomBonus, Salary, Reimbursement. */
  type: string | null;
  paidDurationHours: number | null;
  /** Regular, Overtime, DoubleOvertime, PaidTimeOff. */
  paidTimeType: string | null;
  jobId: string | null;
}

export class ServiceTitanReadAdapter {
  private token?: { value: string; expiresAt: number };
  private tokenPending?: Promise<string>;
  private readonly apiHost: string;
  private readonly authHost: string;
  constructor(
    private readonly config: ServiceTitanConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  ) {
    if (
      !["production", "integration"].includes(config.environment) ||
      !/^\d+$/.test(config.tenantId) ||
      !config.clientId.trim() ||
      !config.clientSecret.trim() ||
      !config.appKey.trim()
    ) {
      throw new ServiceTitanReadError(
        "ServiceTitan connection settings are incomplete.",
      );
    }
    this.apiHost =
      config.environment === "production"
        ? "https://api.servicetitan.io"
        : "https://api-integration.servicetitan.io";
    this.authHost =
      config.environment === "production"
        ? "https://auth.servicetitan.io"
        : "https://auth-integration.servicetitan.io";
  }
  /** ServiceTitan tenant id. The labor-code cache is keyed on this. */
  get sourceTenantId(): string {
    return this.config.tenantId;
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60000)
      return this.token.value;
    if (this.tokenPending) return this.tokenPending;
    this.tokenPending = (async () => {
      const r = await this.fetcher(this.authHost + "/connect/token", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      });
      if (!r.ok)
        throw new ServiceTitanReadError(
          `ServiceTitan authentication failed (HTTP ${r.status}).`,
        );
      const parsed = z
        .object({
          access_token: z.string().min(1),
          expires_in: z.number().positive(),
        })
        .safeParse(await r.json());
      if (!parsed.success)
        throw new ServiceTitanReadError(
          "ServiceTitan returned an invalid authentication response.",
        );
      this.token = {
        value: parsed.data.access_token,
        expiresAt: Date.now() + parsed.data.expires_in * 1000,
      };
      return this.token.value;
    })();
    try {
      return await this.tokenPending;
    } finally {
      this.tokenPending = undefined;
    }
  }
  private async get(
    family:
      | "jpm"
      | "dispatch"
      | "settings"
      | "crm"
      | "forms"
      | "payroll"
      | "accounting"
      | "sales"
      | "pricebook"
      | "inventory",
    resource: string,
    query?: URLSearchParams,
  ) {
    const path = `/${family}/v2/tenant/${this.config.tenantId}/${resource}`;
    const url = this.apiHost + path + (query ? "?" + query.toString() : "");
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const token = await this.accessToken();
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "ST-App-Key": this.config.appKey,
          },
        });
      } catch {
        throw new ServiceTitanReadError(
          "ServiceTitan read could not complete. The previous snapshot should be retained.",
        );
      }
      if (response.status === 401) this.token = undefined;
      if (response.status === 429 && attempt < maxAttempts) {
        await this.sleep(retryAfterMs(response.headers.get("Retry-After")));
        continue;
      }
      if (!response.ok) {
        throw new ServiceTitanReadError(
          `ServiceTitan read failed (HTTP ${response.status}).`,
        );
      }
      return response.json() as Promise<unknown>;
    }
    throw new ServiceTitanReadError("ServiceTitan read failed (HTTP 429).");
  }

  /**
   * GET that returns the status instead of throwing.
   * Used by the commission probe and payroll-settings fallback.
   * The method is GET. There is no write path on this adapter method.
   */
  private async getRaw(
    family: "jpm" | "dispatch" | "settings" | "crm" | "forms" | "payroll" | "accounting" | "sales",
    resource: string,
    query?: URLSearchParams,
  ): Promise<{ status: number; body: unknown }> {
    const path = `/${family}/v2/tenant/${this.config.tenantId}/${resource}`;
    const url = this.apiHost + path + (query ? "?" + query.toString() : "");
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const token = await this.accessToken();
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "ST-App-Key": this.config.appKey,
          },
        });
      } catch {
        throw new ServiceTitanReadError(
          "ServiceTitan read could not complete. The previous snapshot should be retained.",
        );
      }
      if (response.status === 401 && attempt < maxAttempts) {
        this.token = undefined;
        continue;
      }
      if (response.status === 429 && attempt < maxAttempts) {
        await this.sleep(retryAfterMs(response.headers.get("Retry-After")));
        continue;
      }
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = { unparsed: true };
        }
      }
      return { status: response.status, body };
    }
    return { status: 429, body: null };
  }

  /**
   * GET a settings or payroll document on the commission-probe allowlist.
   * Any other path is rejected before a request is made.
   */
  async readAllowlistedGet(
    family: "payroll" | "settings",
    resource: string,
    query?: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    if (!allowlistedGet(family, resource) || resource.includes("..") || resource.startsWith("/")) {
      throw new ServiceTitanReadError("That ServiceTitan read is not allowed.");
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || value.length > 4000 || /[\r\n]/.test(value)) {
        throw new ServiceTitanReadError("That ServiceTitan read is not allowed.");
      }
      params.set(key, value);
    }
    const result = await this.getRaw(family, resource, params);
    return { ok: result.status >= 200 && result.status < 300, status: result.status, body: result.body };
  }
  private async pages<T>(
    family: "jpm" | "dispatch" | "settings",
    resource: string,
    schema: z.ZodType<T, z.ZodTypeDef, any>,
    jobId: string,
  ): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const raw = await this.get(
        family,
        resource,
        new URLSearchParams({
          jobId,
          page: String(page),
          pageSize: "200",
          active: "Any",
        }),
      );
      const result = z
        .object({ data: z.array(schema), hasMore: z.boolean() })
        .safeParse(raw);
      if (!result.success)
        throw new ServiceTitanReadError(
          `Unexpected ServiceTitan ${resource} response.`,
        );
      rows.push(...result.data.data);
      if (!result.data.hasMore) return rows;
    }
    throw new ServiceTitanReadError(
      "ServiceTitan pagination limit reached. No partial snapshot may be imported.",
    );
  }

  async projectNoteReceipt(projectId: string, marker: string) {
    sourceId.parse(projectId);
    for (let page = 1; page <= 100; page++) {
      const response = z
        .object({
          data: z.array(z.object({ text: z.string() })),
          hasMore: z.boolean(),
        })
        .parse(
          await this.get(
            "jpm",
            "projects/" + projectId + "/notes",
            new URLSearchParams({ page: String(page), pageSize: "200" }),
          ),
        );
      if (response.data.some((note) => note.text.includes(marker))) return true;
      if (!response.hasMore) return false;
    }
    throw new ServiceTitanReadError(
      "ST note list is incomplete; no duplicate note was created.",
    );
  }
  async publishProjectNote(projectId: string, text: string) {
    sourceId.parse(projectId);
    const token = await this.accessToken();
    try {
      const response = await this.fetcher(
        this.apiHost +
          "/jpm/v2/tenant/" +
          this.config.tenantId +
          "/projects/" +
          projectId +
          "/notes",
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30000),
          headers: {
            Authorization: "Bearer " + token,
            "ST-App-Key": this.config.appKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text, pinToTop: false }),
        },
      );
      if (response.status === 401) this.token = undefined;
      if (!response.ok)
        return {
          state:
            response.status >= 500 || response.status === 408
              ? "uncertain"
              : "failed",
          message: "ST note request returned HTTP " + response.status + ".",
        };
      const receipt = z
        .object({ text: z.string() })
        .safeParse(await response.json());
      return receipt.success && receipt.data.text.includes(text)
        ? {
            state: "confirmed",
            message: "Document link saved in ST project notes.",
          }
        : {
            state: "uncertain",
            message:
              "ST note receipt could not be confirmed. Check status before retrying.",
          };
    } catch {
      return {
        state: "uncertain",
        message: "ST did not confirm the note. Check status before retrying.",
      };
    }
  }
  async recordReceipts(
    projectId: string,
    jobId: string,
    fileName: string,
    marker: string,
  ) {
    sourceId.parse(projectId);
    sourceId.parse(jobId);
    const project = await this.readProject(projectId);
    if (!project.project.jobIds.includes(jobId))
      throw new ServiceTitanReadError(
        "Selected job no longer belongs to this ST project.",
      );
    const collect = async (family: "forms" | "jpm", resource: string) => {
      const rows: Record<string, unknown>[] = [];
      for (let page = 1; page <= 100; page++) {
        const raw = await this.get(
          family,
          resource,
          new URLSearchParams({ page: String(page), pageSize: "200" }),
        );
        const result = z
          .object({
            data: z.array(z.record(z.unknown())),
            hasMore: z.boolean(),
          })
          .parse(raw);
        rows.push(...result.data);
        if (!result.hasMore) return rows;
      }
      throw new ServiceTitanReadError(
        "ST receipt list is incomplete. Check ST before another publish.",
      );
    };
    const [files, notes] = await Promise.all([
      collect("forms", "jobs/" + jobId + "/attachments"),
      collect("jpm", "projects/" + projectId + "/notes"),
    ]);
    const file = files.find((f) => f.fileName === fileName);
    return {
      attachmentId: file?.id === undefined ? null : sourceId.parse(file.id),
      noteConfirmed: notes.some(
        (n) => typeof n.text === "string" && n.text.includes(marker),
      ),
    };
  }
  async publishRecord(input: {
    projectId: string;
    jobId: string;
    fileName: string;
    mediaType: string;
    bytes: Buffer;
    note: string;
    attachmentId?: string | null;
  }) {
    let attachmentId = input.attachmentId ?? null;
    let phase = "checking";
    try {
      sourceId.parse(input.projectId);
      sourceId.parse(input.jobId);
      const project = await this.readProject(input.projectId);
      if (!project.project.jobIds.includes(input.jobId))
        throw new ServiceTitanReadError(
          "Selected job no longer belongs to this ST project.",
        );
      const token = await this.accessToken();
      const post = async (
        family: string,
        resource: string,
        body: string | FormData,
        json = false,
      ) => {
        let response: Response;
        try {
          response = await this.fetcher(
            this.apiHost +
              "/" +
              family +
              "/v2/tenant/" +
              this.config.tenantId +
              "/" +
              resource,
            {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(30000),
              headers: {
                Authorization: "Bearer " + token,
                "ST-App-Key": this.config.appKey,
                ...(json ? { "Content-Type": "application/json" } : {}),
              },
              body,
            },
          );
        } catch {
          throw new ServiceTitanWriteUncertainError(
            "ST did not confirm the write. Check ST receipt before retrying.",
          );
        }
        if (response.status >= 500 || response.status === 408)
          throw new ServiceTitanWriteUncertainError(
            "ST write outcome is uncertain. Check ST receipt before retrying.",
          );
        if (response.status === 401) this.token = undefined;
        if (!response.ok)
          throw new ServiceTitanReadError(
            "ST rejected the record (HTTP " +
              response.status +
              "). Check Forms job write and JPM project write permissions.",
          );
        try {
          return await response.json();
        } catch {
          throw new ServiceTitanWriteUncertainError(
            "ST accepted the write but its receipt could not be read.",
          );
        }
      };
      if (!attachmentId) {
        phase = "attachment";
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(input.bytes)], { type: input.mediaType }),
          input.fileName,
        );
        const receipt = await post(
          "forms",
          "jobs/" + input.jobId + "/attachments",
          form,
        );
        const parsed = z
          .object({ id: sourceId, fileName: z.string() })
          .safeParse(receipt);
        if (!parsed.success || parsed.data.fileName !== input.fileName)
          throw new ServiceTitanWriteUncertainError(
            "ST attachment receipt did not match the submitted file.",
          );
        attachmentId = parsed.data.id;
      }
      phase = "note";
      const note = await post(
        "jpm",
        "projects/" + input.projectId + "/notes",
        JSON.stringify({
          text: input.note + "\nST attachment ID: " + attachmentId,
          pinToTop: false,
        }),
        true,
      );
      const parsedNote = z.object({ text: z.string() }).safeParse(note);
      if (!parsedNote.success || !parsedNote.data.text.includes(input.note))
        throw new ServiceTitanWriteUncertainError(
          "ST note receipt could not be confirmed.",
        );
      return {
        state: "confirmed",
        attachmentId,
        message:
          "File stored on the selected ST job; revision recorded in the ST project notes.",
      };
    } catch (error) {
      return {
        state:
          error instanceof ServiceTitanWriteUncertainError
            ? "uncertain"
            : attachmentId
              ? "partial"
              : "failed",
        attachmentId,
        message:
          error instanceof ServiceTitanReadError
            ? error.message
            : "ST record publishing failed during " + phase + ".",
      };
    }
  }

  async rescheduleAppointment(
    jobId: string,
    appointmentId: string,
    expectedModifiedOn: string,
    change: {
      start: string;
      end: string;
      arrivalWindowStart: string | null;
      arrivalWindowEnd: string | null;
      technicianIds?: string[];
    },
  ) {
    const before = await this.readJob(jobId);
    const appointment = before.appointments.find((a) => a.id === appointmentId);
    if (
      !appointment ||
      !appointment.active ||
      appointment.modifiedOn !== expectedModifiedOn ||
      !["Scheduled"].includes(appointment.status)
    )
      throw new ServiceTitanReadError(
        "Appointment changed or cannot be rescheduled. Refresh and review it again.",
      );
    // Check every current assigned technician against their full active appointment list.
    const currentTechnicians = [
      ...new Set(
        before.assignments
          .filter((a) => a.appointmentId === appointmentId && a.active)
          .map((a) => a.technicianId),
      ),
    ];
    if (change.technicianIds && !Number.isSafeInteger(Number(appointmentId)))
      throw new ServiceTitanReadError("Invalid appointment ID for assignment.");
    const technicianIds = change.technicianIds ?? currentTechnicians;
    if (change.technicianIds) {
      const active = await this.readTechnicians();
      if (
        new Set(technicianIds).size !== technicianIds.length ||
        technicianIds.some(
          (id) =>
            !Number.isSafeInteger(Number(id)) ||
            !active.some((t) => t.id === id && t.active),
        )
      )
        throw new ServiceTitanReadError("Select active ST technicians.");
    }
    for (const technicianId of technicianIds) {
      for (let page = 1; page <= 100; page++) {
        const parsed = z
          .object({ data: z.array(appointmentSchema), hasMore: z.boolean() })
          .safeParse(
            await this.get(
              "jpm",
              "appointments",
              new URLSearchParams({
                technicianId,
                active: "True",
                page: String(page),
                pageSize: "200",
              }),
            ),
          );
        if (!parsed.success)
          throw new ServiceTitanReadError(
            "Could not verify technician availability.",
          );
        if (
          parsed.data.data.some(
            (a) =>
              a.id !== appointmentId &&
              !["Done", "Canceled"].includes(a.status) &&
              Date.parse(a.start) < Date.parse(change.end) &&
              Date.parse(a.end) > Date.parse(change.start),
          )
        )
          throw new ServiceTitanReadError(
            "A technician has an overlapping ST appointment.",
          );
        if (!parsed.data.hasMore) break;
        if (page === 100)
          throw new ServiceTitanReadError("Availability read incomplete.");
      }
    }
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await this.fetcher(
        this.apiHost +
          `/jpm/v2/tenant/${this.config.tenantId}/appointments/${appointmentId}/reschedule`,
        {
          method: "PATCH",
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          headers: {
            Authorization: "Bearer " + token,
            "ST-App-Key": this.config.appKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            start: change.start,
            end: change.end,
            arrivalWindowStart: change.arrivalWindowStart,
            arrivalWindowEnd: change.arrivalWindowEnd,
          }),
        },
      );
    } catch {
      throw new ServiceTitanWriteUncertainError(
        "ST write outcome is uncertain. Refresh ST before another attempt.",
      );
    }
    if (response.status >= 500)
      throw new ServiceTitanWriteUncertainError(
        "ST returned a server error after publishing. Refresh before retrying.",
      );
    if (!response.ok)
      throw new ServiceTitanReadError(
        `ST rejected rescheduling (HTTP ${response.status}). Refresh ST before another attempt.`,
      );
    if (change.technicianIds) {
      if (!Number.isSafeInteger(Number(appointmentId)))
        throw new ServiceTitanWriteUncertainError(
          "Appointment ID cannot be represented safely for technician assignment.",
        );
      for (const [operation, ids] of [
        [
          "assign-technicians",
          technicianIds.filter((id) => !currentTechnicians.includes(id)),
        ],
        [
          "unassign-technicians",
          currentTechnicians.filter((id) => !technicianIds.includes(id)),
        ],
      ] as const) {
        if (!ids.length) continue;
        try {
          const response = await this.fetcher(
            this.apiHost +
              "/dispatch/v2/tenant/" +
              this.config.tenantId +
              "/appointment-assignments/" +
              operation,
            {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(20000),
              headers: {
                Authorization: "Bearer " + token,
                "ST-App-Key": this.config.appKey,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                jobAppointmentId: Number(appointmentId),
                technicianIds: ids.map(Number),
              }),
            },
          );
          if (!response.ok) throw new Error("Assignment rejected");
        } catch {
          throw new ServiceTitanWriteUncertainError(
            "Appointment dates may have changed but technician updates were not confirmed. Refresh ST before retrying.",
          );
        }
      }
    }
    let after: Awaited<ReturnType<ServiceTitanReadAdapter["readJob"]>>;
    try {
      after = await this.readJob(jobId);
    } catch {
      throw new ServiceTitanWriteUncertainError(
        "ST accepted the request but verification failed. Refresh before retrying.",
      );
    }
    const saved = after.appointments.find((a) => a.id === appointmentId);
    if (
      !saved ||
      Date.parse(saved.start) !== Date.parse(change.start) ||
      Date.parse(saved.end) !== Date.parse(change.end)
    )
      throw new ServiceTitanWriteUncertainError(
        "ST did not confirm the requested times. Refresh before another attempt.",
      );
    if (change.technicianIds) {
      const actual = after.assignments
        .filter((a) => a.appointmentId === appointmentId && a.active)
        .map((a) => a.technicianId)
        .sort();
      if (JSON.stringify(actual) !== JSON.stringify([...technicianIds].sort()))
        throw new ServiceTitanWriteUncertainError(
          "Technician assignment readback did not match the requested crew.",
        );
    }
    return after;
  }
  async listProjects(page = 1, number?: string) {
    if (!Number.isInteger(page) || page < 1 || page > 10000)
      throw new ServiceTitanReadError("Invalid project page.");
    const query = new URLSearchParams({
      page: String(page),
      pageSize: "100",
      sort: "-ModifiedOn",
    });
    if (number) query.set("number", number);
    const result = z
      .object({ data: z.array(projectSchema), hasMore: z.boolean() })
      .safeParse(await this.get("jpm", "projects", query));
    if (!result.success)
      throw new ServiceTitanReadError("Unexpected ServiceTitan project list.");
    return { ...result.data, page };
  }
  async readProject(id: string) {
    if (!/^\d+$/.test(id))
      throw new ServiceTitanReadError("Use a numeric ServiceTitan project ID.");
    const result = projectSchema.safeParse(
      await this.get("jpm", "projects/" + id),
    );
    if (!result.success || result.data.id !== id)
      throw new ServiceTitanReadError("Unexpected ServiceTitan project.");
    if (new Set(result.data.jobIds).size !== result.data.jobIds.length)
      throw new ServiceTitanReadError("Duplicate ST project job IDs.");
    return { project: result.data, observedAt: new Date().toISOString() };
  }
  async readProjectDetails(id: string) {
    const { project } = await this.readProject(id);
    const customer = z
      .object({ id: sourceId, name: z.string() })
      .parse(await this.get("crm", "customers/" + project.customerId));
    const location = z
      .object({
        id: sourceId,
        customerId: sourceId,
        name: z.string(),
        address: z.object({
          street: z.string(),
          unit: z.string().nullish(),
          city: z.string(),
          state: z.string(),
          zip: z.string(),
          country: z.string().optional(),
        }),
      })
      .parse(await this.get("crm", "locations/" + project.locationId));
    if (
      customer.id !== project.customerId ||
      location.id !== project.locationId ||
      location.customerId !== project.customerId
    )
      throw new ServiceTitanReadError(
        "ST project customer/location did not match.",
      );
    const jobs: ServiceTitanJob[] = [];
    for (let offset = 0; offset < project.jobIds.length; offset += 4) {
      const batch = await Promise.all(
        project.jobIds.slice(offset, offset + 4).map(async (jobId) => {
          const job = jobSchema.parse(await this.get("jpm", "jobs/" + jobId));
          if (
            job.id !== jobId ||
            (job.projectId != null && job.projectId !== id)
          )
            throw new ServiceTitanReadError(
              "ST job membership changed during the read. Refresh again.",
            );
          return job;
        }),
      );
      jobs.push(...batch);
    }
    const latest = await this.readProject(id);
    if (
      JSON.stringify([...latest.project.jobIds].sort()) !==
        JSON.stringify([...project.jobIds].sort()) ||
      latest.project.modifiedOn !== project.modifiedOn
    )
      throw new ServiceTitanReadError(
        "ST project changed during the read. Refresh again.",
      );
    return {
      project,
      customer,
      location,
      jobs,
      observedAt: new Date().toISOString(),
    };
  }
  async readEmployees() {
    // Role source is on user-roles, not employees. Join by every assigned role
    // so mixed assignments cannot sneak an Enterprise Hub user into intake.
    const hubRoles = new Set<string>();
    const roleSchema = z.object({
      data: z.array(z.object({ id: sourceId, roleSource: z.string() })),
      hasMore: z.boolean(),
    });
    for (let page = 1; page <= 100; page++) {
      const result = roleSchema.safeParse(
        await this.get(
          "settings",
          "user-roles",
          new URLSearchParams({
            page: String(page),
            pageSize: "200",
            active: "Any",
          }),
        ),
      );
      if (!result.success)
        throw new ServiceTitanReadError("Unable to verify ST role sources.");
      for (const role of result.data.data)
        if (
          role.roleSource.replace(/\s/g, "").toLowerCase() === "enterprisehub"
        )
          hubRoles.add(role.id);
      if (!result.data.hasMore) break;
      if (page === 100)
        throw new ServiceTitanReadError("Role-source pagination incomplete.");
    }
    const people: {
      id: string;
      kind: "employee" | "technician";
      name: string;
      active: boolean;
      email: string | null;
      phone: string | null;
    }[] = [];
    const schema = z.object({
      data: z.array(
        z.object({
          id: sourceId,
          name: z.string().min(1),
          active: z.boolean(),
          email: z.string().nullish(),
          phoneNumber: z.string().nullish(),
          roleIds: z.array(sourceId),
        }),
      ),
      hasMore: z.boolean(),
    });
    for (const kind of ["employee", "technician"] as const) {
      for (let page = 1; page <= 100; page++) {
        const result = schema.safeParse(
          await this.get(
            "settings",
            kind + "s",
            new URLSearchParams({
              active: "True",
              page: String(page),
              pageSize: "200",
            }),
          ),
        );
        if (!result.success)
          throw new ServiceTitanReadError(
            "Unexpected ST employee directory response.",
          );
        people.push(
          ...result.data.data
            .filter(
              (p) => p.active && !p.roleIds.some((id) => hubRoles.has(id)),
            )
            .map((p) => ({
              id: p.id,
              kind,
              name: p.name,
              active: p.active,
              email: p.email ?? null,
              phone: p.phoneNumber ?? null,
            })),
        );
        if (!result.data.hasMore) break;
        if (page === 100)
          throw new ServiceTitanReadError("Employee pagination incomplete.");
      }
    }
    if (new Set(people.map((p) => p.kind + ":" + p.id)).size !== people.length)
      throw new ServiceTitanReadError("Duplicate ST employee records.");
    return people.sort((a, b) => a.name.localeCompare(b.name));
  }
  async readTechnicians(): Promise<
    {
      id: string;
      name: string;
      active: boolean;
      hourlyRate: number | null;
      burdenRate: number | null;
      commissionRate: number | null;
      isManagedTech?: boolean | null;
    }[]
  > {
    const rows: {
      id: string;
      name: string;
      active: boolean;
      hourlyRate: number | null;
      burdenRate: number | null;
      commissionRate: number | null;
      isManagedTech: boolean | null;
    }[] = [];
    const seen = new Set<string>();
    // Any, not True: inactive technicians still name the hours they already worked.
    // Page size 200 is under the settings cap. A full page is not the end of the
    // list when hasMore is false: ServiceTitan's default page is 50, and a full
    // page with hasMore false drops every technician after page 1.
    const pageSize = 200;
    for (let page = 1; page <= 100; page++) {
      const parsed = technicianPageSchema.safeParse(
        await this.get(
          "settings",
          "technicians",
          new URLSearchParams({
            page: String(page),
            pageSize: String(pageSize),
            active: "Any",
          }),
        ),
      );
      if (!parsed.success)
        throw new ServiceTitanReadError(
          "Unexpected technician directory response.",
        );
      const people = parsed.data.data.flatMap((item) => {
        const person = technicianRowSchema.safeParse(item);
        if (!person.success) return [];
        return [
          {
            id: person.data.id,
            name: person.data.name,
            active: person.data.active,
            hourlyRate: person.data.hourlyRate ?? null,
            burdenRate: person.data.burdenRate ?? null,
            commissionRate: person.data.commissionRate ?? null,
            isManagedTech: person.data.isManagedTech ?? null,
          },
        ];
      });
      if (parsed.data.data.length > 0 && people.length === 0)
        throw new ServiceTitanReadError(
          "Unexpected technician directory response.",
        );
      if (people.length > 0 && people.every((person) => seen.has(person.id))) return rows;
      for (const person of people) {
        if (seen.has(person.id))
          throw new ServiceTitanReadError("Duplicate technician IDs.");
        seen.add(person.id);
        rows.push(person);
      }
      const reported = parsed.data.pageSize;
      const cap = reported && reported > 0 ? Math.min(pageSize, reported) : pageSize;
      const fullPage = parsed.data.data.length >= cap;
      if (parsed.data.hasMore !== true && !fullPage) return rows;
    }
    throw new ServiceTitanReadError("Technician pagination incomplete.");
  }

  /**
   * Name for one timesheet id the technician directory did not carry.
   * GET technicians/{id} first (inactive records included), then employees/{id}.
   * A 404 or a failed read returns null. Nothing is written.
   */
  async readStaffName(id: string): Promise<string | null> {
    const wanted = technicianIdKey(id);
    if (!/^\d+$/.test(wanted)) return null;
    for (const resource of [`technicians/${wanted}`, `employees/${wanted}`] as const) {
      let result: { status: number; body: unknown };
      try {
        result = await this.getRaw("settings", resource);
      } catch {
        return null;
      }
      if (result.status === 404) continue;
      if (result.status < 200 || result.status >= 300) continue;
      const name = staffNameFrom(result.body, wanted);
      if (name) return name;
    }
    return null;
  }
  async readJob(jobId: string): Promise<{
    job: ServiceTitanJob;
    appointments: ServiceTitanAppointment[];
    assignments: ServiceTitanAssignment[];
    observedAt: string;
  }> {
    if (!/^\d+$/.test(jobId))
      throw new ServiceTitanReadError("Use a numeric ServiceTitan job ID.");
    const parsed = jobSchema.safeParse(await this.get("jpm", `jobs/${jobId}`));
    if (!parsed.success || parsed.data.id !== jobId)
      throw new ServiceTitanReadError(
        "ServiceTitan returned an unexpected job.",
      );
    const appointments = await this.pages(
      "jpm",
      "appointments",
      appointmentSchema,
      jobId,
    );
    const assignments = await this.pages(
      "dispatch",
      "appointment-assignments",
      assignmentSchema,
      jobId,
    );
    if (
      appointments.some(
        (a) => a.jobId !== jobId || Date.parse(a.end) < Date.parse(a.start),
      ) ||
      assignments.some((a) => a.jobId !== jobId)
    ) {
      throw new ServiceTitanReadError(
        "ServiceTitan returned records outside the requested job or invalid appointment dates.",
      );
    }
    for (const rows of [appointments, assignments])
      if (new Set(rows.map((r) => r.id)).size !== rows.length) {
        throw new ServiceTitanReadError(
          "ServiceTitan returned duplicate records across pages. Retry the complete read.",
        );
      }
    return {
      job: parsed.data,
      appointments,
      assignments,
      observedAt: new Date().toISOString(),
    };
  }

  /**
   * Payroll timesheets for one job. GET only. A 403 is returned as forbidden
   * so the caller can keep the last timesheet rows and use appointment windows.
   * Wage fields on the payload are stripped and never returned.
   */
  async readJobTimesheets(jobId: string): Promise<{
    jobId: string;
    forbidden: boolean;
    timesheets: Array<{
      id: string;
      appointmentId: string | null;
      technicianId: string | null;
      technicianName: string | null;
      arrivedOn: string | null;
      dispatchedOn: string | null;
      doneOn: string | null;
      canceledOn: string | null;
      paidDurationHours: number | null;
    }>;
  }> {
    if (!/^\d+$/.test(jobId))
      throw new ServiceTitanReadError("Use a numeric ServiceTitan job ID.");
    const timesheetSchema = z
      .object({
        id: sourceId,
        appointmentId: sourceId.nullish(),
        technicianId: sourceId.nullish(),
        technicianName: z.string().nullish(),
        arrivedOn: z.string().nullish(),
        dispatchedOn: z.string().nullish(),
        doneOn: z.string().nullish(),
        canceledOn: z.string().nullish(),
        paidDurationHours: z.coerce.number().finite().nullish(),
        paidHours: z.coerce.number().finite().nullish(),
        hours: z.coerce.number().finite().nullish(),
      })
      .strip();
    try {
      const rows: Array<z.infer<typeof timesheetSchema>> = [];
      for (let page = 1; page <= 100; page++) {
        const raw = await this.get(
          "payroll",
          `jobs/${jobId}/timesheets`,
          new URLSearchParams({ page: String(page), pageSize: "200" }),
        );
        const parsed = z
          .object({ data: z.array(timesheetSchema), hasMore: z.boolean() })
          .safeParse(raw);
        if (!parsed.success)
          throw new ServiceTitanReadError("Unexpected timesheet response.");
        rows.push(...parsed.data.data);
        if (!parsed.data.hasMore) break;
      }
      return {
        jobId,
        forbidden: false,
        timesheets: rows.map((row) => ({
          id: row.id,
          appointmentId: row.appointmentId ?? null,
          technicianId: row.technicianId ?? null,
          technicianName: row.technicianName ?? null,
          arrivedOn: row.arrivedOn ?? null,
          dispatchedOn: row.dispatchedOn ?? null,
          doneOn: row.doneOn ?? null,
          canceledOn: row.canceledOn ?? null,
          paidDurationHours: row.paidDurationHours ?? row.paidHours ?? row.hours ?? null,
        })),
      };
    } catch (err) {
      if (err instanceof ServiceTitanReadError && /HTTP 403\b/.test(err.message)) {
        return { jobId, forbidden: true, timesheets: [] };
      }
      throw err;
    }
  }

  /**
   * Paid payroll time from GET payroll/v2/tenant/{tenant}/gross-pay-items
   * (scope Payroll -> Gross Pay Items (Read)). This is where ServiceTitan
   * keeps paidDurationHours. jobs/{job}/timesheets carries only dispatch,
   * arrive, done, and cancel stamps, which are never hours.
   * The endpoint has no job filter, so it is read by date window and the
   * caller keeps the rows whose jobId is on the project. GET only.
   */
  async readGrossPayItems(query: { dateOnOrAfter: string; dateOnOrBefore?: string }): Promise<{
    forbidden: boolean;
    items: GrossPayItem[];
  }> {
    if (Number.isNaN(Date.parse(query.dateOnOrAfter)))
      throw new ServiceTitanReadError("Use an ISO date for the gross pay window.");
    const enumText = z
      .union([z.string(), z.object({ name: z.string().nullish(), type: z.string().nullish(), value: z.string().nullish() }).passthrough()])
      .nullish()
      .transform((value) =>
        value == null ? null : typeof value === "string" ? value : value.name ?? value.type ?? value.value ?? null,
      );
    const itemSchema = z
      .object({
        id: sourceId,
        employeeId: sourceId.nullish(),
        employeeType: enumText,
        date: z.string().nullish(),
        activity: z.string().nullish(),
        activityCode: z.string().nullish(),
        amount: z.coerce.number().finite().nullish(),
        grossPayItemType: enumText,
        paidDurationHours: z.coerce.number().finite().nullish(),
        paidTimeType: enumText,
        jobId: sourceId.nullish(),
        projectId: sourceId.nullish(),
      })
      .strip();
    const items: GrossPayItem[] = [];
    try {
      for (let page = 1; page <= 200; page += 1) {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: "500",
          employeeType: "Technician",
          dateOnOrAfter: query.dateOnOrAfter,
        });
        if (query.dateOnOrBefore) params.set("dateOnOrBefore", query.dateOnOrBefore);
        const raw = await this.get("payroll", "gross-pay-items", params);
        const parsed = z.object({ data: z.array(itemSchema), hasMore: z.boolean() }).safeParse(raw);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new ServiceTitanReadError(
            `Unexpected gross pay items (${issue?.path.join(".") || "page"}: ${issue?.message ?? "invalid"}).`,
          );
        }
        for (const row of parsed.data.data) {
          items.push({
            id: row.id,
            technicianId: row.employeeId ?? null,
            date: row.date ?? null,
            activity: row.activity ?? row.activityCode ?? null,
            amount: row.amount ?? null,
            type: row.grossPayItemType,
            paidDurationHours: row.paidDurationHours ?? null,
            paidTimeType: row.paidTimeType,
            jobId: row.jobId ?? null,
          });
        }
        if (!parsed.data.hasMore) break;
      }
    } catch (err) {
      if (err instanceof ServiceTitanReadError && /HTTP 403\b/.test(err.message)) {
        return { forbidden: true, items: [] };
      }
      throw err;
    }
    return { forbidden: false, items };
  }

  /**
   * Every job whose projectId is this project, in every status, plus the
   * ids on the project object. GET only.
   */
  async readProjectJobs(projectId: string): Promise<
    Array<{ id: string; jobNumber: string; jobStatus: string; createdOn: string | null; completedOn: string | null }>
  > {
    if (!/^\d+$/.test(projectId))
      throw new ServiceTitanReadError("Use a numeric ServiceTitan project ID.");
    const rowSchema = z.object({
      id: sourceId,
      jobNumber: z.string(),
      jobStatus: z.string(),
      projectId: sourceId.nullish(),
      createdOn: z.string().nullish(),
      completedOn: z.string().nullish(),
    });
    const byId = new Map<string, z.infer<typeof rowSchema>>();
    for (const status of ["", ...JOB_LIST_STATUSES]) {
      for (let page = 1; page <= 100; page += 1) {
        const query = new URLSearchParams({
          projectId,
          page: String(page),
          pageSize: "200",
        });
        if (status) query.set("jobStatus", status);
        const raw = await this.get("jpm", "jobs", query);
        const parsed = z.object({
          data: z.array(rowSchema),
          hasMore: z.boolean().optional(),
        }).safeParse(raw);
        if (!parsed.success)
          throw new ServiceTitanReadError("Unexpected ServiceTitan job list.");
        for (const row of parsed.data.data) {
          if (row.projectId != null && row.projectId !== projectId) continue;
          byId.set(row.id, row);
        }
        const full = parsed.data.data.length >= 200;
        if (parsed.data.hasMore !== true && !full) break;
        if (parsed.data.data.length === 0) break;
      }
    }
    const project = await this.readProject(projectId);
    for (const id of project.project.jobIds) {
      if (!byId.has(id)) {
        byId.set(id, { id, jobNumber: id, jobStatus: "Unknown", projectId, createdOn: null, completedOn: null });
      }
    }
    return [...byId.values()].map((row) => ({
      id: row.id,
      jobNumber: row.jobNumber,
      jobStatus: row.jobStatus,
      createdOn: row.createdOn ?? null,
      completedOn: row.completedOn ?? null,
    }));
  }

  /**
   * Invoice lines for one job. GET only.
   * A projectId filter on this list was observed to be ignored, so the read
   * is by job id and a row for a different job is dropped.
   * Billed labor and materials follow generalLedgerAccount.name. Items have
   * no skuType. A list row with no items array is read again by invoice id.
   */
  async readJobInvoiceLines(jobId: string): Promise<
    Array<{
      invoiceId: string;
      lineKey: string;
      sku: string;
      kind: "labor" | "material" | "other";
      quantity: number | null;
      total: number;
      technicianId: string | null;
    }>
  > {
    if (!/^\d+$/.test(jobId))
      throw new ServiceTitanReadError("Use a numeric ServiceTitan job ID.");
    const itemSchema = z.object({
      id: sourceId.optional(),
      skuName: z.string().nullish(),
      code: z.string().nullish(),
      displayName: z.string().nullish(),
      description: z.string().nullish(),
      type: z.string().nullish(),
      quantity: z.coerce.number().nullish(),
      total: z.coerce.number().nullish(),
      technicianId: sourceId.nullish(),
      generalLedgerAccount: z.object({ name: z.string().nullish() }).nullish(),
    }).passthrough();
    const invoiceSchema = z.object({
      id: sourceId,
      job: z.object({ id: sourceId }).nullish(),
      // Estimate-type jobs carry $0 invoices with items: null. null must not fail the page.
      items: z.array(itemSchema).nullish(),
      total: z.coerce.number().nullish(),
    });
    const lines: Array<{
      invoiceId: string;
      lineKey: string;
      sku: string;
      kind: "labor" | "material" | "other";
      quantity: number | null;
      total: number;
      technicianId: string | null;
    }> = [];
    const pushInvoice = (invoice: z.infer<typeof invoiceSchema>) => {
      if (invoice.job?.id != null && invoice.job.id !== jobId) return;
      (invoice.items ?? []).forEach((item, index) => {
        const sku = String(item.skuName || item.code || item.displayName || item.description || "");
        lines.push({
          invoiceId: invoice.id,
          lineKey: item.id ?? String(index),
          sku,
          kind: classifyInvoiceItem({
            type: item.type ?? null,
            accountName: item.generalLedgerAccount?.name ?? null,
          }),
          quantity: item.quantity ?? null,
          total: item.total ?? 0,
          technicianId: item.technicianId ?? null,
        });
      });
    };
    for (let page = 1; page <= 100; page += 1) {
      const raw = await this.get(
        "accounting",
        "invoices",
        new URLSearchParams({ jobId, page: String(page), pageSize: "200" }),
      );
      const parsed = z.object({
        data: z.array(invoiceSchema),
        hasMore: z.boolean().optional(),
      }).safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ServiceTitanReadError(
          `Unexpected ServiceTitan invoice items (${issue?.path.join(".") || "page"}: ${issue?.message ?? "invalid"}).`,
        );
      }
      for (const invoice of parsed.data.data) {
        if (invoice.items != null) {
          pushInvoice(invoice);
          continue;
        }
        // ServiceTitan returns items: null on $0 invoices (Estimate-type jobs).
        // There is no line to store, and invoices/{id} answers 404 for them.
        if (invoice.items === null && Number(invoice.total ?? 0) === 0) continue;
        const detail = await this.get("accounting", `invoices/${invoice.id}`);
        const direct = invoiceSchema.safeParse(detail);
        const wrapped = z.object({ data: invoiceSchema }).safeParse(detail);
        if (direct.success) pushInvoice(direct.data);
        else if (wrapped.success) pushInvoice(wrapped.data.data);
        else throw new ServiceTitanReadError("Unexpected ServiceTitan invoice.");
      }
      if (parsed.data.hasMore !== true && parsed.data.data.length < 200) break;
    }
    return lines;
  }

  /** Purchase orders on one job. GET only. Canceled orders are omitted. */
  async readJobPurchaseOrders(jobId: string): Promise<Array<{ id: string; total: number }>> {
    if (!/^\d+$/.test(jobId))
      throw new ServiceTitanReadError("Use a numeric ServiceTitan job ID.");
    const rowSchema = z.object({
      id: sourceId,
      status: z.string().nullish(),
      total: z.coerce.number().nullish(),
    }).passthrough();
    const orders: Array<{ id: string; total: number }> = [];
    for (let page = 1; page <= 100; page += 1) {
      const raw = await this.get(
        "inventory",
        "purchase-orders",
        new URLSearchParams({ jobId, page: String(page), pageSize: "200" }),
      );
      const parsed = z.object({
        data: z.array(rowSchema),
        hasMore: z.boolean().optional(),
      }).safeParse(raw);
      if (!parsed.success)
        throw new ServiceTitanReadError("Unexpected ServiceTitan purchase orders.");
      for (const row of parsed.data.data) {
        if (/cancel/i.test(row.status ?? "")) continue;
        orders.push({ id: row.id, total: row.total ?? 0 });
      }
      if (parsed.data.hasMore !== true && parsed.data.data.length < 200) break;
    }
    return orders;
  }

  /**
   * Pricebook service MHM.25PLFE. GET only. Inactive rows are returned so the
   * caller can tell a missing service from an inactive one. HTTP errors,
   * including 403, throw. Nothing is written to ServiceTitan.
   */
  async readLaborService(): Promise<{
    services: Array<{
      id: string;
      code: string | null;
      name: string | null;
      active: boolean;
    }>;
  }> {
    const serviceSchema = z
      .object({
        id: sourceId,
        code: z.string().nullish(),
        displayName: z.string().nullish(),
        active: z.boolean(),
      })
      .strip();
    const rows: Array<z.infer<typeof serviceSchema>> = [];
    for (let page = 1; page <= 100; page++) {
      const raw = await this.get(
        "pricebook",
        "services",
        new URLSearchParams({
          code: LABOR_SERVICE_CODE,
          active: "Any",
          page: String(page),
          pageSize: "50",
        }),
      );
      const parsed = z
        .object({ data: z.array(serviceSchema), hasMore: z.boolean() })
        .safeParse(raw);
      if (!parsed.success) {
        throw new ServiceTitanReadError("Unexpected ServiceTitan pricebook services response.");
      }
      rows.push(...parsed.data.data);
      if (!parsed.data.hasMore) {
        if (new Set(rows.map((row) => row.id)).size !== rows.length) {
          throw new ServiceTitanReadError("Duplicate ServiceTitan pricebook service ids.");
        }
        return {
          services: rows.map((row) => ({
            id: row.id,
            code: row.code?.trim() ? row.code.trim() : null,
            name: row.displayName?.trim() ? row.displayName.trim() : null,
            active: row.active,
          })),
        };
      }
    }
    throw new ServiceTitanReadError(
      "ServiceTitan pagination limit reached. No partial snapshot may be imported.",
    );
  }

  /**
   * Accounting and sales reads. GET only. A 403 is returned as forbidden so
   * the caller can keep the last observations. Rows are not filtered here;
   * the caller keeps the ones whose job is linked and active.
   */
  async readInvoices(modifiedSince: string | null): Promise<{
    forbidden: boolean;
    invoices: Array<{
      externalInvoiceId: string;
      invoiceNumber: string;
      externalJobId: string | null;
      total: number;
      balance: number;
      invoicedOn: string | null;
      paidOn: string | null;
    }>;
  }> {
    const schema = z
      .object({
        id: sourceId,
        referenceNumber: z.string().nullish(),
        invoiceNumber: z.string().nullish(),
        total: z.coerce.number().nullish(),
        balance: z.coerce.number().nullish(),
        invoiceDate: z.string().nullish(),
        paidOn: z.string().nullish(),
        jobId: sourceId.nullish(),
        job: z.object({ id: sourceId }).nullish(),
      })
      .strip();
    const page = await this.collect("accounting", "invoices", schema, modifiedSince);
    return {
      forbidden: page.forbidden,
      invoices: page.rows.map((row) => ({
        externalInvoiceId: row.id,
        invoiceNumber: (row.referenceNumber ?? row.invoiceNumber ?? "").trim(),
        externalJobId: row.job?.id ?? row.jobId ?? null,
        total: row.total ?? 0,
        balance: row.balance ?? 0,
        invoicedOn: row.invoiceDate ?? null,
        paidOn: row.paidOn ?? null,
      })),
    };
  }

  async readPayments(modifiedSince: string | null): Promise<{
    forbidden: boolean;
    payments: Array<{
      externalPaymentId: string;
      externalInvoiceId: string;
      amount: number;
      paidOn: string | null;
    }>;
  }> {
    const schema = z
      .object({
        id: sourceId,
        date: z.string().nullish(),
        paidOn: z.string().nullish(),
        appliedTo: z
          .array(
            z
              .object({
                appliedTo: sourceId.nullish(),
                invoiceId: sourceId.nullish(),
                appliedAmount: z.coerce.number().nullish(),
                amount: z.coerce.number().nullish(),
              })
              .strip(),
          )
          .nullish(),
      })
      .strip();
    const page = await this.collect("accounting", "payments", schema, modifiedSince);
    const payments = page.rows.flatMap((row) =>
      (row.appliedTo ?? []).flatMap((applied) => {
        const invoiceId = applied.invoiceId ?? applied.appliedTo;
        if (!invoiceId) return [];
        return [
          {
            externalPaymentId: row.id,
            externalInvoiceId: invoiceId,
            amount: applied.appliedAmount ?? applied.amount ?? 0,
            paidOn: row.paidOn ?? row.date ?? null,
          },
        ];
      }),
    );
    return { forbidden: page.forbidden, payments };
  }

  async readEstimates(modifiedSince: string | null): Promise<{
    forbidden: boolean;
    estimates: Array<{
      externalEstimateId: string;
      name: string | null;
      externalJobId: string | null;
      status: string;
      soldOn: string | null;
      customerAmount: number;
    }>;
  }> {
    const schema = z
      .object({
        id: sourceId,
        name: z.string().nullish(),
        jobId: sourceId.nullish(),
        job: z.object({ id: sourceId }).nullish(),
        status: z.union([z.string(), z.object({ name: z.string() }).strip()]).nullish(),
        soldOn: z.string().nullish(),
        subtotal: z.coerce.number().nullish(),
        total: z.coerce.number().nullish(),
      })
      .strip();
    const page = await this.collect("sales", "estimates", schema, modifiedSince);
    return {
      forbidden: page.forbidden,
      estimates: page.rows.map((row) => ({
        externalEstimateId: row.id,
        name: row.name ?? null,
        externalJobId: row.job?.id ?? row.jobId ?? null,
        status: typeof row.status === "string" ? row.status : row.status?.name ?? "",
        soldOn: row.soldOn ?? null,
        customerAmount: row.subtotal ?? row.total ?? 0,
      })),
    };
  }

  /**
   * Estimates on one project. GET only. Rows for a different project are dropped.
   * When the project filter is ignored or empty, each linked job is read instead.
   * Sold estimates with no items on the list are read again by id.
   */
  async readProjectEstimates(
    projectId: string,
    jobIds: readonly string[] = [],
  ): Promise<EstimateRead[]> {
    if (!/^\d+$/.test(projectId)) {
      throw new ServiceTitanReadError("Use a numeric ServiceTitan project ID.");
    }
    const itemSchema = z
      .object({
        type: z.string().nullish(),
        qty: z.coerce.number().nullish(),
        quantity: z.coerce.number().nullish(),
        total: z.coerce.number().nullish(),
        totalCost: z.coerce.number().nullish(),
        soldHours: z.coerce.number().nullish(),
        sku: z
          .object({
            type: z.string().nullish(),
            soldHours: z.coerce.number().nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough();
    const estimateSchema = z
      .object({
        id: sourceId,
        projectId: sourceId.nullish(),
        jobId: sourceId.nullish(),
        job: z.object({ id: sourceId }).nullish(),
        status: z.union([z.string(), z.object({ name: z.string() }).passthrough()]).nullish(),
        subtotal: z.coerce.number().nullish(),
        tax: z.coerce.number().nullish(),
        total: z.coerce.number().nullish(),
        isChangeOrder: z.boolean().nullish(),
        changeOrder: z.boolean().nullish(),
        items: z.array(itemSchema).nullish(),
      })
      .passthrough();
    type RawEstimate = z.infer<typeof estimateSchema>;
    const pages = async (query: URLSearchParams): Promise<RawEstimate[]> => {
      const rows: RawEstimate[] = [];
      for (let page = 1; page <= 20; page += 1) {
        query.set("page", String(page));
        query.set("pageSize", "50");
        const raw = await this.get("sales", "estimates", query);
        const parsed = z
          .object({ data: z.array(estimateSchema), hasMore: z.boolean().optional() })
          .safeParse(raw);
        if (!parsed.success) {
          throw new ServiceTitanReadError("Unexpected ServiceTitan estimates.");
        }
        rows.push(...parsed.data.data);
        if (parsed.data.hasMore !== true) break;
      }
      return rows;
    };
    const listed = await pages(new URLSearchParams({ projectId }));
    const foreign = listed.some((row) => row.projectId != null && row.projectId !== projectId);
    let rows = foreign ? [] : listed.filter((row) => row.projectId == null || row.projectId === projectId);
    if (foreign || rows.length === 0) {
      rows = foreign ? [] : rows;
      for (const jobId of jobIds) {
        if (!/^\d+$/.test(jobId)) continue;
        const jobRows = await pages(new URLSearchParams({ jobId }));
        rows.push(
          ...jobRows.filter((row) => {
            const job = row.job?.id ?? row.jobId;
            return job == null || job === jobId;
          }),
        );
      }
    }
    const byId = new Map<string, RawEstimate>();
    for (const row of rows) byId.set(row.id, row);
    const detailed: RawEstimate[] = [];
    for (const row of byId.values()) {
      const status = typeof row.status === "string" ? row.status : row.status?.name ?? "";
      if (row.items == null && status.trim().toLowerCase() === "sold") {
        const detail = await this.get("sales", `estimates/${row.id}`);
        const direct = estimateSchema.safeParse(detail);
        const wrapped = z.object({ data: estimateSchema }).safeParse(detail);
        if (direct.success) {
          detailed.push(direct.data);
          continue;
        }
        if (wrapped.success) {
          detailed.push(wrapped.data.data);
          continue;
        }
      }
      detailed.push(row);
    }
    return detailed.map((row) => {
      const status = typeof row.status === "string" ? row.status : row.status?.name ?? "";
      const flag =
        typeof row.isChangeOrder === "boolean"
          ? row.isChangeOrder
          : typeof row.changeOrder === "boolean"
            ? row.changeOrder
            : null;
      const subtotal = row.subtotal ?? null;
      const tax = row.tax ?? null;
      const total =
        subtotal != null && tax != null ? Math.round((subtotal + tax) * 100) / 100 : row.total ?? null;
      return {
        id: row.id,
        status,
        isChangeOrder: flag,
        subtotal,
        tax,
        total,
        items:
          row.items == null
            ? null
            : row.items.map((item) => ({
                skuType: item.sku?.type ?? item.type ?? null,
                qty: item.qty ?? item.quantity ?? null,
                total: item.total ?? null,
                totalCost: item.totalCost ?? null,
                soldHours: item.soldHours ?? item.sku?.soldHours ?? null,
              })),
      };
    });
  }

  /** Invoice totals and balances for one job. GET only. Retainage stays null when the payload omits it. */
  async readJobInvoiceSummaries(jobId: string): Promise<InvoiceHeaderRead[]> {
    if (!/^\d+$/.test(jobId)) {
      throw new ServiceTitanReadError("Use a numeric ServiceTitan job ID.");
    }
    const schema = z
      .object({
        id: sourceId,
        active: z.boolean().nullish(),
        total: z.coerce.number().nullish(),
        balance: z.coerce.number().nullish(),
        job: z.object({ id: sourceId }).nullish(),
        jobId: sourceId.nullish(),
      })
      .passthrough();
    const invoices: InvoiceHeaderRead[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const raw = await this.get(
        "accounting",
        "invoices",
        new URLSearchParams({ jobId, page: String(page), pageSize: "200" }),
      );
      const parsed = z
        .object({ data: z.array(schema), hasMore: z.boolean().optional() })
        .safeParse(raw);
      if (!parsed.success) {
        throw new ServiceTitanReadError("Unexpected ServiceTitan invoice summary.");
      }
      for (const row of parsed.data.data) {
        const job = row.job?.id ?? row.jobId;
        if (job != null && job !== jobId) continue;
        const record = row as Record<string, unknown>;
        let retainage: number | null = null;
        for (const key of ["retainage", "retainageAmount", "retainedAmount", "retainageBalance"]) {
          if (!(key in record) || record[key] == null || record[key] === "") continue;
          const value = Number(record[key]);
          if (Number.isFinite(value)) {
            retainage = value;
            break;
          }
        }
        invoices.push({
          id: row.id,
          total: row.total ?? null,
          balance: row.balance ?? null,
          retainage,
          active: row.active !== false,
        });
      }
      if (parsed.data.hasMore !== true) break;
    }
    return invoices;
  }

  /** Project-level retainage dollars, when ServiceTitan sends them. GET only. A percent is not converted. */
  async readProjectRetainage(projectId: string): Promise<number | null> {
    if (!/^\d+$/.test(projectId)) {
      throw new ServiceTitanReadError("Use a numeric ServiceTitan project ID.");
    }
    const raw = await this.get("jpm", "projects/" + projectId);
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    for (const key of ["retainage", "retainageAmount", "retainageBalance", "retainedAmount"]) {
      if (!(key in record) || record[key] == null || record[key] === "") continue;
      const value = Number(record[key]);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  private async collect<T>(
    family: "accounting" | "sales",
    resource: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    modifiedSince: string | null,
  ): Promise<{ forbidden: boolean; rows: T[] }> {
    try {
      const rows: T[] = [];
      for (let page = 1; page <= 100; page++) {
        const query = new URLSearchParams({ page: String(page), pageSize: "200" });
        if (modifiedSince) query.set("modifiedOnOrAfter", modifiedSince);
        const raw = await this.get(family, resource, query);
        const parsed = z.object({ data: z.array(schema), hasMore: z.boolean() }).safeParse(raw);
        if (!parsed.success) {
          throw new ServiceTitanReadError(`Unexpected ServiceTitan ${resource} response.`);
        }
        rows.push(...parsed.data.data);
        if (!parsed.data.hasMore) return { forbidden: false, rows };
      }
      throw new ServiceTitanReadError(
        "ServiceTitan pagination limit reached. No partial snapshot may be imported.",
      );
    } catch (err) {
      if (err instanceof ServiceTitanReadError && /HTTP 403\b/.test(err.message)) {
        return { forbidden: true, rows: [] };
      }
      throw err;
    }
  }
}
