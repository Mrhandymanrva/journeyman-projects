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

/** Point stored hours at the project override, otherwise the tenant code. No rate or no code leaves them uncoded. */
export async function stampLaborCodes(
  db: SqlClient,
  tenantId: string,
  projectId?: string,
): Promise<void> {
  await db.query(
    `UPDATE projects.labor_actuals a
        SET cost_code_id = CASE
              WHEN s.labor_burdened_hourly_rate IS NULL THEN NULL
              ELSE COALESCE(p.labor_cost_code_id, s.labor_cost_code_id)
            END
       FROM projects.projects p
       JOIN projects.tenant_settings s ON s.tenant_id = p.tenant_id
      WHERE a.project_id = p.id
        AND a.tenant_id = $1
        AND ($2::uuid IS NULL OR a.project_id = $2)`,
    [tenantId, projectId ?? null],
  );
}

export interface PortfolioLabor {
  hours: number;
  amount: number | null;
  uncoded_hours: number;
  source: "timesheet" | "appointment_window" | "mixed" | null;
  observed_at: string | null;
}

/** `alias` is a query alias we wrote, never request input. */
export function portfolioLaborColumns(alias = "p"): string {
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
          (SELECT s.labor_burdened_hourly_rate FROM projects.tenant_settings s
            WHERE s.tenant_id = ${alias}.tenant_id) AS labor_rate`;
}

export const PORTFOLIO_LABOR_KEYS = [
  "labor_hours",
  "labor_uncoded_hours",
  "labor_timesheet_rows",
  "labor_window_rows",
  "labor_observed_at",
  "labor_rate",
] as const;

export function presentPortfolioLabor(row: Record<string, unknown>): PortfolioLabor {
  const hours = Number(row.labor_hours ?? 0);
  const uncoded = Number(row.labor_uncoded_hours ?? 0);
  const timesheets = Number(row.labor_timesheet_rows ?? 0);
  const windows = Number(row.labor_window_rows ?? 0);
  const rate = row.labor_rate === null || row.labor_rate === undefined ? null : Number(row.labor_rate);
  const observed = row.labor_observed_at;
  let source: PortfolioLabor["source"] = null;
  if (timesheets > 0 && windows > 0) source = "mixed";
  else if (timesheets > 0) source = "timesheet";
  else if (windows > 0) source = "appointment_window";
  const coded = Math.max(0, hours - uncoded);
  return {
    hours,
    uncoded_hours: uncoded,
    amount: rate === null ? null : Math.round(coded * rate * 100) / 100,
    source,
    observed_at: observed instanceof Date ? observed.toISOString() : typeof observed === "string" ? observed : null,
  };
}
