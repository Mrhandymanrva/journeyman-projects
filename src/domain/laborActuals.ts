import type { GrossPayItem } from "../adapters/serviceTitan.js";
import type { SqlClient } from "../db/database.js";
import { grossPayItemTooOld } from "./grossPay.js";
import {
  BURDEN_NOT_SET_MESSAGE,
  DEFAULT_BILLABLE_RATE,
  MISSING_PAY_MESSAGE,
  PLACEHOLDER_TECHNICIAN_SQL,
  classifyTechnician,
  isPlaceholderTechnician,
  technicianDisplayName,
  technicianIdKey,
  type PayBasis,
  type ResolvedTechPay,
} from "./commissionLabor.js";
import {
  commissionDollars,
  payrollHours,
  roundMoney as roundProjectMoney,
  splitBilledLabor,
  type BurdenSlice,
} from "./projectFinancials.js";
import { newYorkDate } from "./fieldStart.js";
import {
  BURDEN_LINE_LABEL,
  COMMISSION_LINE_LABEL,
  NO_PAYROLL_LABOR_LABEL,
  RECENT_PAYROLL_MISSING_WARNING,
  type HoursPayrollSource,
  type LaborCostSource,
  type LaborEstimate,
} from "./stLabor.js";

/** Read batches match the schedule route. */
export const LABOR_READ_BATCH = 4;

export interface TimesheetRow {
  id: string;
  appointmentId: string | null;
  technicianId: string | null;
  technicianName: string | null;
  arrivedOn: string | null;
  dispatchedOn: string | null;
  doneOn: string | null;
  canceledOn: string | null;
  /** Payroll duration. Dispatch and arrive timestamps are not hours. */
  paidDurationHours?: number | null;
}

export interface AppointmentWindow {
  appointmentId: string;
  technicianId: string;
  technicianName: string | null;
  start: string;
  end: string;
  appointmentActive: boolean;
  appointmentStatus: string;
  assignmentActive: boolean;
}

export interface LaborDraft {
  externalTimesheetId: string | null;
  externalAppointmentId: string | null;
  externalTechnicianId: string | null;
  technicianName: string | null;
  workDate: string;
  hours: number;
  source: "timesheet" | "appointment_window";
}

export interface LaborJobResult {
  jobId: string;
  outcome: "timesheet" | "appointment_window" | "keep";
  drafts: LaborDraft[];
  /** Why stored hours were kept instead of replaced. Reported as a refresh warning. */
  warning?: string;
  /** The payroll read failed, including a 403. The labor stamp must not move. */
  failed?: boolean;
}

export async function readLaborJobs(
  jobIds: string[],
  client: {
    readJobTimesheets(jobId: string): Promise<{ forbidden: boolean; timesheets: TimesheetRow[] }>;
    readJob(jobId: string): Promise<{
      appointments: Array<{
        id: string;
        start: string;
        end: string;
        status: string;
        active: boolean;
      }>;
      assignments: Array<{
        appointmentId: string;
        technicianId: string;
        technicianName: string;
        active: boolean;
      }>;
    }>;
  },
): Promise<LaborJobResult[]> {
  const results: LaborJobResult[] = [];
  for (let offset = 0; offset < jobIds.length; offset += LABOR_READ_BATCH) {
    const batch = jobIds.slice(offset, offset + LABOR_READ_BATCH);
    const reads = await Promise.all(
      batch.map(async (jobId): Promise<LaborJobResult> => {
        let sheet: { forbidden: boolean; timesheets: TimesheetRow[] };
        try {
          sheet = await client.readJobTimesheets(jobId);
        } catch (err) {
          // A failed read never clears hours. The last stored rows stay.
          const message = err instanceof Error ? err.message : String(err);
          return {
            jobId,
            outcome: "keep",
            drafts: [],
            failed: true,
            warning: `Job ${jobId} timesheets: ${message}`,
          };
        }
        if (sheet.forbidden) {
          // A payroll denial is a failed read: keep the last rows, no stamp.
          return {
            jobId,
            outcome: "keep",
            drafts: [],
            failed: true,
            warning: `Job ${jobId} timesheets: ServiceTitan read failed (HTTP 403).`,
          };
        }
        const drafts = draftsFromTimesheets(sheet.timesheets);
        if (drafts.length === 0) {
          // An empty or unpriced answer must not overwrite stored hours with zero.
          return {
            jobId,
            outcome: "keep",
            drafts: [],
            warning:
              sheet.timesheets.length > 0
                ? `Job ${jobId} timesheets: ${sheet.timesheets.length} row(s) without usable hours; stored hours kept`
                : undefined,
          };
        }
        return { jobId, outcome: "timesheet", drafts };
      }),
    );
    results.push(...reads);
  }
  return results;
}

/** Gross pay window when ServiceTitan gives no job creation date. */
export const PAID_LABOR_LOOKBACK_DAYS = 120;

export interface PaidLaborRead {
  results: LaborJobResult[];
  warnings: string[];
  /** False when payroll failed, was denied, or had no paid hours. Stored hours stay. */
  stamp: boolean;
  /**
   * Gross pay rows from a successful read. Null when that read failed or
   * the client has no gross-pay endpoint. ServiceTitan labor burden is
   * computed from these rows, not from an empty draft list.
   */
  grossPay: GrossPayItem[] | null;
  payroll: "gross-pay" | "timesheet" | "failed";
  /** gross-pay when TimesheetTime paid hours were stamped. Null when nothing was stamped. */
  hoursSource: HoursPayrollSource | null;
}

interface GrossPaySource {
  readGrossPayItems(query: { dateOnOrAfter: string; dateOnOrBefore?: string }): Promise<{
    forbidden: boolean;
    items: GrossPayItem[];
  }>;
}

/**
 * Paid hours per technician per job from ServiceTitan gross pay items:
 * TimesheetTime rows with a paid duration whose jobId is on the project.
 * Bonuses, salary, and reimbursements are not hours.
 */
