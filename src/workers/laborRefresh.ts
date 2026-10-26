import { z } from "zod";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import type { AdvisoryLock, Database } from "../db/database.js";
import { payrollReaderFrom, resolvePayForTechnicians } from "../domain/commissionLabor.js";
import {
  readLaborJobs,
  readTechnicianDirectoryForLabor,
  saveLaborRefresh,
  withResolvedTechnicianNames,
} from "../domain/laborActuals.js";
import {
  missedOvernightCatchUp,
  nextOvernight,
} from "../domain/overnightSchedule.js";
import {
  replaceInvoiceLines,
  replaceMaterialExpenses,
  replacePlanAppointments,
  replaceProjectJobs,
  type StoredAppointment,
  type StoredInvoiceLine,
} from "../domain/projectSync.js";
import {
  applyResolvedLaborCode,
  laborCodeRunLabel,
  resolveStLaborCode,
  type StLaborResolve,
} from "../domain/stLaborCode.js";

const GAP_MS = 250;
export const LABOR_REFRESH_LOCK_KEY = "journeyman.labor_auto_refresh";

type ServiceTitanSource = NonNullable<SourceConnections["serviceTitan"]>;

export interface LaborRefreshFailure {
  projectId: string;
  projectNumber: string;
  message: string;
}

export interface LaborRefreshReport {
  skipped: "locked" | null;
  projects: number;
  refreshed: string[];
  failed: LaborRefreshFailure[];
  /** Null when the run did not start. Otherwise the code resolved once for the run. */
  laborCode: StLaborResolve | null;
}

/**
 * Counts projects whose refresh finished, and projects whose refresh threw.
 * The labor-code clause names the code those hours were stamped with.
 */
export function formatLaborRefreshRun(
  report: Pick<LaborRefreshReport, "refreshed" | "failed" | "laborCode">,
): string {
  const code = report.laborCode ? laborCodeRunLabel(report.laborCode) : "not read";
  return `Labor refresh run: ${report.refreshed.length} refreshed, ${report.failed.length} failed; labor code: ${code}`;
}

export interface LaborRefreshOptions {
  /**
   * Database tenant for the read and the stamp. The scheduler passes the
   * sign-in tenant. Callers that already hold the right connection may omit
   * this and use that connection's tenant.
   */
  tenantId?: string;
  /** Pause between projects. Tests pass 0. The overnight run waits a quarter second. */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to a session advisory lock so only one replica runs. */
  tryLock?: (key: string) => Promise<AdvisoryLock | null>;
  now?: () => Date;
}

export interface LaborSchedulerOptions {
  /** Defaults to process.env. Same names the Refresh button sign-in uses. */
  env?: NodeJS.ProcessEnv;
  gapMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam. Defaults to setTimeout. */
  schedule?: (run: () => void, delayMs: number) => { cancel: () => void };
}

/**
 * The tenant a Refresh hours request writes.
 *
 * Sign-in uses SSO_TENANT_ID, otherwise PM_PORTFOLIO_TENANT_ID. That is the
 * staff member's tenant on the request. PM_ST_TENANT_ID only builds the
 * ServiceTitan client. A blank or non-uuid value is skipped so a bad setting
 * does not hide the next one.
 */
export function laborRefreshTenantId(
  env: NodeJS.ProcessEnv,
  connectorTenantId: string,
): string {
  for (const candidate of [env.SSO_TENANT_ID, env.PM_PORTFOLIO_TENANT_ID]) {
    const parsed = z.string().uuid().safeParse((candidate ?? "").trim());
    if (parsed.success) return parsed.data;
  }
  return connectorTenantId;
}

/**
 * The same full read the Refresh button runs, for every project that is not
 * complete or cancelled. One overnight pass reads jobs, appointments,
 * payroll timesheets, invoices, and purchase orders. ServiceTitan is only
 * read. The stamp source is scheduled.
 */
