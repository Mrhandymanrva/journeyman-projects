import type { Database, SqlClient } from "../db/database.js";
import { isBeforeSourceFloor } from "./sourceFloor.js";
import { replacePlanAppointments, type StoredAppointment } from "./projectSync.js";

/**
 * One ServiceTitan job read, already parsed by the shared appointment validator.
 * `skippedAppointments` counts records that failed that check and were not returned.
 */
export interface PlanJobRead {
  job: {
    id: string;
    jobNumber: string;
    jobStatus: string;
  };
  appointments: Array<{
    id: string;
    appointmentNumber?: string | null;
    start: string;
    end: string;
    status: string;
    active: boolean;
  }>;
  assignments?: Array<{
    appointmentId: string;
    technicianId: string;
    technicianName: string;
    active: boolean;
  }>;
  skippedAppointments?: number;
}

export interface FailedPlanJob {
  jobId: string;
  message: string;
}

/** Appointments collected from ServiceTitan. Nothing is written yet. */
export interface CollectedPlanAppointments {
  appointments: StoredAppointment[];
  skipped: number;
  failedJobs: FailedPlanJob[];
  warnings: string[];
}

export interface PlanAppointmentRefresh {
  stored: number;
  skipped: number;
  failedJobs: FailedPlanJob[];
  warnings: string[];
  /** When this read succeeded. Null when every job failed, so the previous stamp stays. */
  readAt: string | null;
  error: string | null;
}

const READ_BATCH = 4;

export function appointmentSkipWarning(skipped: number): string | null {
  if (!(skipped > 0)) return null;
  const records = skipped === 1 ? "record" : "records";
  return `${skipped} ST appointment ${records} skipped because they failed the format check.`;
}