export function draftsFromGrossPay(jobIds: readonly string[], items: readonly GrossPayItem[]): Map<string, LaborDraft[]> {
  const wanted = new Set(jobIds);
  const sums = new Map<string, { jobId: string; tech: string | null; hours: number; date: string | null }>();
  for (const item of items) {
    if (grossPayItemTooOld(item)) continue;
    if (!item.jobId || !wanted.has(item.jobId)) continue;
    if ((item.type ?? "").toLowerCase() !== "timesheettime") continue;
    if ((item.paidTimeType ?? "").toLowerCase() === "paidtimeoff") continue;
    const hours = item.paidDurationHours;
    if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours >= 1000) continue;
    const key = `${item.jobId}:${item.technicianId ?? ""}`;
    const sum = sums.get(key) ?? { jobId: item.jobId, tech: item.technicianId, hours: 0, date: null };
    sum.hours += hours;
    if (item.date && (!sum.date || item.date > sum.date)) sum.date = item.date;
    sums.set(key, sum);
  }
  const byJob = new Map<string, LaborDraft[]>();
  for (const sum of sums.values()) {
    const drafts = byJob.get(sum.jobId) ?? [];
    drafts.push({
      externalTimesheetId: `gpi:${sum.jobId}:${sum.tech ?? "unknown"}`,
      externalAppointmentId: null,
      externalTechnicianId: sum.tech,
      technicianName: null,
      workDate: newYorkDate(sum.date ?? new Date().toISOString()),
      hours: Math.round(sum.hours * 100) / 100,
      source: "timesheet",
    });
    byJob.set(sum.jobId, drafts);
  }
  return byJob;
}

/**
 * ServiceTitan Project Financials labor burden for these jobs.
 * Paid gross-pay hours times each technician's burden rate.
 */
export function burdenSlicesFromGrossPay(
  jobIds: readonly string[],
  items: readonly GrossPayItem[],
  rateByTechnician: ReadonlyMap<string, number | null>,
): BurdenSlice[] {
  const slices: BurdenSlice[] = [];
  for (const drafts of draftsFromGrossPay(jobIds, items).values()) {
    for (const draft of drafts) {
      const id = draft.externalTechnicianId?.trim();
      if (!id || !(draft.hours > 0)) continue;
      slices.push({
        technicianId: id,
        hours: draft.hours,
        burdenRate: rateByTechnician.get(id) ?? null,
      });
    }
  }
  return slices;
}

/**
 * ServiceTitan's own payroll dollars for these jobs: TimesheetTime gross-pay
 * amount, not hours times the burden rate, and not PTO or bonuses.
 */
export function grossPayLaborDollars(jobIds: readonly string[], items: readonly GrossPayItem[]): number {
  const wanted = new Set(jobIds);
  let sum = 0;
  for (const item of items) {
    if (grossPayItemTooOld(item)) continue;
    if (!item.jobId || !wanted.has(item.jobId)) continue;
    if ((item.type ?? "").toLowerCase() !== "timesheettime") continue;
    if ((item.paidTimeType ?? "").toLowerCase() === "paidtimeoff") continue;
    if (typeof item.amount !== "number" || !Number.isFinite(item.amount)) continue;
    sum += item.amount;
  }
  return roundProjectMoney(sum);
}

/**
 * Hours for a refresh. Gross pay items when the client has them (the live
 * adapter does). Otherwise payroll timesheets that carry a paid duration.
 * Any failure, denial, or empty answer keeps stored hours and the stamp.
 */
export async function readPaidLabor(
  jobIds: string[],
  client: Partial<GrossPaySource> & Partial<Parameters<typeof readLaborJobs>[1]>,
  options: { dateOnOrAfter: string },
): Promise<PaidLaborRead> {
  const keepAll = (warning: string): PaidLaborRead => ({
    results: jobIds.map((jobId) => ({ jobId, outcome: "keep", drafts: [], failed: true })),
    warnings: [warning],
    stamp: false,
    grossPay: null,
    payroll: "failed",
    hoursSource: null,
  });
  if (client.readGrossPayItems) {
    let read: { forbidden: boolean; items: GrossPayItem[]; skipped?: number; omitted?: number; capped?: boolean };
    try {
      read = await client.readGrossPayItems({ dateOnOrAfter: options.dateOnOrAfter });
    } catch (err) {
      return keepAll(`Payroll gross pay items: ${err instanceof Error ? err.message : String(err)} Stored hours kept.`);
    }
    if (read.forbidden) {
      return keepAll("Payroll gross pay items: ServiceTitan read failed (HTTP 403). Stored hours kept.");
    }
    const notes: string[] = [];
    if ((read.skipped ?? 0) > 0) {
      notes.push(
        `Payroll gross pay items: skipped ${read.skipped} item(s) missing a job or project, an employee, or hours and amount.`,
      );
    }
    if ((read.omitted ?? 0) > 0) {
      notes.push(`Payroll gross pay items: omitted ${read.omitted} item(s) dated before 2022-08-02.`);
    }
    if (read.capped) {
      notes.push("Payroll gross pay items: stopped after 200 pages. Stored hours kept.");
      return {
        results: jobIds.map((jobId) => ({ jobId, outcome: "keep" as const, drafts: [], failed: true })),
        warnings: notes,
        stamp: false,
        grossPay: null,
        payroll: "failed",
        hoursSource: null,
      };
    }
    const byJob = draftsFromGrossPay(jobIds, read.items);
    if (byJob.size === 0) {
      return {
        results: jobIds.map((jobId) => ({ jobId, outcome: "keep" as const, drafts: [] })),
        warnings: [
          "Payroll gross pay items: no paid timesheet hours for this project's jobs. Stored hours kept.",
          ...notes,
        ],
        // The read succeeded. A thrown or forbidden read leaves grossPay null instead.
        stamp: false,
        grossPay: read.items,
        payroll: "gross-pay",
        hoursSource: null,
      };
    }
    return {
      results: jobIds.map((jobId) => {
        const gross = byJob.get(jobId);
        if (gross) return { jobId, outcome: "timesheet" as const, drafts: gross };
        return { jobId, outcome: "keep" as const, drafts: [] };
      }),
      warnings: notes,
      stamp: true,
      grossPay: read.items,
      payroll: "gross-pay",
      hoursSource: "gross-pay",
    };
  }
  if (!client.readJobTimesheets) {
    return keepAll("Payroll timesheets are not configured. Stored hours kept.");
  }
  const results = await readLaborJobs(jobIds, client as Parameters<typeof readLaborJobs>[1]);
  const warnings = results.flatMap((result) => (result.warning ? [result.warning] : []));
  const anyHours = results.some((result) => result.outcome === "timesheet");
  if (!anyHours && !results.some((result) => result.failed) && jobIds.length > 0) {
    warnings.push("Payroll timesheets: no paid hours for this project's jobs. Stored hours kept.");
  }
  const failed = results.some((result) => result.failed);
  return {
    results,
    warnings,
    stamp: anyHours && !failed,
    grossPay: null,
    payroll: failed || !anyHours ? "failed" : "timesheet",
    hoursSource: null,
  };
}

