import { z } from "zod";

const sourceId = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()])
  .transform(String);
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
export class ServiceTitanReadError extends Error {}
export class ServiceTitanWriteUncertainError extends ServiceTitanReadError {}

/** A read-only, explicitly configured client. It does not use a process-global
 * token or default tenant: callers must supply the connection for their tenant.
 * Reuses the PO application's host allowlist/authentication pattern, without
 * coupling this module to its singleton state or exposing source payloads. */
export class ServiceTitanReadAdapter {
  private token?: { value: string; expiresAt: number };
  private tokenPending?: Promise<string>;
  private readonly apiHost: string;
  private readonly authHost: string;
  constructor(
    private readonly config: ServiceTitanConfig,
    private readonly fetcher: typeof fetch = fetch,
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
    family: "jpm" | "dispatch" | "settings" | "crm" | "forms",
    resource: string,
    query?: URLSearchParams,
  ) {
    const token = await this.accessToken();
    const path = `/${family}/v2/tenant/${this.config.tenantId}/${resource}`;
    let response: Response;
    try {
      response = await this.fetcher(
        this.apiHost + path + (query ? "?" + query.toString() : ""),
        {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "ST-App-Key": this.config.appKey,
          },
        },
      );
    } catch {
      throw new ServiceTitanReadError(
        "ServiceTitan read could not complete. The previous snapshot should be retained.",
      );
    }
    if (!response.ok) {
      if (response.status === 401) this.token = undefined;
      throw new ServiceTitanReadError(
        `ServiceTitan read failed (HTTP ${response.status}).`,
      );
    }
    return response.json() as Promise<unknown>;
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
    { id: string; name: string; active: boolean }[]
  > {
    const rows: { id: string; name: string; active: boolean }[] = [];
    const schema = z.object({
      data: z.array(
        z.object({
          id: sourceId,
          name: z.string().min(1),
          active: z.boolean(),
        }),
      ),
      hasMore: z.boolean(),
    });
    for (let page = 1; page <= 100; page++) {
      const result = schema.safeParse(
        await this.get(
          "settings",
          "technicians",
          new URLSearchParams({
            page: String(page),
            pageSize: "200",
            active: "Any",
          }),
        ),
      );
      if (!result.success)
        throw new ServiceTitanReadError(
          "Unexpected technician directory response.",
        );
      rows.push(...result.data.data);
      if (!result.data.hasMore) {
        if (new Set(rows.map((r) => r.id)).size !== rows.length)
          throw new ServiceTitanReadError("Duplicate technician IDs.");
        return rows;
      }
    }
    throw new ServiceTitanReadError("Technician pagination incomplete.");
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
}