export function formatPlanReadAt(iso: string | null): string {
  if (!iso) return "not yet";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "not yet";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/**
 * Status line for the plan. A linked project with nothing in the visible
 * window is not the same as a project that has no ServiceTitan link.
 */
export function planAppointmentMessage(input: {
  configured: boolean;
  linkedProjects: number;
  inRange: number;
  readAt: string | null;
  skipped: number;
  failedJobs: readonly FailedPlanJob[];
  readError: string | null;
}): string {
  if (!input.configured) return "ServiceTitan is not configured for this account.";
  if (!input.linkedProjects) {
    return "Connect this project to ServiceTitan to include technician jobs.";
  }
  const head =
    input.inRange === 0
      ? `Linked · 0 ST appointments in this range · last read ${formatPlanReadAt(input.readAt)}`
      : `Linked · ${input.inRange} ST appointments in this range · last read ${formatPlanReadAt(input.readAt)} · America/New_York`;
  const extra = [
    appointmentSkipWarning(input.skipped),
    ...input.failedJobs.map((job) => `Job ${job.jobId} appointments: ${job.message}`),
    input.failedJobs.length === 0 ? input.readError : null,
  ].filter((line): line is string => !!line && line.trim() !== "");
  return extra.length ? `${head}. ${extra.join(" ")}` : head;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function mapPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * GET appointments for the given jobs. A job that throws is recorded and
 * does not drop the other jobs. Records before the source floor are omitted;
 * a current appointment is kept.
 */
export function storedAppointmentsFromJobRead(
  read: PlanJobRead,
  fallbackJobId: string,
): StoredAppointment[] {
  const appointments: StoredAppointment[] = [];
  for (const appointment of read.appointments ?? []) {
    if (!appointment?.id || !appointment.start || !appointment.end) continue;
    if (isBeforeSourceFloor(appointment.start)) continue;
    appointments.push({
      externalJobId: read.job?.id || fallbackJobId,
      externalAppointmentId: appointment.id,
      jobNumber: read.job?.jobNumber || read.job?.id || fallbackJobId,
      appointmentNumber: appointment.appointmentNumber?.trim() || appointment.id,
      jobStatus: read.job?.jobStatus || "Scheduled",
      startsAt: appointment.start,
      endsAt: appointment.end,
      status: appointment.status || "Scheduled",
      active: appointment.active !== false,
      technicians: (read.assignments ?? [])
        .filter((assignment) => assignment.appointmentId === appointment.id && assignment.active)
        .map((assignment) => ({ id: assignment.technicianId, name: assignment.technicianName })),
    });
  }
  return appointments;
}

export function collectedFromReads(
  jobs: readonly { external_job_id: string }[],
  reads: ReadonlyMap<string, PlanJobRead>,
  failedJobs: readonly FailedPlanJob[],
): CollectedPlanAppointments {
  const appointments: StoredAppointment[] = [];
  let skipped = 0;
  for (const job of jobs) {
    const read = reads.get(job.external_job_id);
    if (!read) continue;
    skipped += read.skippedAppointments ?? 0;
    appointments.push(...storedAppointmentsFromJobRead(read, job.external_job_id));
  }
  const warnings = failedJobs.map((job) => `Job ${job.jobId} appointments: ${job.message}`);
  const skipWarning = appointmentSkipWarning(skipped);
  if (skipWarning) warnings.push(skipWarning);
  return { appointments, skipped, failedJobs: [...failedJobs], warnings };
}

export async function collectPlanAppointments(
  readJob: (jobId: string) => Promise<PlanJobRead>,
  jobs: readonly { external_job_id: string }[],
): Promise<CollectedPlanAppointments> {
  const reads = new Map<string, PlanJobRead>();
  const failedJobs: FailedPlanJob[] = [];
  await mapPool(jobs, READ_BATCH, async (job) => {
    try {
      reads.set(job.external_job_id, await readJob(job.external_job_id));
    } catch (err) {
      failedJobs.push({ jobId: job.external_job_id, message: errorText(err) });
    }
  });
  return collectedFromReads(jobs, reads, failedJobs);
}

type AppointmentDb = Database | SqlClient;

function isDatabase(db: AppointmentDb): db is Database {
  return typeof (db as Database).withTenant === "function";
}

async function useClient<T>(
  db: AppointmentDb,
  tenantId: string,
  fn: (client: SqlClient) => Promise<T>,
): Promise<T> {
  if (isDatabase(db)) return db.withTenant(tenantId, fn);
  return fn(db);
}

/**
 * The only writer of projects.st_plan_appointments.
 * Plan refresh, the Financials refresh, the ServiceTitan project refresh,
 * adding a project, and the overnight run all call this.
 * A job whose read failed keeps its own rows. The other jobs are replaced.
 * Passing `collected` skips the ServiceTitan read and only writes.
 */
export async function refreshProjectPlanAppointments(
  db: AppointmentDb,
  input: {
    tenantId: string;
    projectId: string;
    jobs: readonly { external_job_id: string }[];
    readJob?: (jobId: string) => Promise<PlanJobRead>;
    collected?: CollectedPlanAppointments;
    observedAt?: Date;
  },
): Promise<PlanAppointmentRefresh> {
  const observedAt = input.observedAt ?? new Date();
  let collected = input.collected;
  if (!collected) {
    if (!input.readJob) throw new Error("ServiceTitan job read is not configured.");
    collected = await collectPlanAppointments(input.readJob, input.jobs);
  }
  const everyJobFailed = input.jobs.length > 0 && collected.failedJobs.length === input.jobs.length;
  const readAt = everyJobFailed ? null : observedAt.toISOString();
  const error =
    collected.failedJobs.length > 0
      ? collected.failedJobs.map((job) => `Job ${job.jobId} appointments: ${job.message}`).join("; ")
      : null;
  await useClient(db, input.tenantId, async (client) => {
    await replacePlanAppointments(client, {
      tenantId: input.tenantId,
      projectId: input.projectId,
      appointments: collected.appointments,
      observedAt,
      keepJobIds: collected.failedJobs.map((job) => job.jobId),
    });
    await client.query(
      `INSERT INTO projects.st_plan_appointment_reads
         (tenant_id, project_id, read_at, skipped, failed_jobs, error)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (tenant_id, project_id) DO UPDATE
         SET read_at = COALESCE(EXCLUDED.read_at, st_plan_appointment_reads.read_at),
             skipped = EXCLUDED.skipped,
             failed_jobs = EXCLUDED.failed_jobs,
             error = EXCLUDED.error`,
      [
        input.tenantId,
        input.projectId,
        readAt,
        collected.skipped,
        JSON.stringify(collected.failedJobs),
        error,
      ],
    );
  });
  return {
    stored: collected.appointments.length,
    skipped: collected.skipped,
    failedJobs: collected.failedJobs,
    warnings: collected.warnings,
    readAt,
    error,
  };
}

export interface StoredPlanLinkStatus {
  configured: boolean;
  linkedProjects: number;
  readAt: string | null;
  skipped: number;
  failedJobs: FailedPlanJob[];
  readError: string | null;
}

/** Link from st_project_connections or an active ServiceTitan job link. Not from rows in the date window. */
export async function readPlanLinkStatus(
  db: SqlClient,
  projectId: string | null,
  businessUnitId: string | null,
): Promise<StoredPlanLinkStatus> {
  const configured = await db.query<{ id: string }>(
    `SELECT id FROM projects.external_systems
      WHERE active AND adapter_key = 'servicetitan'
      LIMIT 1`,
  );
  const linked = await db.query<{ id: string }>(
    `SELECT p.id::text AS id
       FROM projects.projects p
      WHERE ($1::uuid IS NULL OR p.id = $1)
        AND ($2::uuid IS NULL OR p.business_unit_id = $2)
        AND (
          EXISTS (
            SELECT 1 FROM projects.st_project_connections s
             WHERE s.project_id = p.id
          )
          OR EXISTS (
            SELECT 1 FROM projects.project_job_links j
             WHERE j.project_id = p.id
               AND j.source_active
          )
        )`,
    [projectId, businessUnitId],
  );
  const ids = linked.rows.map((row) => row.id);
  if (!ids.length) {
    return {
      configured: configured.rows.length > 0,
      linkedProjects: 0,
      readAt: null,
      skipped: 0,
      failedJobs: [],
      readError: null,
    };
  }
  const reads = await db.query<{
    read_at: Date | null;
    skipped: number;
    failed_jobs: FailedPlanJob[] | string;
    error: string | null;
  }>(
    `SELECT read_at, skipped, failed_jobs, error
       FROM projects.st_plan_appointment_reads
      WHERE project_id = ANY($1::uuid[])`,
    [ids],
  );
  const storedAt = await db.query<{ observed_at: Date | null }>(
    `SELECT max(observed_at) AS observed_at
       FROM projects.st_plan_appointments
      WHERE project_id = ANY($1::uuid[])`,
    [ids],
  );
  let readAtMs: number | null = null;
  let skipped = 0;
  const failedJobs: FailedPlanJob[] = [];
  const errors: string[] = [];
  for (const row of reads.rows) {
    skipped += Number(row.skipped) || 0;
    if (row.read_at) {
      const ms = row.read_at.getTime();
      if (readAtMs == null || ms > readAtMs) readAtMs = ms;
    }
    const parsedJobs = typeof row.failed_jobs === "string" ? JSON.parse(row.failed_jobs) : row.failed_jobs;
    const jobs = Array.isArray(parsedJobs) ? parsedJobs : [];
    for (const job of jobs) {
      if (job && typeof job.jobId === "string") failedJobs.push({ jobId: job.jobId, message: String(job.message ?? "") });
    }
    if (row.error) errors.push(row.error);
  }
  const observed = storedAt.rows[0]?.observed_at;
  if (observed) {
    const ms = observed.getTime();
    if (readAtMs == null || ms > readAtMs) readAtMs = ms;
  }
  return {
    configured: configured.rows.length > 0 || ids.length > 0,
    linkedProjects: ids.length,
    readAt: readAtMs == null ? null : new Date(readAtMs).toISOString(),
    skipped,
    failedJobs,
    readError: errors.length ? errors.join("; ") : null,
  };
}

const recentRefresh = new Map<string, number>();
const inFlightRefresh = new Set<string>();

export function planRefreshMinMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PLAN_ST_REFRESH_MIN_MS;
  if (raw == null || raw.trim() === "") return 15_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 15_000;
}

/** One refresh at a time per project, and not again until the debounce window passes. Not a poller. */
export function claimPlanAppointmentRefresh(
  key: string,
  now = Date.now(),
  minMs = planRefreshMinMs(),
): "ok" | "in_flight" | "debounced" {
  if (inFlightRefresh.has(key)) return "in_flight";
  const last = recentRefresh.get(key) ?? 0;
  if (now - last < minMs) return "debounced";
  inFlightRefresh.add(key);
  recentRefresh.set(key, now);
  return "ok";
}

export function finishPlanAppointmentRefresh(key: string): void {
  inFlightRefresh.delete(key);
}