export function hoursBetween(start: string, end: string): number | null {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const hours = Math.round(((to - from) / 3_600_000) * 100) / 100;
  if (hours <= 0 || hours >= 1000) return null;
  return hours;
}

export function draftsFromTimesheets(rows: TimesheetRow[]): LaborDraft[] {
  const drafts: LaborDraft[] = [];
  for (const row of rows) {
    // Payroll paid duration only. Dispatch and arrive clicks are never hours.
    const hours = payrollHours(row);
    if (hours === null) continue;
    const stamp = row.doneOn || row.arrivedOn || row.dispatchedOn;
    drafts.push({
      externalTimesheetId: row.id,
      externalAppointmentId: row.appointmentId,
      externalTechnicianId: row.technicianId,
      technicianName: row.technicianName,
      workDate: stamp ? newYorkDate(stamp) : newYorkDate(new Date().toISOString()),
      hours,
      source: "timesheet",
    });
  }
  return drafts;
}

export function draftsFromAppointments(windows: AppointmentWindow[]): LaborDraft[] {
  const drafts: LaborDraft[] = [];
  for (const window of windows) {
    if (!window.appointmentActive || !window.assignmentActive) continue;
    if (/cancel/i.test(window.appointmentStatus)) continue;
    const hours = hoursBetween(window.start, window.end);
    if (hours === null) continue;
    drafts.push({
      externalTimesheetId: null,
      externalAppointmentId: window.appointmentId,
      externalTechnicianId: window.technicianId,
      technicianName: window.technicianName,
      workDate: newYorkDate(window.start),
      hours,
      source: "appointment_window",
    });
  }
  return drafts;
}

/**
 * Timesheets replace appointment rows for that job.
 * A payroll 403 keeps existing timesheet rows. Appointment windows are stored
 * only when that job has no timesheet rows, so the two are not added together.
 */
export async function storeJobLabor(
  db: SqlClient,
  input: {
    tenantId: string;
    projectId: string;
    jobId: string;
    jobLinkId: string | null;
    result: LaborJobResult;
    observedAt: Date;
  },
): Promise<void> {
  const { tenantId, projectId, jobId, jobLinkId, result, observedAt } = input;
  if (result.outcome === "keep") return;
  if (result.outcome === "appointment_window") {
    const existing = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM projects.labor_actuals
        WHERE project_id = $1 AND external_job_id = $2 AND source = 'timesheet'`,
      [projectId, jobId],
    );
    if (Number(existing.rows[0]?.n ?? 0) > 0) return;
  }
  await db.query(
    `DELETE FROM projects.labor_actuals
      WHERE project_id = $1 AND external_job_id = $2
        AND source = $3`,
    [
      projectId,
      jobId,
      result.outcome === "timesheet" ? "appointment_window" : "appointment_window",
    ],
  );
  if (result.outcome === "timesheet") {
    await db.query(
      `DELETE FROM projects.labor_actuals
        WHERE project_id = $1 AND external_job_id = $2 AND source = 'timesheet'`,
      [projectId, jobId],
    );
  }
  for (const draft of result.drafts) {
    await db.query(
      `INSERT INTO projects.labor_actuals
         (tenant_id, project_id, job_link_id, external_job_id, external_timesheet_id,
          external_appointment_id, external_technician_id, technician_name,
          work_date, hours, source, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        tenantId,
        projectId,
        jobLinkId,
        jobId,
        draft.externalTimesheetId,
        draft.externalAppointmentId,
        draft.externalTechnicianId,
        draft.technicianName,
        draft.workDate,
        draft.hours,
        draft.source,
        observedAt,
      ],
    );
  }
}

/**
 * Point every stored hour for the tenant at the pricebook labor code.
 * Wage and burden are both computed from these rows, so one stamp codes both.
 * The id is passed in. There is no settings lookup.
 * Callers that could not resolve the code skip this and leave cost_code_id as it is.
 */
export async function stampLaborCodes(
  db: SqlClient,
  tenantId: string,
  costCodeId: string,
): Promise<void> {
  await db.query(
    `UPDATE projects.labor_actuals
        SET cost_code_id = $2
      WHERE tenant_id = $1`,
    [tenantId, costCodeId],
  );
}

export interface TechnicianRate {
  id: string;
  name: string;
  active: boolean;
  hourlyRate: number | null;
  burdenRate: number | null;
  commissionRate?: number | null;
  isManagedTech?: boolean | null;
  /** Set when payroll settings were already resolved. Not a stored column. */
  payBasis?: PayBasis | null;
  commissionFraction?: number | null;
  appliedHourlyRate?: number | null;
  appliedBurdenRate?: number | null;
  burdenUnset?: boolean;
  excluded?: boolean;
}

export interface TechnicianDirectory {
  /** False when this connection cannot read technicians. Stored rates stay. */
  read: boolean;
  forbidden: boolean;
  technicians: TechnicianRate[];
}

export interface RateGap {
  external_technician_id: string;
  technician_name: string;
  messages: string[];
}

