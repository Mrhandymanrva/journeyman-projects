import { z } from "zod";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import type { AdvisoryLock, Database, SqlClient } from "../db/database.js";
import {
  payrollReaderFrom,
  resolvePayForTechnicians,
  roundMoney,
  technicianIdKey,
  type ResolvedTechPay,
} from "../domain/commissionLabor.js";
import {
  PAID_LABOR_LOOKBACK_DAYS,
  grossPayLaborDollars,
  readPaidLabor,
  readTechnicianDirectoryForLabor,
  saveLaborRefresh,
  withResolvedTechnicianNames,
  type LaborJobResult,
} from "../domain/laborActuals.js";
import {
  nextOvernight,
  refreshBootAction,
  type RefreshBootAction,
} from "../domain/overnightSchedule.js";
import {
  financialsFromReads,
  neverLaborRevenueWarnings,
  reconcileFinancials,
  withBilled,
  withLaborBurden,
  type BurdenSlice,
} from "../domain/projectFinancials.js";
import { isBeforeSourceFloor, sourceWindowStart } from "../domain/sourceFloor.js";
import {
  readStoredProjectMoney,
  readStoredReconciliation,
  replaceInvoiceLines,
  replaceMaterialExpenses,
  replacePlanAppointments,
  replaceProjectJobs,
  writeFinancialReconciliation,
  type ReconciliationTechnician,
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
export const OVERNIGHT_LOCK_RETRY_MS = 15 * 60 * 1000;
const RUN_IN_PROGRESS_MS = 30 * 60 * 1000;

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
  /** Test seam. Defaults to the database advisory lock. */
  tryLock?: (key: string) => Promise<AdvisoryLock | null>;
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
 * The same full read the Refresh button runs, for every linked project that
 * is not complete or cancelled. One overnight pass reads jobs, appointments,
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
        `SELECT p.id::text AS id, p.project_number
           FROM projects.projects p
          WHERE p.stage NOT IN ('complete', 'cancelled')
            AND (
              EXISTS (
                SELECT 1 FROM projects.st_project_connections c
                 WHERE c.project_id = p.id
              )
              OR EXISTS (
                SELECT 1 FROM projects.project_job_links j
                 WHERE j.project_id = p.id AND j.source_active
              )
            )
          ORDER BY p.project_number`,
      ),
    );
    const laborCode = await resolveStLaborCode(connection.client);
    const gapMs = options.gapMs ?? GAP_MS;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }));
    const refreshed: string[] = [];
    const failed: LaborRefreshFailure[] = [];
    const warned: LaborRefreshFailure[] = [];
    const startedAt = (options.now?.() ?? new Date()).toISOString();
    const writeRun = (status: "started" | "finished", error: string | null) =>
      saveLaborRefreshRun(db, tenantId, {
        status,
        started_at: startedAt,
        finished_at: status === "finished" ? (options.now?.() ?? new Date()).toISOString() : null,
        due_at: null,
        ok: refreshed.filter((id) => !warned.some((item) => item.projectId === id)),
        failed: [...failed, ...warned].map((item) => ({
          project_id: item.projectId,
          project_number: item.projectNumber,
          error: item.message,
        })),
        error,
      });
    await writeRun("started", null);
    for (let index = 0; index < projects.rows.length; index += 1) {
      const project = projects.rows[index]!;
      try {
        const result = await refreshLinkedProject(
          db,
          connection,
          tenantId,
          project.id,
          options.now?.() ?? new Date(),
          laborCode,
          "scheduled",
        );
        refreshed.push(project.id);
        if (result.warnings.length > 0) {
          const message = result.warnings.join("; ");
          console.error(`Labor refresh stamped ${project.project_number} with errors: ${message}`);
          warned.push({
            projectId: project.id,
            projectNumber: project.project_number,
            message,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Labor refresh failed for ${project.project_number}: ${message}`);
        failed.push({
          projectId: project.id,
          projectNumber: project.project_number,
          message,
        });
      }
      await writeRun("started", null);
      if (gapMs > 0 && index < projects.rows.length - 1) await sleep(gapMs);
    }
    await writeRun("finished", null);
    return { skipped: null, projects: projects.rows.length, refreshed, failed, laborCode };
  } finally {
    await lock.release();
  }
}

interface OperationalRead {
  warnings: string[];
  lines: StoredInvoiceLine[];
  orders: Array<{ id: string; externalJobId: string; total: number }>;
  /** ServiceTitan invoice header totals, one per invoice. */
  invoiceTotals: number[];
}

async function storeOperationalReads(
  db: Database,
  connection: ServiceTitanSource,
  tenantId: string,
  projectId: string,
  jobs: Array<{ external_job_id: string }>,
  observedAt: Date,
): Promise<OperationalRead> {
  const warnings: string[] = [];
  const appointments: StoredAppointment[] = [];
  const lines: StoredInvoiceLine[] = [];
  const orders: Array<{ id: string; externalJobId: string; total: number }> = [];
  const invoiceTotals: number[] = [];
  let appointmentsFailed = false;
  const invoiceFailedJobs: string[] = [];
  let ordersFailed = false;
  const readJob = connection.client.readJob.bind(connection.client);
  const reads = await mapPool(jobs, 4, async (job) => {
    const jobWarnings: string[] = [];
    const jobAppointments: StoredAppointment[] = [];
    const jobLines: StoredInvoiceLine[] = [];
    const jobOrders: Array<{ id: string; externalJobId: string; total: number }> = [];
    const jobInvoiceTotals: number[] = [];
    let appointmentsFailed = false;
    let invoiceFailed = false;
    let ordersFailed = false;
    try {
      const read = await readJob(job.external_job_id);
      for (const appointment of read.appointments) {
        if (isBeforeSourceFloor(appointment.start)) continue;
        jobAppointments.push({
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
    } catch (err) {
      appointmentsFailed = true;
      jobWarnings.push(`Job ${job.external_job_id} appointments: ${errorText(err)}`);
    }
    if (connection.client.readJobInvoiceLines) {
      try {
        const invoiceRead = await connection.client.readJobInvoiceLines.call(
          connection.client,
          job.external_job_id,
        );
        const invoiceLines = Array.isArray(invoiceRead) ? invoiceRead : invoiceRead.lines;
        if (!Array.isArray(invoiceRead)) {
          jobInvoiceTotals.push(...invoiceRead.invoices.map((invoice) => invoice.total));
        }
        jobLines.push(
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
      } catch (err) {
        // Only this job keeps its last stored lines. The other jobs still refresh.
        invoiceFailed = true;
        jobWarnings.push(`Job ${job.external_job_id} invoices: ${errorText(err)}`);
      }
    }
    if (connection.client.readJobPurchaseOrders) {
      try {
        const purchaseOrders = await connection.client.readJobPurchaseOrders.call(
          connection.client,
          job.external_job_id,
        );
        jobOrders.push(
          ...purchaseOrders.map((order) => ({
            id: order.id,
            externalJobId: job.external_job_id,
            total: order.total,
          })),
        );
      } catch (err) {
        ordersFailed = true;
        jobWarnings.push(`Job ${job.external_job_id} purchase orders: ${errorText(err)}`);
      }
    }
    return {
      jobWarnings,
      jobAppointments,
      jobLines,
      jobOrders,
      jobInvoiceTotals,
      appointmentsFailed,
      invoiceFailed,
      ordersFailed,
      jobId: job.external_job_id,
    };
  });
  for (const read of reads) {
    warnings.push(...read.jobWarnings);
    appointments.push(...read.jobAppointments);
    lines.push(...read.jobLines);
    orders.push(...read.jobOrders);
    invoiceTotals.push(...read.jobInvoiceTotals);
    if (read.appointmentsFailed) appointmentsFailed = true;
    if (read.invoiceFailed) invoiceFailedJobs.push(read.jobId);
    if (read.ordersFailed) ordersFailed = true;
  }
  await db.withTenant(tenantId, async (client) => {
    if (!appointmentsFailed) {
      await replacePlanAppointments(client, { tenantId, projectId, appointments, observedAt });
    }
    if (connection.client.readJobInvoiceLines) {
      await replaceInvoiceLines(client, {
        tenantId,
        projectId,
        lines,
        observedAt,
        keepJobIds: invoiceFailedJobs,
      });
    }
    if (connection.client.readJobPurchaseOrders && !ordersFailed) {
      await replaceMaterialExpenses(client, { tenantId, projectId, orders, observedAt });
    }
  });
  return { warnings, lines, orders, invoiceTotals };
}

export async function refreshLinkedProject(
  db: Database,
  connection: ServiceTitanSource,
  tenantId: string,
  projectId: string,
  observedAt: Date,
  laborCode: StLaborResolve,
  source: "manual" | "scheduled" = "scheduled",
): Promise<{ warnings: string[] }> {
  const readJobTimesheets = connection.client.readJobTimesheets;
  if (!readJobTimesheets) {
    throw new Error("ServiceTitan timesheet read is not configured.");
  }
  const warnings: string[] = [];
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
  let earliestJob: number | null = null;
  if (readProjectJobs && externalProjectId) {
    try {
      const listed = await readProjectJobs.call(connection.client, externalProjectId);
      for (const job of listed) {
        const created = job.createdOn ? Date.parse(job.createdOn) : NaN;
        if (Number.isFinite(created) && (earliestJob === null || created < earliestJob)) earliestJob = created;
      }
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
    } catch (err) {
      warnings.push(`Jobs: ${errorText(err)}`);
    }
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
  let operational: OperationalRead = { warnings: [], lines: [], orders: [], invoiceTotals: [] };
  if (readProjectJobs) {
    try {
      operational = await storeOperationalReads(
        db,
        connection,
        tenantId,
        projectId,
        jobs.rows,
        observedAt,
      );
      warnings.push(...operational.warnings);
    } catch (err) {
      warnings.push(`Appointments, invoices, or purchase orders: ${errorText(err)}`);
    }
  }
  // Gross pay items have no job filter: read from a day before the
  // project's first job, or the last PAID_LABOR_LOOKBACK_DAYS.
  const windowStart = sourceWindowStart(
    earliestJob == null ? null : earliestJob - 86_400_000,
    observedAt.getTime(),
    PAID_LABOR_LOOKBACK_DAYS * 86_400_000,
  );
  const paid = await readPaidLabor(
    jobs.rows.map((job) => job.external_job_id),
    {
      // Same call as POST /projects/:id/labor/refresh. Pulling the method off
      // the client and invoking it drops `this`, and ServiceTitanReadAdapter
      // then throws before any project is stamped.
      readGrossPayItems: connection.client.readGrossPayItems
        ? (query) => connection.client.readGrossPayItems!.call(connection.client, query)
        : undefined,
      readJobTimesheets: (jobId) => readJobTimesheets.call(connection.client, jobId),
      readJob: (jobId) => connection.client.readJob(jobId),
    },
    { dateOnOrAfter: windowStart.toISOString() },
  );
  const results = paid.results;
  warnings.push(...paid.warnings);
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
      stamp: paid.stamp,
    });
    await applyResolvedLaborCode(client, tenantId, laborCode);
    const jp = await readStoredProjectMoney(client, projectId);
    const rateByTechnician = new Map(
      technicians.map((tech) => [technicianIdKey(tech.id), tech.appliedBurdenRate]),
    );
    const jobIds = jobs.rows.map((job) => job.external_job_id);
    let st = financialsFromReads({
      invoiceLines: operational.lines.map((line) => ({
        kind: line.kind,
        total: line.total,
        technicianId: line.technicianId,
      })),
      timesheets: burdenSlicesFrom(namedResults, technicians),
      purchaseOrders: operational.orders.map((order) => ({ total: order.total })),
    });
    // Billed on the ServiceTitan side is the invoice header total, not the
    // sum of the same classified lines Journeyman stores.
    if (operational.invoiceTotals.length > 0) {
      st = withBilled(
        st,
        operational.invoiceTotals.reduce((sum, total) => sum + total, 0),
      );
    }
    if (paid.payroll === "gross-pay" && paid.grossPay && paid.stamp) {
      // Gross-pay amount is ServiceTitan's payroll dollar. It is not hours ×
      // burden rate, so a mismatch can show up here.
      st = withLaborBurden(st, grossPayLaborDollars(jobIds, paid.grossPay));
    } else if (paid.payroll === "failed" || (paid.payroll === "gross-pay" && !paid.stamp)) {
      const prior = await readStoredReconciliation(client, projectId);
      const priorBurden = prior?.lines.find((line) => line.key === "laborBurden")?.st;
      if (priorBurden != null) st = withLaborBurden(st, priorBurden);
    }
    warnings.push(...neverLaborRevenueWarnings(operational.lines));
    await writeFinancialReconciliation(client, {
      tenantId,
      projectId,
      observedAt,
      lines: reconcileFinancials(jp, st),
      technicians: await technicianSnapshot(client, projectId, technicians),
      error: warnings.length > 0 ? warnings.join("; ") : null,
    });
  });
  return { warnings };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function burdenSlicesFrom(
  results: readonly LaborJobResult[],
  technicians: readonly ResolvedTechPay[],
): BurdenSlice[] {
  const rates = new Map(
    technicians.map((tech) => [technicianIdKey(tech.id), tech.appliedBurdenRate]),
  );
  const slices: BurdenSlice[] = [];
  for (const result of results) {
    if (result.outcome !== "timesheet") continue;
    for (const draft of result.drafts) {
      const id = technicianIdKey(draft.externalTechnicianId);
      if (!id || !(draft.hours > 0)) continue;
      slices.push({
        technicianId: id,
        hours: draft.hours,
        burdenRate: rates.get(id) ?? null,
      });
    }
  }
  return slices;
}

async function technicianSnapshot(
  db: SqlClient,
  projectId: string,
  technicians: readonly ResolvedTechPay[],
): Promise<ReconciliationTechnician[]> {
  const pay = new Map(technicians.map((tech) => [technicianIdKey(tech.id), tech]));
  const { rows } = await db.query<{
    technician_id: string;
    technician_name: string | null;
    hours: string;
    labor_amount: string | null;
    burden_amount: string | null;
  }>(
    `SELECT external_technician_id AS technician_id,
            NULLIF(btrim(MAX(technician_name)), '') AS technician_name,
            COALESCE(SUM(hours), 0)::text AS hours,
            SUM(labor_amount)::text AS labor_amount,
            SUM(burden_amount)::text AS burden_amount
       FROM projects.labor_actuals
      WHERE project_id = $1
      GROUP BY external_technician_id
      ORDER BY 2 NULLS LAST, 1`,
    [projectId],
  );
  return rows.map((row) => {
    const tech = pay.get(technicianIdKey(row.technician_id));
    const commission = tech?.payBasis === "commission" && tech.commissionFraction != null;
    return {
      technician_id: row.technician_id,
      technician_name: row.technician_name?.trim() || tech?.name || row.technician_id,
      hours: roundMoney(Number(row.hours)),
      commission_percent: commission ? roundMoney((tech?.commissionFraction ?? 0) * 100) : null,
      commission_source: commission ? tech?.commissionSource ?? null : null,
      commission_amount: commission ? roundMoney(Number(row.labor_amount ?? 0)) : null,
      burden: row.burden_amount == null ? null : roundMoney(Number(row.burden_amount)),
    };
  });
}

interface RefreshRunBody {
  status: "started" | "finished";
  started_at: string;
  finished_at: string | null;
  due_at: string | null;
  ok: string[];
  failed: Array<{ project_id: string; project_number: string; error: string }>;
  error: string | null;
}

async function saveLaborRefreshRun(
  db: Database,
  tenantId: string,
  run: RefreshRunBody,
): Promise<void> {
  await db.withTenant(tenantId, (client) =>
    client.query(
      `UPDATE projects.tenant_settings
          SET labor_refresh_run = $2::jsonb
        WHERE tenant_id = $1`,
      [tenantId, JSON.stringify(run)],
    ),
  );
}

async function readOvernightState(
  db: Database,
  tenantId: string,
): Promise<{ dueAt: Date | null; finishedAt: Date | null; run: RefreshRunBody | null }> {
  const row = await db.withTenant(tenantId, (client) =>
    client.query<{ due_at: Date | null; finished_at: Date | null; run: RefreshRunBody | null }>(
      `SELECT overnight_refresh_due_at AS due_at,
              overnight_refresh_finished_at AS finished_at,
              labor_refresh_run AS run
         FROM projects.tenant_settings
        WHERE tenant_id = $1`,
      [tenantId],
    ),
  );
  const found = row.rows[0];
  return {
    dueAt: asDate(found?.due_at),
    finishedAt: asDate(found?.finished_at),
    run: found?.run ?? null,
  };
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function runStillGoing(run: RefreshRunBody | null, now: Date): boolean {
  if (!run || run.status !== "started" || !run.started_at) return false;
  const started = new Date(run.started_at).getTime();
  if (Number.isNaN(started)) return false;
  return now.getTime() - started >= 0 && now.getTime() - started < RUN_IN_PROGRESS_MS;
}

async function stampOvernightFinish(db: Database, tenantId: string, finishedAt: Date): Promise<void> {
  await db.withTenant(tenantId, (client) =>
    client.query(
      `UPDATE projects.tenant_settings SET overnight_refresh_finished_at = $2 WHERE tenant_id = $1`,
      [tenantId, finishedAt],
    ),
  );
}

async function stampOvernightDue(db: Database, tenantId: string, dueAt: Date): Promise<void> {
  await db.withTenant(tenantId, (client) =>
    client.query(
      `UPDATE projects.tenant_settings SET overnight_refresh_due_at = $2 WHERE tenant_id = $1`,
      [tenantId, dueAt],
    ),
  );
}

/**
 * One run a day at 2:00 AM America/New_York. A restart runs a missed night
 * instead of waiting until the next day. The timer is saved as a due instant
 * before the wait, so a new process can see the night that did not finish.
 * A lock held by another replica retries in 15 minutes and does not move
 * that due instant forward. There is no hourly interval.
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
    return { cancel: () => clearTimeout(handle) };
  });
  let pending: { cancel: () => void } | null = null;
  let stopped = false;
  let busy = false;
  const tick = async (reason: "overnight" | "missed-night"): Promise<boolean> => {
    if (busy || stopped) return false;
    busy = true;
    try {
      console.log(`Overnight ServiceTitan refresh started (${reason}).`);
      const report = await runHourlyLaborRefresh(db, serviceTitan, {
        tenantId,
        gapMs: options.gapMs,
        now,
        sleep: options.sleep,
        tryLock: options.tryLock,
      });
      if (report.skipped === "locked") {
        console.log(
          "Overnight ServiceTitan refresh skipped. Another replica holds the lock. Retrying in 15 minutes.",
        );
        return true;
      }
      await stampOvernightFinish(db, tenantId, now());
      console.log(`${reason} ${formatLaborRefreshRun(report)}`);
      return false;
    } catch (err) {
      const message = errorText(err);
      console.error(`Overnight ServiceTitan refresh did not run. ${message}`);
      try {
        const state = await readOvernightState(db, tenantId);
        await saveLaborRefreshRun(db, tenantId, {
          status: "started",
          started_at: state.run?.started_at ?? now().toISOString(),
          finished_at: null,
          due_at: state.run?.due_at ?? null,
          ok: state.run?.ok ?? [],
          failed: state.run?.failed ?? [],
          error: message,
        });
      } catch (writeErr) {
        console.error(`Overnight refresh status was not saved. ${errorText(writeErr)}`);
      }
      return true;
    } finally {
      busy = false;
    }
  };
  const follow = (retry: boolean) => {
    if (stopped) return;
    if (retry) retryLater();
    else void arm();
  };
  const retryLater = () => {
    if (stopped) return;
    pending?.cancel();
    pending = schedule(() => {
      void tick("overnight").then(follow);
    }, OVERNIGHT_LOCK_RETRY_MS);
  };
  const arm = async () => {
    if (stopped) return;
    const due = nextOvernight(now());
    const delay = Math.max(0, due.getTime() - now().getTime());
    try {
      await stampOvernightDue(db, tenantId, due);
    } catch (err) {
      console.error(`Overnight due time was not saved. ${errorText(err)}`);
    }
    if (stopped) return;
    console.log(`Overnight ServiceTitan refresh armed for ${due.toISOString()} in ${delay} ms.`);
    pending?.cancel();
    pending = schedule(() => {
      void tick("overnight").then(follow);
    }, delay);
  };
  void readOvernightState(db, tenantId).then((state) => {
    if (stopped) return;
    const action: RefreshBootAction = refreshBootAction(now(), state.dueAt, state.finishedAt);
    if (action === "catch-up") {
      if (runStillGoing(state.run, now())) {
        console.log("Overnight ServiceTitan refresh is already running. Retrying in 15 minutes.");
        retryLater();
        return;
      }
      console.log("Missed the 2 AM America/New_York refresh. Running one catch-up.");
      void tick("missed-night").then(follow);
      return;
    }
    void arm();
  }).catch((err: unknown) => {
    console.error(`Overnight schedule did not arm. ${errorText(err)}`);
  });
  return {
    cancel: () => {
      stopped = true;
      pending?.cancel();
    },
  };
}
