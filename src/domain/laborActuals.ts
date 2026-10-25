import type { SqlClient } from "../db/database.js";
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

/** Point stored hours at the project override, otherwise the tenant code. No code leaves them uncoded. */
export async function stampLaborCodes(
  db: SqlClient,
  tenantId: string,
  projectId?: string,
): Promise<void> {
  await db.query(
    `UPDATE projects.labor_actuals a
        SET cost_code_id = COALESCE(p.labor_cost_code_id, s.labor_cost_code_id)
       FROM projects.projects p
       JOIN projects.tenant_settings s ON s.tenant_id = p.tenant_id
      WHERE a.project_id = p.id
        AND a.tenant_id = $1
        AND ($2::uuid IS NULL OR a.project_id = $2)`,
    [tenantId, projectId ?? null],
  );
}

export interface TechnicianRate {
  id: string;
  name: string;
  active: boolean;
  hourlyRate: number | null;
  burdenRate: number | null;
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
  hourly_rate: number | null;
  burden_rate: number | null;
  messages: string[];
}

export interface PricedTechnician {
  external_technician_id: string | null;
  technician_name: string;
  hours: number;
  coded_hours: number;
  hourly_rate: number | null;
  burden_rate: number | null;
  wage: number | null;
  burden: number | null;
  /** Coded hours only. This is what actual cost and the portfolio totals use. */
  budget_wage: number | null;
  budget_burden: number | null;
  missing: string[];
}

export interface PortfolioLabor {
  labor_hours: number;
  labor_wage: number;
  labor_burden: number;
  total: number;
  missing: string[];
  technicians: PricedTechnician[];
  uncoded_hours: number;
  source: "timesheet" | "appointment_window" | "mixed" | null;
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
              'hourly_rate', g.hourly_rate,
              'burden_rate', g.burden_rate
            )), '[]'::json)
             FROM (
               SELECT a.external_technician_id AS technician_id,
                      MAX(a.technician_name) AS technician_name,
                      SUM(a.hours) AS hours,
                      COALESCE(SUM(a.hours) FILTER (WHERE a.cost_code_id IS NOT NULL), 0) AS coded_hours,
                      MAX(r.hourly_rate) AS hourly_rate,
                      MAX(r.burden_rate) AS burden_rate
                 FROM projects.labor_actuals a
                 LEFT JOIN projects.technician_labor_rates r
                   ON r.tenant_id = a.tenant_id
                  AND r.external_technician_id = a.external_technician_id
                WHERE a.project_id = ${alias}.id
                GROUP BY a.external_technician_id
             ) g) AS labor_techs`;
}

export const PORTFOLIO_LABOR_KEYS = [
  "labor_hours",
  "labor_uncoded_hours",
  "labor_timesheet_rows",
  "labor_window_rows",
  "labor_observed_at",
  "labor_techs",
] as const;

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function technicianLabel(name: string | null | undefined, id: string | null): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  return id ? `Technician ${id}` : "Technician";
}

/** A usable rate is a positive number. Null is missing. Zero is called out as zero. */
export function rateGap(
  kind: "hourly rate" | "burden rate",
  name: string,
  value: number | null,
): string | null {
  if (value === null || !Number.isFinite(value)) {
    return `Missing from ServiceTitan: ${kind} for ${name}`;
  }
  if (value === 0) return `Missing from ServiceTitan: ${kind} is 0 for ${name}`;
  if (value < 0) return `Missing from ServiceTitan: ${kind} for ${name}`;
  return null;
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

export function priceTechnician(
  hours: number,
  codedHours: number,
  hourly: number | null,
  burden: number | null,
  name: string,
  technicianId: string | null,
): PricedTechnician {
  const missing = [
    rateGap("hourly rate", name, hourly),
    rateGap("burden rate", name, burden),
  ].filter((line): line is string => line !== null);
  const priced = missing.length === 0 && hourly !== null && burden !== null;
  return {
    external_technician_id: technicianId,
    technician_name: name,
    hours,
    coded_hours: codedHours,
    hourly_rate: hourly,
    burden_rate: burden,
    wage: priced ? roundMoney(hours * hourly) : null,
    burden: priced ? roundMoney(hours * burden) : null,
    budget_wage: priced ? roundMoney(codedHours * hourly) : null,
    budget_burden: priced ? roundMoney(codedHours * burden) : null,
    missing,
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
  const observed = row.labor_observed_at;
  let source: PortfolioLabor["source"] = null;
  if (timesheets > 0 && windows > 0) source = "mixed";
  else if (timesheets > 0) source = "timesheet";
  else if (windows > 0) source = "appointment_window";
  const technicians = asTechs(row.labor_techs)
    .map((tech) => {
      const id = tech.technician_id == null ? null : String(tech.technician_id);
      const name = technicianLabel(
        typeof tech.technician_name === "string" ? tech.technician_name : null,
        id,
      );
      return priceTechnician(
        Number(tech.hours ?? 0),
        Number(tech.coded_hours ?? 0),
        finiteOrNull(tech.hourly_rate),
        finiteOrNull(tech.burden_rate),
        name,
        id,
      );
    })
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
    technicians,
    uncoded_hours: uncoded,
    source,
    observed_at: observed instanceof Date ? observed.toISOString() : typeof observed === "string" ? observed : null,
  };
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

export async function storeTechnicianRates(
  db: SqlClient,
  tenantId: string,
  technicians: TechnicianRate[],
  observedAt: Date,
): Promise<void> {
  const ids: string[] = [];
  for (const tech of technicians) {
    ids.push(tech.id);
    await db.query(
      `INSERT INTO projects.technician_labor_rates
         (tenant_id, external_technician_id, technician_name, active,
          hourly_rate, burden_rate, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, external_technician_id) DO UPDATE
         SET technician_name = EXCLUDED.technician_name,
             active = EXCLUDED.active,
             hourly_rate = EXCLUDED.hourly_rate,
             burden_rate = EXCLUDED.burden_rate,
             observed_at = EXCLUDED.observed_at`,
      [
        tenantId,
        tech.id,
        tech.name,
        tech.active,
        tech.hourlyRate,
        tech.burdenRate,
        observedAt,
      ],
    );
  }
  await db.query(
    `UPDATE projects.technician_labor_rates
        SET active = false, observed_at = $3
      WHERE tenant_id = $1
        AND external_technician_id <> ALL($2::text[])`,
    [tenantId, ids, observedAt],
  );
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
    hourly_rate: string | null;
    burden_rate: string | null;
  }>(
    `SELECT external_technician_id, technician_name, hourly_rate::text, burden_rate::text
       FROM projects.technician_labor_rates
      WHERE tenant_id = $1 AND active
      ORDER BY technician_name NULLS LAST, external_technician_id`,
    [tenantId],
  );
  const gaps: RateGap[] = [];
  for (const row of rows) {
    const hourly = finiteOrNull(row.hourly_rate);
    const burden = finiteOrNull(row.burden_rate);
    const name = technicianLabel(row.technician_name, row.external_technician_id);
    const messages = [
      rateGap("hourly rate", name, hourly),
      rateGap("burden rate", name, burden),
    ].filter((line): line is string => line !== null);
    if (!messages.length) continue;
    gaps.push({
      external_technician_id: row.external_technician_id,
      technician_name: name,
      hourly_rate: hourly,
      burden_rate: burden,
      messages,
    });
  }
  return gaps;
}
