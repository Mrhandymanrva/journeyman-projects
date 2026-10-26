import type { SqlClient } from "../db/database.js";
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
import { newYorkDate } from "./fieldStart.js";

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
        const sheet = await client.readJobTimesheets(jobId);
        if (!sheet.forbidden) {
          return { jobId, outcome: "timesheet", drafts: draftsFromTimesheets(sheet.timesheets) };
        }
        try {
          const job = await client.readJob(jobId);
          const windows: AppointmentWindow[] = [];
          for (const assignment of job.assignments) {
            const appointment = job.appointments.find((row) => row.id === assignment.appointmentId);
            if (!appointment) continue;
            windows.push({
              appointmentId: appointment.id,
              technicianId: assignment.technicianId,
              technicianName: assignment.technicianName,
              start: appointment.start,
              end: appointment.end,
              appointmentActive: appointment.active,
              appointmentStatus: appointment.status,
              assignmentActive: assignment.active,
            });
          }
          return { jobId, outcome: "appointment_window", drafts: draftsFromAppointments(windows) };
        } catch {
          return { jobId, outcome: "keep", drafts: [] };
        }
      }),
    );
    results.push(...reads);
  }
  return results;
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
    if (row.canceledOn) continue;
    const end = row.doneOn;
    if (!end) continue;
    const start = row.arrivedOn || row.dispatchedOn;
    if (!start) continue;
    const hours = hoursBetween(start, end);
    if (hours === null) continue;
    drafts.push({
      externalTimesheetId: row.id,
      externalAppointmentId: row.appointmentId,
      externalTechnicianId: row.technicianId,
      technicianName: row.technicianName,
      workDate: newYorkDate(start),
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
 * Point every stored hour for the tenant at the ServiceTitan labor-type mirror.
 * The id is passed in. There is no settings lookup. Callers that could not
 * resolve the code skip this and leave cost_code_id as it is.
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
          ${alias}.labor_refresh_source AS labor_refresh_source`;
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
  const labor_wage = roundMoney(
    technicians.reduce((sum, tech) => sum + (tech.budget_wage ?? 0), 0),
  );
  const labor_burden = roundMoney(
    technicians.reduce((sum, tech) => sum + (tech.budget_burden ?? 0), 0),
  );
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
    return {
      id: tech.id,
      name: technicianLabel(tech.name, tech.id),
      active: tech.active,
      hourlyRate: tech.hourlyRate,
      burdenRate: tech.burdenRate,
      commissionRate: tech.commissionRate ?? null,
      excluded: false,
      payBasis: tech.payBasis,
      commissionFraction: tech.commissionFraction ?? null,
      commissionSource: null,
      appliedHourlyRate: tech.appliedHourlyRate ?? null,
      appliedBurdenRate: tech.appliedBurdenRate ?? null,
      burdenUnset: tech.burdenUnset ?? tech.appliedBurdenRate == null,
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
              WHEN $3::text = 'commission' AND $5::numeric > 0
                THEN ROUND(hours * $4::numeric * $5::numeric, 2)
              WHEN $3::text = 'hourly' AND $6::numeric > 0
                THEN ROUND(hours * $6::numeric, 2)
              ELSE NULL
            END,
            burden_amount = CASE
              WHEN $7::numeric > 0 THEN ROUND(hours * $7::numeric, 2)
              ELSE NULL
            END,
            burden_unset = $8::boolean,
            pay_basis = $3,
            priced_billable_rate = CASE
              WHEN $3::text = 'commission' THEN $4::numeric
              ELSE NULL
            END
      WHERE tenant_id = $1
        AND external_technician_id = $2
        AND lower(trim(coalesce(technician_name, ''))) !~ $9`,
    [
      tenantId,
      tech.id,
      basis,
      billableRate.toFixed(2),
      (tech.commissionFraction ?? 0).toFixed(8),
      (tech.appliedHourlyRate ?? 0).toFixed(4),
      (tech.appliedBurdenRate ?? 0).toFixed(4),
      tech.burdenUnset,
      PLACEHOLDER_NAME_SQL,
    ],
  );
}

/**
 * Remembers who is commission, hourly, or missing, and prices stored hours.
 * Hourly, burden, and commission numbers are query parameters only. The
 * columns that used to keep them are written as null.
 */
export async function storeTechnicianRates(
  db: SqlClient,
  tenantId: string,
  technicians: TechnicianRate[],
  observedAt: Date,
): Promise<void> {
  const billableRate = await readBillableRate(db, tenantId);
  const ids: string[] = [];
  for (const raw of technicians) {
    const id = technicianIdKey(raw.id);
    if (!id) continue;
    const tech = asResolved({ ...raw, id });
    if (tech.excluded || isPlaceholderTechnician(raw.name)) continue;
    ids.push(tech.id);
    await db.query(
      `INSERT INTO projects.technician_labor_rates
         (tenant_id, external_technician_id, technician_name, active,
          hourly_rate, burden_rate, pay_basis, burden_unset, observed_at)
       VALUES ($1,$2,$3,$4,NULL,NULL,$5,$6,$7)
       ON CONFLICT (tenant_id, external_technician_id) DO UPDATE
         SET technician_name = EXCLUDED.technician_name,
             active = EXCLUDED.active,
             hourly_rate = NULL,
             burden_rate = NULL,
             pay_basis = EXCLUDED.pay_basis,
             burden_unset = EXCLUDED.burden_unset,
             observed_at = EXCLUDED.observed_at`,
      [tenantId, tech.id, tech.name, tech.active, tech.payBasis, tech.burdenUnset, observedAt],
    );
    await priceTechnicianHours(db, tenantId, tech, billableRate);
  }
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
  await db.query(
    `UPDATE projects.labor_actuals
        SET labor_amount = ROUND((labor_amount * $2::numeric) / priced_billable_rate, 2),
            priced_billable_rate = $2
      WHERE tenant_id = $1
        AND pay_basis = 'commission'
        AND labor_amount IS NOT NULL
        AND priced_billable_rate IS NOT NULL
        AND priced_billable_rate > 0
        AND priced_billable_rate IS DISTINCT FROM $2::numeric`,
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
  await db.query(
    `UPDATE projects.projects
        SET labor_refreshed_at = $2,
            labor_refresh_source = $3
      WHERE id = $1`,
    [input.projectId, input.observedAt, input.source],
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

export async function listActiveRateGaps(db: SqlClient, tenantId: string): Promise<RateGap[]> {
  const { rows } = await db.query<{
    external_technician_id: string;
    technician_name: string | null;
    pay_basis: string | null;
  }>(
    `SELECT external_technician_id, technician_name, pay_basis
       FROM projects.technician_labor_rates
      WHERE tenant_id = $1 AND active AND pay_basis = 'missing'
      ORDER BY technician_name NULLS LAST, external_technician_id`,
    [tenantId],
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
      WHERE tenant_id = $1 AND active AND burden_unset
      ORDER BY technician_name NULLS LAST, external_technician_id`,
    [tenantId],
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