export async function runHourlyLaborRefresh(
  db: Database,
  connection: ServiceTitanSource,
  options: LaborRefreshOptions = {},
): Promise<LaborRefreshReport> {
  const tryLock = options.tryLock ?? ((key: string) => db.tryAdvisoryLock(key));
  const lock = await tryLock(LABOR_REFRESH_LOCK_KEY);
  if (!lock) return { skipped: "locked", projects: 0, refreshed: [], failed: [], laborCode: null };

  const tenantId = options.tenantId ?? connection.tenantId;
  try {
    const projects = await db.withTenant(tenantId, (client) =>
      client.query<{ id: string; project_number: string }>(
        `SELECT id::text AS id, project_number
           FROM projects.projects
          WHERE stage NOT IN ('complete', 'cancelled')
          ORDER BY project_number`,
      ),
    );
    const laborCode = await resolveStLaborCode(connection.client);
    const gapMs = options.gapMs ?? GAP_MS;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }));
    const refreshed: string[] = [];
    const failed: LaborRefreshFailure[] = [];
    for (let index = 0; index < projects.rows.length; index += 1) {
      const project = projects.rows[index]!;
      try {
        await refreshLinkedProject(
          db,
          connection,
          tenantId,
          project.id,
          options.now?.() ?? new Date(),
          laborCode,
          "scheduled",
        );
        refreshed.push(project.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Labor refresh failed for ${project.project_number}: ${message}`);
        failed.push({
          projectId: project.id,
          projectNumber: project.project_number,
          message,
        });
      }
      if (gapMs > 0 && index < projects.rows.length - 1) await sleep(gapMs);
    }
    return { skipped: null, projects: projects.rows.length, refreshed, failed, laborCode };
  } finally {
    await lock.release();
  }
}

async function storeOperationalReads(
  db: Database,
  connection: ServiceTitanSource,
  tenantId: string,
  projectId: string,
  jobs: Array<{ external_job_id: string }>,
  observedAt: Date,
): Promise<void> {
  const appointments: StoredAppointment[] = [];
  const lines: StoredInvoiceLine[] = [];
  const orders: Array<{ id: string; externalJobId: string; total: number }> = [];
  const readJob = connection.client.readJob.bind(connection.client);
  for (const job of jobs) {
    const read = await readJob(job.external_job_id);
    for (const appointment of read.appointments) {
      appointments.push({
        externalJobId: read.job.id,
        externalAppointmentId: appointment.id,
        jobNumber: read.job.jobNumber,
        appointmentNumber: appointment.appointmentNumber,
        jobStatus: read.job.jobStatus,
        startsAt: appointment.start,
        endsAt: appointment.end,
        status: appointment.status,
        active: appointment.active,
        technicians: read.assignments
          .filter((assignment) => assignment.appointmentId === appointment.id && assignment.active)
          .map((assignment) => ({ id: assignment.technicianId, name: assignment.technicianName })),
      });
    }
    if (connection.client.readJobInvoiceLines) {
      const invoiceLines = await connection.client.readJobInvoiceLines.call(connection.client, job.external_job_id);
      lines.push(
        ...invoiceLines.map((line) => ({
          invoiceId: line.invoiceId,
          externalJobId: job.external_job_id,
          lineKey: line.lineKey,
          sku: line.sku,
          kind: line.kind,
          quantity: line.quantity,
          total: line.total,
          technicianId: line.technicianId,
        })),
      );
    }
    if (connection.client.readJobPurchaseOrders) {
      const purchaseOrders = await connection.client.readJobPurchaseOrders.call(
        connection.client,
        job.external_job_id,
      );
      orders.push(
        ...purchaseOrders.map((order) => ({
          id: order.id,
          externalJobId: job.external_job_id,
          total: order.total,
        })),
      );
    }
  }
  await db.withTenant(tenantId, async (client) => {
    await replacePlanAppointments(client, { tenantId, projectId, appointments, observedAt });
    if (connection.client.readJobInvoiceLines) {
      await replaceInvoiceLines(client, { tenantId, projectId, lines, observedAt });
    }
    if (connection.client.readJobPurchaseOrders) {
      await replaceMaterialExpenses(client, { tenantId, projectId, orders, observedAt });
    }
  });
}

export async function refreshLinkedProject(
  db: Database,
  connection: ServiceTitanSource,
  tenantId: string,
  projectId: string,
  observedAt: Date,
  laborCode: StLaborResolve,
  source: "manual" | "scheduled" = "scheduled",
): Promise<void> {
  const readJobTimesheets = connection.client.readJobTimesheets;
  if (!readJobTimesheets) {
    throw new Error("ServiceTitan timesheet read is not configured.");
  }
  const connectionRow = await db.withTenant(tenantId, (client) =>
    client.query<{ external_project_id: string }>(
      `SELECT external_project_id
         FROM projects.st_project_connections
        WHERE project_id = $1 AND external_system_id = $2`,
      [projectId, connection.externalSystemId],
    ),
  );
  const externalProjectId = connectionRow.rows[0]?.external_project_id ?? null;
  const readProjectJobs = connection.client.readProjectJobs;
  if (readProjectJobs && externalProjectId) {
    const listed = await readProjectJobs.call(connection.client, externalProjectId);
    await db.withTenant(tenantId, (client) =>
      replaceProjectJobs(client, {
        tenantId,
        projectId,
        externalSystemId: connection.externalSystemId,
        jobs: listed.map((job) => ({
          id: job.id,
          jobNumber: job.jobNumber,
          jobStatus: job.jobStatus,
          createdOn: job.createdOn,
          completedOn: job.completedOn,
        })),
      }),
    );
  }
  const jobs = await db.withTenant(tenantId, (client) =>
    client.query<{ id: string; external_job_id: string }>(
      `SELECT id::text AS id, external_job_id
         FROM projects.project_job_links
        WHERE project_id = $1
          AND external_system_id = $2
          AND source_active
        ORDER BY external_job_id`,
      [projectId, connection.externalSystemId],
    ),
  );
  if (readProjectJobs) {
    await storeOperationalReads(db, connection, tenantId, projectId, jobs.rows, observedAt);
  }
  const results = await readLaborJobs(
    jobs.rows.map((job) => job.external_job_id),
    {
      // Same call as POST /projects/:id/labor/refresh. Pulling the method off
      // the client and invoking it drops `this`, and ServiceTitanReadAdapter
      // then throws before any project is stamped.
      readJobTimesheets: (jobId) => readJobTimesheets.call(connection.client, jobId),
      readJob: (jobId) => connection.client.readJob(jobId),
    },
  );
  const directory = await readTechnicianDirectoryForLabor({
    readTechnicians: connection.client.readTechnicians?.bind(connection.client),
  });
  const technicians = await resolvePayForTechnicians(
    directory.technicians,
    payrollReaderFrom(connection.client),
  );
  const namedResults = await withResolvedTechnicianNames(
    results,
    technicians,
    connection.client.readStaffName?.bind(connection.client),
  );
  await db.withTenant(tenantId, async (client) => {
    await saveLaborRefresh(client, {
      tenantId,
      projectId,
      jobs: jobs.rows,
      results: namedResults,
      directory: { ...directory, technicians },
      source,
      observedAt,
    });
    await applyResolvedLaborCode(client, tenantId, laborCode);
  });
}

async function lastOvernightFinish(db: Database, tenantId: string): Promise<Date | null> {
  const row = await db.withTenant(tenantId, (client) =>
    client.query<{ finished: Date | null }>(
      `SELECT overnight_refresh_finished_at AS finished
         FROM projects.tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    ),
  );
  return row.rows[0]?.finished ?? null;
}