export interface PricedTechnician {
  external_technician_id: string | null;
  technician_name: string;
  hours: number;
  coded_hours: number;
  pay_basis: PayBasis | null;
  wage: number | null;
  burden: number | null;
  /** Coded hours only. This is what actual cost and the portfolio totals use. */
  budget_wage: number | null;
  budget_burden: number | null;
  burden_unset: boolean;
  missing: string[];
  notices: string[];
}

export type LaborRefreshSource = "manual" | "scheduled" | "auto-hourly";

export interface PortfolioLabor {
  labor_hours: number;
  labor_wage: number;
  labor_burden: number;
  total: number;
  missing: string[];
  notices: string[];
  technicians: PricedTechnician[];
  uncoded_hours: number;
  /** Who last refreshed this project. Null until a refresh is recorded. */
  source: LaborRefreshSource | null;
  /** Where the stored hours came from. */
  hours_source: "timesheet" | "appointment_window" | "mixed" | null;
  /** When the last refresh finished. Null until a refresh is recorded. */
  observed_at: string | null;
  /** payroll, the 25% estimate, or a recent project with no payroll rows. */
  labor_source: LaborCostSource | null;
  labor_label: string | null;
  labor_warning: string | null;
  commission_label: string | null;
  burden_label: string | null;
  /** Reconciliation billedLabor the 25% commission was taken from. */
  billed_labor: number | null;
  /** Arrived-to-done hours used for the estimate's burden. Not the labor hours above. */
  burden_hours: number | null;
}

/** `alias` is a query alias we wrote, never request input. */
export function portfolioLaborColumns(alias = "p"): string {
  if (!/^[a-z]+$/.test(alias)) throw new Error("Invalid labor alias.");
  return `(SELECT COALESCE(SUM(a.hours), 0) FROM projects.labor_actuals a
            WHERE a.project_id = ${alias}.id) AS labor_hours,
          (SELECT COALESCE(SUM(a.hours) FILTER (WHERE a.cost_code_id IS NULL), 0)
             FROM projects.labor_actuals a WHERE a.project_id = ${alias}.id) AS labor_uncoded_hours,
          (SELECT count(*) FILTER (WHERE a.source = 'timesheet')
             FROM projects.labor_actuals a WHERE a.project_id = ${alias}.id) AS labor_timesheet_rows,
          (SELECT count(*) FILTER (WHERE a.source = 'appointment_window')
             FROM projects.labor_actuals a WHERE a.project_id = ${alias}.id) AS labor_window_rows,
          (SELECT MAX(a.observed_at) FROM projects.labor_actuals a
            WHERE a.project_id = ${alias}.id) AS labor_observed_at,
          (SELECT COALESCE(json_agg(json_build_object(
              'technician_id', g.technician_id,
              'technician_name', g.technician_name,
              'hours', g.hours,
              'coded_hours', g.coded_hours,
              'coded_labor', g.coded_labor,
              'coded_burden', g.coded_burden,
              'pay_basis', g.pay_basis,
              'burden_unset', g.burden_unset
            )), '[]'::json)
             FROM (
               SELECT a.external_technician_id AS technician_id,
                      COALESCE(
                        NULLIF(btrim(MAX(a.technician_name)), ''),
                        NULLIF(btrim(MAX(r.technician_name)), '')
                      ) AS technician_name,
                      SUM(a.hours) AS hours,
                      COALESCE(SUM(a.hours) FILTER (WHERE a.cost_code_id IS NOT NULL), 0) AS coded_hours,
                      SUM(a.labor_amount) FILTER (WHERE a.cost_code_id IS NOT NULL) AS coded_labor,
                      SUM(a.burden_amount) FILTER (WHERE a.cost_code_id IS NOT NULL) AS coded_burden,
                      MAX(a.pay_basis) AS pay_basis,
                      BOOL_OR(a.burden_unset) AS burden_unset
                 FROM projects.labor_actuals a
                 LEFT JOIN projects.technician_labor_rates r
                   ON r.tenant_id = a.tenant_id
                  AND r.external_technician_id = a.external_technician_id
                WHERE a.project_id = ${alias}.id
                GROUP BY a.external_technician_id
             ) g) AS labor_techs,
          ${alias}.labor_refreshed_at AS labor_refreshed_at,
          ${alias}.labor_refresh_source AS labor_refresh_source,
          ${alias}.labor_cost_source AS labor_cost_source,
          ${alias}.labor_estimate AS labor_estimate`;
}

export const PORTFOLIO_LABOR_KEYS = [
  "labor_hours",
  "labor_uncoded_hours",
  "labor_timesheet_rows",
  "labor_window_rows",
  "labor_observed_at",
  "labor_techs",
  "labor_refreshed_at",
  "labor_refresh_source",
  "labor_cost_source",
  "labor_estimate",
] as const;

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function technicianLabel(name: string | null | undefined, id: string | null): string {
  return technicianDisplayName(name, id);
}

