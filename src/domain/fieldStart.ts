import type { SqlClient } from "../db/database.js";
import { isoTimestamp } from "./fieldRelease.js";
import { preconOverdueSql } from "./preconTasks.js";

/** Same calendar the schedule board uses for appointment days. */
export const FIELD_START_ZONE = "America/New_York";

const READ_BATCH = 4;

export interface FieldStartView {
  date: string | null;
  source: "servicetitan" | "manual" | null;
  observed_at: string | null;
}

export interface FieldStartPick {
  date: string;
  appointmentId: string;
  observedAt: string;
}

export interface FieldStartJobRead {
  job: {
    id: string;
    jobStatus: string;
    projectId?: string | null;
  };
  appointments: Array<{
    id: string;
    start: string;
    end: string;
    status: string;
    active: boolean;
  }>;
  observedAt: string;
}

export function newYorkDate(instant: string): string {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid appointment window.");
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_START_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

function calendarDay(value: unknown): string | null {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  return null;
}

export function presentFieldStart(row: {
  field_start?: unknown;
  field_start_source?: unknown;
  field_start_observed_at?: unknown;
}): FieldStartView {
  const source =
    row.field_start_source === "servicetitan" ||
    row.field_start_source === "manual"
      ? row.field_start_source
      : null;
  if (!source) return { date: null, source: null, observed_at: null };
  return {
    date: calendarDay(row.field_start),
    source,
    observed_at: isoTimestamp(row.field_start_observed_at),
  };
}

/**
 * Columns a list or portfolio query needs. Counts stay on the row so a feed
 * read does not call ServiceTitan and does not load task bodies.
 * `alias` is a query alias we wrote, never request input.
 */
export function fieldStartColumns(alias = "p"): string {
  return `${alias}.field_start::text AS field_start,
          ${alias}.field_start_source,
          ${alias}.field_start_observed_at,
          (SELECT count(*) FROM projects.precon_tasks pt
            WHERE pt.project_id = ${alias}.id
              AND pt.status IN ('not_started','in_progress'))::text AS precon_open,
          (SELECT count(*) FROM projects.precon_tasks pt
            WHERE pt.project_id = ${alias}.id
              AND ${preconOverdueSql("pt")})::text AS precon_overdue`;
}

export function preconCountsFromRow(
  row: Record<string, unknown>,
): { open: number; overdue: number } | null {
  if (!Object.hasOwn(row, "precon_open") && !Object.hasOwn(row, "precon_overdue")) {
    return null;
  }
  return {
    open: Number(row.precon_open ?? 0),
    overdue: Number(row.precon_overdue ?? 0),
  };
}

function appointmentOrder(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const diff = BigInt(a) - BigInt(b);
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Earliest America/New_York day among active, non-cancelled appointments on
 * non-cancelled jobs. Ties break on appointment id. Cancelled jobs and
 * inactive or cancelled appointments are skipped. An appointment whose end
 * is not after its start is a bad read, not a candidate.
 * Local schedule rows are not an input.
 */
export async function pickFieldStart(
  jobIds: readonly string[],
  readJob: (jobId: string) => Promise<FieldStartJobRead>,
  externalProjectId: string | null,
): Promise<FieldStartPick | null> {
  let best: FieldStartPick | null = null;
  for (let offset = 0; offset < jobIds.length; offset += READ_BATCH) {
    const jobs = await Promise.all(
      jobIds.slice(offset, offset + READ_BATCH).map((id) => readJob(id)),
    );
    for (const result of jobs) {
      if (!result?.job || !Array.isArray(result.appointments)) {
        throw new Error("ST job read returned no job.");
      }
      if (
        externalProjectId &&
        result.job.projectId != null &&
        result.job.projectId !== externalProjectId
      ) {
        throw new Error("ST job membership changed.");
      }
      if (/cancel/i.test(result.job.jobStatus)) continue;
      for (const appointment of result.appointments) {
        if (!appointment.active || /cancel/i.test(appointment.status)) continue;
        if (Date.parse(appointment.end) <= Date.parse(appointment.start)) {
          throw new Error("Invalid appointment window.");
        }
        const date = newYorkDate(appointment.start);
        if (!result.observedAt) {
          throw new Error("ST job read returned no observation time.");
        }
        if (
          !best ||
          date < best.date ||
          (date === best.date &&
            appointmentOrder(appointment.id, best.appointmentId) < 0)
        ) {
          best = {
            date,
            appointmentId: appointment.id,
            observedAt: result.observedAt,
          };
        }
      }
    }
  }
  return best;
}

/**
 * Writes a ServiceTitan result, or clears one. A manual row is left alone,
 * including when the read found nothing.
 */
export async function storeComputedFieldStart(
  db: SqlClient,
  projectId: string,
  picked: FieldStartPick | null,
): Promise<void> {
  await db.query(
    `UPDATE projects.projects
        SET field_start = $2,
            field_start_source = CASE WHEN $2::date IS NULL THEN NULL ELSE 'servicetitan' END,
            field_start_appointment_id = $3,
            field_start_observed_at = $4,
            field_start_set_by = NULL
      WHERE id = $1
        AND field_start_source IS DISTINCT FROM 'manual'`,
    [
      projectId,
      picked?.date ?? null,
      picked?.appointmentId ?? null,
      picked?.observedAt ?? null,
    ],
  );
}