async function stampOvernightFinish(db: Database, tenantId: string, finishedAt: Date): Promise<void> {
  await db.withTenant(tenantId, (client) =>
    client.query(
      `UPDATE projects.tenant_settings SET overnight_refresh_finished_at = $2 WHERE tenant_id = $1`,
      [tenantId, finishedAt],
    ),
  );
}

/**
 * One run a day at 2:00 AM America/New_York. Nothing runs on the first boot.
 * If a previous night finished and today's 2 AM was missed because the
 * process was down, one catch-up runs at boot and the next wait is the
 * following 2 AM. There is no hourly interval.
 */
export function startLaborRefreshScheduler(
  db: Database,
  sources: SourceConnections,
  options: LaborSchedulerOptions = {},
): { cancel: () => void } | undefined {
  const serviceTitan = sources.serviceTitan;
  if (!serviceTitan?.client.readJobTimesheets) {
    console.log("Overnight ServiceTitan refresh is off. ServiceTitan is not configured.");
    return undefined;
  }
  const tenantId = laborRefreshTenantId(
    options.env ?? process.env,
    serviceTitan.tenantId,
  );
  const now = () => options.now?.() ?? new Date();
  const schedule = options.schedule ?? ((run, delayMs) => {
    const handle = setTimeout(run, delayMs);
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  });
  let pending: { cancel: () => void } | null = null;
  let stopped = false;
  let busy = false;
  const tick = async (reason: "overnight" | "missed-night") => {
    if (busy || stopped) return;
    busy = true;
    try {
      const report = await runHourlyLaborRefresh(db, serviceTitan, {
        tenantId,
        gapMs: options.gapMs,
        now,
        sleep: options.sleep,
      });
      if (report.skipped === "locked") {
        console.log("Overnight ServiceTitan refresh skipped. Another replica holds the lock.");
        return;
      }
      await stampOvernightFinish(db, tenantId, now());
      console.log(`${reason} ${formatLaborRefreshRun(report)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Overnight ServiceTitan refresh did not run. ${message}`);
    } finally {
      busy = false;
    }
  };
  const arm = () => {
    if (stopped) return;
    const delay = Math.max(0, nextOvernight(now()).getTime() - now().getTime());
    pending = schedule(() => {
      void tick("overnight").finally(arm);
    }, delay);
  };
  void lastOvernightFinish(db, tenantId).then((finished) => {
    if (stopped) return;
    if (missedOvernightCatchUp(now(), finished)) {
      console.log("Missed the 2 AM America/New_York refresh. Running one catch-up.");
      void tick("missed-night").finally(arm);
      return;
    }
    arm();
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Overnight schedule did not arm. ${message}`);
  });
  return {
    cancel: () => {
      stopped = true;
      pending?.cancel();
    },
  };
}