/** Timesheet rows whose technician id arrived without a name. */
export function unnamedTechnicianIds(results: readonly LaborJobResult[]): string[] {
  const ids = new Set<string>();
  for (const result of results) {
    for (const draft of result.drafts) {
      const id = draft.externalTechnicianId?.trim();
      if (id && !draft.technicianName?.trim()) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Fill a blank timesheet name from the technician directory first.
 * The directory is read with active=Any, so an inactive technician is included.
 * Ids still missing are left for an employees/{id} lookup.
 */
export async function resolveTechnicianNames(
  ids: readonly string[],
  technicians: readonly { id: string | number; name: string | null }[],
  readStaffName?: (id: string) => Promise<string | null>,
): Promise<Map<string, string>> {
  const known = new Map<string, string>();
  for (const tech of technicians) {
    const key = technicianIdKey(tech.id);
    const name = tech.name?.trim();
    if (key && name) known.set(key, name);
  }
  const names = new Map<string, string>();
  for (const rawId of ids) {
    const id = technicianIdKey(rawId);
    if (!id) continue;
    const fromDirectory = known.get(id);
    if (fromDirectory) {
      names.set(id, fromDirectory);
      continue;
    }
    if (!readStaffName || !/^\d+$/.test(id)) continue;
    try {
      const fetched = (await readStaffName(id))?.trim();
      if (fetched) names.set(id, fetched);
    } catch {
      // A failed name lookup leaves the hour row unlabeled.
    }
  }
  return names;
}

export function applyTechnicianNames(
  results: LaborJobResult[],
  names: ReadonlyMap<string, string>,
): LaborJobResult[] {
  return results.map((result) => ({
    ...result,
    drafts: result.drafts.map((draft) => {
      const id = technicianIdKey(draft.externalTechnicianId);
      if (!id || draft.technicianName?.trim()) return draft;
      const name = names.get(id);
      return name ? { ...draft, technicianName: name } : draft;
    }),
  }));
}

export async function withResolvedTechnicianNames(
  results: LaborJobResult[],
  technicians: readonly { id: string | number; name: string | null }[],
  readStaffName?: (id: string) => Promise<string | null>,
): Promise<LaborJobResult[]> {
  const ids = unnamedTechnicianIds(results);
  if (!ids.length) return results;
  const names = await resolveTechnicianNames(ids, technicians, readStaffName);
  return applyTechnicianNames(results, names);
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asTechs(value: unknown): Array<Record<string, unknown>> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

function payBasisOf(value: unknown): PayBasis | null {
  return value === "commission" || value === "hourly" || value === "missing" ? value : null;
}

export function presentStoredTechnician(
  hours: number,
  codedHours: number,
  laborAmount: number | null,
  burdenAmount: number | null,
  payBasis: PayBasis | null,
  burdenUnset: boolean,
  name: string,
  technicianId: string | null,
): PricedTechnician {
  if (isPlaceholderTechnician(name)) {
    return {
      external_technician_id: technicianId,
      technician_name: name,
      hours,
      coded_hours: codedHours,
      pay_basis: null,
      wage: null,
      burden: null,
      budget_wage: null,
      budget_burden: null,
      burden_unset: false,
      missing: [],
      notices: [],
    };
  }
  const known = payBasis === "commission" || payBasis === "hourly";
  const missing =
    !known && (payBasis === "missing" || (hours > 0 && laborAmount == null))
      ? [`${MISSING_PAY_MESSAGE} for ${name}`]
      : [];
  const notices = burdenUnset ? [`${BURDEN_NOT_SET_MESSAGE} for ${name}`] : [];
  const wage = known ? roundMoney(laborAmount ?? 0) : null;
  const burden = burdenUnset || burdenAmount == null ? null : roundMoney(burdenAmount);
  return {
    external_technician_id: technicianId,
    technician_name: name,
    hours,
    coded_hours: codedHours,
    pay_basis: payBasis,
    wage,
    burden,
    budget_wage: wage,
    budget_burden: burden,
    burden_unset: burdenUnset,
    missing,
    notices,
  };
}

/** Portfolio consumers see project dollars and the missing sentences, not a person's rate. */
export function portfolioFeedLabor(labor: PortfolioLabor): Omit<PortfolioLabor, "technicians"> {
  const { technicians: _technicians, ...rest } = labor;
  return rest;
}

export function presentPortfolioLabor(row: Record<string, unknown>): PortfolioLabor {
  const hours = Number(row.labor_hours ?? 0);
  const uncoded = Number(row.labor_uncoded_hours ?? 0);
  const timesheets = Number(row.labor_timesheet_rows ?? 0);
  const windows = Number(row.labor_window_rows ?? 0);
  let hours_source: PortfolioLabor["hours_source"] = null;
  if (timesheets > 0 && windows > 0) hours_source = "mixed";
  else if (timesheets > 0) hours_source = "timesheet";
  else if (windows > 0) hours_source = "appointment_window";
  const technicians = asTechs(row.labor_techs)
    .map((tech) => {
      const id = tech.technician_id == null ? null : String(tech.technician_id);
      const name = technicianLabel(
        typeof tech.technician_name === "string" ? tech.technician_name : null,
        id,
      );
      return presentStoredTechnician(
        Number(tech.hours ?? 0),
        Number(tech.coded_hours ?? 0),
        finiteOrNull(tech.coded_labor),
        finiteOrNull(tech.coded_burden),
        payBasisOf(tech.pay_basis),
        tech.burden_unset === true,
        name,
        id,
      );
    })
    .filter((tech) => !isPlaceholderTechnician(tech.technician_name))
    .sort((a, b) => a.technician_name.localeCompare(b.technician_name));
  const summedWage = roundMoney(
    technicians.reduce((sum, tech) => sum + (tech.budget_wage ?? 0), 0),
  );
  const summedBurden = roundMoney(
    technicians.reduce((sum, tech) => sum + (tech.budget_burden ?? 0), 0),
  );
  const source = laborCostSourceOf(row.labor_cost_source);
  const estimate = source === "billed_labor_25pct" ? laborEstimateOf(row.labor_estimate) : null;
  const labor_wage = estimate ? estimate.commission : summedWage;
  const labor_burden = estimate ? estimate.burden : summedBurden;
  return {
    labor_hours: hours,
    labor_wage,
    labor_burden,
    total: roundMoney(labor_wage + labor_burden),
    missing: technicians.flatMap((tech) => tech.missing),
    notices: technicians.flatMap((tech) => tech.notices),
    technicians,
    uncoded_hours: uncoded,
    source: refreshStamp(row.labor_refresh_source),
    hours_source,
    observed_at: isoStamp(row.labor_refreshed_at),
    labor_source: source,
    labor_label: estimate?.label ?? null,
    labor_warning: source === "none_recent_payroll_missing" ? RECENT_PAYROLL_MISSING_WARNING : null,
    commission_label: estimate?.commission_label ?? null,
    burden_label: estimate?.burden_label ?? null,
    billed_labor: estimate?.billed_labor ?? null,
    burden_hours: estimate?.burden_hours ?? null,
  };
}

function laborCostSourceOf(value: unknown): LaborCostSource | null {
  if (value === "payroll" || value === "billed_labor_25pct" || value === "none_recent_payroll_missing") return value;
  return null;
}

function laborEstimateOf(value: unknown): LaborEstimate | null {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!record) return null;
  const commission = Number(record.commission);
  const burden = Number(record.burden);
  if (!Number.isFinite(commission) || !Number.isFinite(burden)) return null;
  return {
    commission,
    burden,
    total: Number.isFinite(Number(record.total)) ? Number(record.total) : roundMoney(commission + burden),
    billed_labor: Number(record.billed_labor ?? 0),
    burden_hours: Number(record.burden_hours ?? 0),
    burden_source: "payroll_job_timesheets_arrived_done",
    label: NO_PAYROLL_LABOR_LABEL,
    commission_label: COMMISSION_LINE_LABEL,
    burden_label: BURDEN_LINE_LABEL,
  };
}

function refreshStamp(value: unknown): LaborRefreshSource | null {
  return value === "manual" || value === "scheduled" || value === "auto-hourly" ? value : null;
}

function isoStamp(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

export async function readTechnicianDirectory(client: {
  readTechnicians?: () => Promise<TechnicianRate[]>;
} | null | undefined): Promise<TechnicianDirectory> {
  if (!client?.readTechnicians) return { read: false, forbidden: false, technicians: [] };
  try {
    return { read: true, forbidden: false, technicians: await client.readTechnicians() };
  } catch (err) {
    if (err instanceof Error && /\bHTTP 403\b/.test(err.message)) {
      return { read: true, forbidden: true, technicians: [] };
    }
    throw err;
  }
}

/**
 * Labor refresh names hours even when the technician list cannot be parsed.
 * A failed list is not stored, so the last good directory is left in place.
 * Blank timesheet names still fall through to technicians/{id}.
 */
export async function readTechnicianDirectoryForLabor(
  client: Parameters<typeof readTechnicianDirectory>[0],
): Promise<TechnicianDirectory> {
  try {
    return await readTechnicianDirectory(client);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Technician directory could not be read.";
    console.error(`Technician directory was kept. ${message}`);
    return { read: false, forbidden: false, technicians: [] };
  }
}

const PLACEHOLDER_NAME_SQL = PLACEHOLDER_TECHNICIAN_SQL;

function asResolved(tech: TechnicianRate): ResolvedTechPay {
  if (tech.payBasis === "commission" || tech.payBasis === "hourly" || tech.payBasis === "missing") {
    const classified = classifyTechnician(
      {
        id: tech.id,
        name: tech.name,
        active: tech.active,
        hourlyRate: tech.hourlyRate,
        burdenRate: tech.burdenRate,
        commissionRate: tech.commissionRate ?? null,
        isManagedTech: tech.isManagedTech,
      },
      null,
    );
    if (classified.excluded) return classified;
    return {
      ...classified,
      payBasis: tech.payBasis,
      commissionFraction: tech.commissionFraction ?? classified.commissionFraction,
      appliedHourlyRate: tech.appliedHourlyRate ?? classified.appliedHourlyRate,
      appliedBurdenRate: tech.appliedBurdenRate ?? classified.appliedBurdenRate,
      burdenUnset: tech.burdenUnset ?? classified.burdenUnset,
    };
  }
  return classifyTechnician(
    {
      id: tech.id,
      name: tech.name,
      active: tech.active,
      hourlyRate: tech.hourlyRate,
      burdenRate: tech.burdenRate,
        commissionRate: tech.commissionRate ?? null,
        isManagedTech: tech.isManagedTech,
    },
    null,
  );
}

export async function readBillableRate(db: SqlClient, tenantId: string): Promise<number> {
  const { rows } = await db.query<{ labor_billable_rate: string | null }>(
    `SELECT labor_billable_rate::text AS labor_billable_rate
       FROM projects.tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  const value = Number(rows[0]?.labor_billable_rate);
  return Number.isFinite(value) ? value : DEFAULT_BILLABLE_RATE;
}

async function clearPlaceholderLabor(db: SqlClient, tenantId: string): Promise<void> {
  await db.query(
    `UPDATE projects.labor_actuals
        SET labor_amount = NULL,
            burden_amount = NULL,
            pay_basis = NULL,
            burden_unset = false,
            priced_billable_rate = NULL
      WHERE tenant_id = $1
        AND lower(trim(coalesce(technician_name, ''))) ~ $2`,
    [tenantId, PLACEHOLDER_NAME_SQL],
  );
  await db.query(
    `UPDATE projects.technician_labor_rates
        SET active = false,
            hourly_rate = NULL,
            burden_rate = NULL,
            pay_basis = NULL,
            burden_unset = false
      WHERE tenant_id = $1
        AND lower(trim(coalesce(technician_name, ''))) ~ $2`,
    [tenantId, PLACEHOLDER_NAME_SQL],
  );
}

async function priceTechnicianHours(
  db: SqlClient,
  tenantId: string,
  tech: ResolvedTechPay,
  billableRate: number,
): Promise<void> {
  if (tech.excluded || isPlaceholderTechnician(tech.name)) {
    await db.query(
      `UPDATE projects.labor_actuals
          SET labor_amount = NULL,
              burden_amount = NULL,
              pay_basis = NULL,
              burden_unset = false,
              priced_billable_rate = NULL
        WHERE tenant_id = $1 AND external_technician_id = $2`,
      [tenantId, tech.id],
    );
    return;
  }
  const basis = tech.payBasis ?? "missing";
  await db.query(
    `UPDATE projects.labor_actuals
        SET labor_amount = CASE
              WHEN $3::text = 'hourly' AND $5::numeric > 0
                THEN ROUND(hours * $5::numeric, 2)
              ELSE NULL
            END,
            burden_amount = CASE
              WHEN $6::numeric > 0 THEN ROUND(hours * $6::numeric, 2)
              ELSE NULL
            END,
            burden_unset = $7::boolean,
            pay_basis = $3,
            priced_billable_rate = CASE
              WHEN $3::text = 'commission' THEN $4::numeric
              ELSE NULL
            END
      WHERE tenant_id = $1
        AND external_technician_id = $2
        AND lower(trim(coalesce(technician_name, ''))) !~ $8`,
    [
      tenantId,
      tech.id,
      basis,
      billableRate.toFixed(2),
      (tech.appliedHourlyRate ?? 0).toFixed(4),
      (tech.appliedBurdenRate ?? 0).toFixed(4),
      tech.burdenUnset,
      PLACEHOLDER_NAME_SQL,
    ],
  );
}

async function allocateCommissionLabor(
  db: SqlClient,
  tenantId: string,
  technicians: ResolvedTechPay[],
): Promise<void> {
  const commission = technicians.filter(
    (tech) => tech.payBasis === "commission" && tech.commissionFraction != null && tech.commissionFraction > 0,
  );
  if (!commission.length) return;
  const projects = await db.query<{ project_id: string }>(
    `SELECT DISTINCT project_id::text AS project_id
       FROM projects.labor_actuals
      WHERE tenant_id = $1
        AND pay_basis = 'commission'
        AND external_technician_id = ANY($2::text[])`,
    [tenantId, commission.map((tech) => tech.id)],
  );
  for (const project of projects.rows) {
    const lines = await db.query<{ technician_id: string | null; total: string }>(
      `SELECT technician_id, total::text AS total
         FROM projects.st_invoice_lines
        WHERE tenant_id = $1 AND project_id = $2 AND kind = 'labor'`,
      [tenantId, project.project_id],
    );
    const hourRows = await db.query<{ external_technician_id: string; hours: string }>(
      `SELECT external_technician_id, COALESCE(SUM(hours), 0)::text AS hours
         FROM projects.labor_actuals
        WHERE tenant_id = $1
          AND project_id = $2
          AND pay_basis = 'commission'
          AND external_technician_id = ANY($3::text[])
        GROUP BY external_technician_id`,
      [tenantId, project.project_id, commission.map((tech) => tech.id)],
    );
    const hoursByTech = new Map(hourRows.rows.map((row) => [row.external_technician_id, Number(row.hours)]));
    const shares = splitBilledLabor(
      lines.rows.map((row) => ({
        kind: "labor" as const,
        total: Number(row.total),
        technicianId: row.technician_id,
      })),
      hoursByTech,
    );
    for (const tech of commission) {
      const dollars = commissionDollars(shares.get(tech.id) ?? 0, tech.commissionFraction);
      const techHours = hoursByTech.get(tech.id) ?? 0;
      if (dollars == null || !(techHours > 0)) continue;
      const rows = await db.query<{ id: string; hours: string }>(
        `SELECT id::text AS id, hours::text AS hours
           FROM projects.labor_actuals
          WHERE tenant_id = $1
            AND project_id = $2
            AND external_technician_id = $3
            AND pay_basis = 'commission'
          ORDER BY id`,
        [tenantId, project.project_id, tech.id],
      );
      let assigned = 0;
      for (let index = 0; index < rows.rows.length; index += 1) {
        const row = rows.rows[index]!;
        const last = index === rows.rows.length - 1;
        const amount = last
          ? roundProjectMoney(dollars - assigned)
          : roundProjectMoney(dollars * (Number(row.hours) / techHours));
        assigned = roundProjectMoney(assigned + amount);
        await db.query(`UPDATE projects.labor_actuals SET labor_amount = $2 WHERE id = $1`, [row.id, amount]);
      }
    }
  }
}

/**
 * Remembers who is commission, hourly, or missing, and prices stored hours.
 * Commission dollars are billed labor times the payroll percent. Hourly
 * dollars are payroll hours times the hourly rate. Rates are not stored.
 */
export async function storeTechnicianRates(
  db: SqlClient,
  tenantId: string,
  technicians: TechnicianRate[],
  observedAt: Date,
): Promise<void> {
  const billableRate = await readBillableRate(db, tenantId);
  const ids: string[] = [];
  const resolved: ResolvedTechPay[] = [];
  for (const raw of technicians) {
    const id = technicianIdKey(raw.id);
    if (!id) continue;
    const tech = asResolved({ ...raw, id });
    if (tech.excluded || isPlaceholderTechnician(raw.name)) continue;
    ids.push(tech.id);
    await db.query(
      `INSERT INTO projects.technician_labor_rates
         (tenant_id, external_technician_id, technician_name, active,
          hourly_rate, burden_rate, pay_basis, burden_unset, is_field_tech, observed_at)
       VALUES ($1,$2,$3,$4,NULL,NULL,$5,$6,true,$7)
       ON CONFLICT (tenant_id, external_technician_id) DO UPDATE
         SET technician_name = EXCLUDED.technician_name,
             active = EXCLUDED.active,
             hourly_rate = NULL,
             burden_rate = NULL,
             pay_basis = EXCLUDED.pay_basis,
             burden_unset = EXCLUDED.burden_unset,
             is_field_tech = true,
             observed_at = EXCLUDED.observed_at`,
      [tenantId, tech.id, tech.name, tech.active, tech.payBasis, tech.burdenUnset, observedAt],
    );
    await priceTechnicianHours(db, tenantId, tech, billableRate);
    resolved.push(tech);
  }
  await allocateCommissionLabor(db, tenantId, resolved);
  await db.query(
    `UPDATE projects.technician_labor_rates
        SET active = false, hourly_rate = NULL, burden_rate = NULL, observed_at = $3
      WHERE tenant_id = $1
        AND external_technician_id <> ALL($2::text[])`,
    [tenantId, ids, observedAt],
  );
  await clearPlaceholderLabor(db, tenantId);
}

export async function updateBillableRate(
  db: SqlClient,
  tenantId: string,
  nextRate: number,
): Promise<number> {
  const next = roundMoney(nextRate);
  await db.query(
    `UPDATE projects.tenant_settings SET labor_billable_rate = $2 WHERE tenant_id = $1`,
    [tenantId, next],
  );
  return next;
}

export interface LaborCostSplit {
  costCode: string;
  budgeted: boolean;
  labor: number;
  burden: number;
}

export async function laborCostSplits(db: SqlClient, projectId: string): Promise<LaborCostSplit[]> {
  const { rows } = await db.query<{
    cost_code: string;
    budgeted: boolean;
    labor_amount: string | null;
    burden_amount: string | null;
  }>(
    `SELECT cc.code AS cost_code,
            EXISTS (
              SELECT 1 FROM projects.budget_lines b
               WHERE b.project_id = a.project_id
                 AND b.cost_code_id = a.cost_code_id
                 AND b.cost_type = 'L'
            ) AS budgeted,
            COALESCE(SUM(a.labor_amount), 0)::text AS labor_amount,
            COALESCE(SUM(a.burden_amount), 0)::text AS burden_amount
       FROM projects.labor_actuals a
       JOIN projects.cost_codes cc ON cc.id = a.cost_code_id
      WHERE a.project_id = $1
        AND a.cost_code_id IS NOT NULL
      GROUP BY cc.code, a.project_id, a.cost_code_id`,
    [projectId],
  );
  return rows.map((row) => ({
    costCode: row.cost_code,
    budgeted: row.budgeted,
    labor: Number(row.labor_amount ?? 0),
    burden: Number(row.burden_amount ?? 0),
  }));
}

export function laborLines(labor: number, burden: number): Array<{ description: string; amount: number }> {
  return [
    { description: "Labor", amount: roundMoney(labor) },
    { description: "Labor burden", amount: roundMoney(burden) },
  ];
}

export async function applyTechnicianDirectory(
  db: SqlClient,
  tenantId: string,
  directory: TechnicianDirectory,
  observedAt: Date,
): Promise<void> {
  if (!directory.read) return;
  if (directory.forbidden) {
    await markTechnicianRead(db, tenantId, true);
    return;
  }
  await storeTechnicianRates(db, tenantId, directory.technicians, observedAt);
  await markTechnicianRead(db, tenantId, false);
}

/** Stores hours, technician rates, and the refresh stamp. Call only after the read succeeds. */
export async function saveLaborRefresh(
  db: SqlClient,
  input: {
    tenantId: string;
    projectId: string;
    jobs: Array<{ id: string; external_job_id: string }>;
    results: LaborJobResult[];
    directory: TechnicianDirectory;
    source: LaborRefreshSource;
    observedAt: Date;
    /** False when a timesheet read failed: hours were kept, so the stamp stays put. */
    stamp?: boolean;
  },
): Promise<void> {
  for (const result of input.results) {
    const link = input.jobs.find((job) => job.external_job_id === result.jobId);
    await storeJobLabor(db, {
      tenantId: input.tenantId,
      projectId: input.projectId,
      jobId: result.jobId,
      jobLinkId: link?.id ?? null,
      result,
      observedAt: input.observedAt,
    });
  }
  await applyTechnicianDirectory(db, input.tenantId, input.directory, input.observedAt);
  if (input.stamp === false) return;
  await db.query(
    `UPDATE projects.projects
        SET labor_refreshed_at = $2,
            labor_refresh_source = $3
      WHERE id = $1`,
    [input.projectId, input.observedAt, input.source],
  );
}

/** Records which labor-cost path this refresh took. Null estimate clears a previous 25% figure. */
export async function saveLaborCostSource(
  db: SqlClient,
  input: {
    projectId: string;
    source: LaborCostSource;
    estimate: LaborEstimate | null;
  },
): Promise<void> {
  await db.query(
    `UPDATE projects.projects
        SET labor_cost_source = $2,
            labor_estimate = $3::jsonb
      WHERE id = $1`,
    [input.projectId, input.source, input.estimate ? JSON.stringify(input.estimate) : null],
  );
}

export async function markTechnicianRead(
  db: SqlClient,
  tenantId: string,
  forbidden: boolean,
): Promise<void> {
  await db.query(
    `UPDATE projects.tenant_settings SET labor_rates_forbidden = $2 WHERE tenant_id = $1`,
    [tenantId, forbidden],
  );
}

/** Active field technicians with neither a payroll commission percent nor an hourly rate. */
export async function listActiveRateGaps(db: SqlClient, tenantId: string): Promise<RateGap[]> {
  const { rows } = await db.query<{
    external_technician_id: string;
    technician_name: string | null;
    pay_basis: string | null;
  }>(
    `SELECT external_technician_id, technician_name, pay_basis
       FROM projects.technician_labor_rates
      WHERE tenant_id = $1
        AND active
        AND is_field_tech
        AND pay_basis = 'missing'
        AND lower(trim(coalesce(technician_name, ''))) !~ $2
      ORDER BY technician_name NULLS LAST, external_technician_id`,
    [tenantId, PLACEHOLDER_NAME_SQL],
  );
  const gaps: RateGap[] = [];
  for (const row of rows) {
    const name = technicianLabel(row.technician_name, row.external_technician_id);
    if (isPlaceholderTechnician(name)) continue;
    gaps.push({
      external_technician_id: row.external_technician_id,
      technician_name: name,
      messages: [MISSING_PAY_MESSAGE],
    });
  }
  return gaps;
}

export async function listBurdenNotices(db: SqlClient, tenantId: string): Promise<RateGap[]> {
  const { rows } = await db.query<{
    external_technician_id: string;
    technician_name: string | null;
  }>(
    `SELECT external_technician_id, technician_name
       FROM projects.technician_labor_rates
      WHERE tenant_id = $1
        AND active
        AND is_field_tech
        AND burden_unset
        AND lower(trim(coalesce(technician_name, ''))) !~ $2
      ORDER BY technician_name NULLS LAST, external_technician_id`,
    [tenantId, PLACEHOLDER_NAME_SQL],
  );
  const notices: RateGap[] = [];
  for (const row of rows) {
    const name = technicianLabel(row.technician_name, row.external_technician_id);
    if (isPlaceholderTechnician(name)) continue;
    notices.push({
      external_technician_id: row.external_technician_id,
      technician_name: name,
      messages: [BURDEN_NOT_SET_MESSAGE],
    });
  }
  return notices;
}
