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
  readPaidLabor,
  readTechnicianDirectoryForLabor,
  saveLaborCostSource,
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
  publishedServiceTitanLabor,
  reconcileFinancials,
  withBilled,
  withLaborBurden,
  type BurdenSlice,
  type ReconciliationLine,
} from "../domain/projectFinancials.js";
import { writeProjectSummary } from "../domain/financialsDashboardStore.js";
import { isBeforeSourceFloor, sourceWindowStart } from "../domain/sourceFloor.js";
import { grossPayItemTooOld } from "../domain/grossPay.js";
import {
  RECENT_PAYROLL_MISSING_WARNING,
  burdenFromArrivedDone,
  chooseLaborCostSource,
  chooseStLaborBurden,
  countMatchingPaidHourRows,
  isCanceledJobStatus,
  laborEstimateFromBilled,
  nonPtoGrossPayOnJobs,
  plfeOnlyBilledLabor,
  projectPayrollAge,
  stLaborTotal,
  sumTiedAdjustments,
  type LaborCostSource,
  type LaborEstimate,
  type StLaborBreakdown,
  type WorkedTimesheet,
} from "../domain/stLabor.js";
import type { GrossPayItem } from "../adapters/serviceTitan.js";
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
  summarizeServiceTitanReads,
  type EstimateRead,
  type InvoiceHeaderRead,
} from "../domain/stFinancialSummary.js";
import {
  applyResolvedLaborCode,
  laborCodeRunLabel,
  resolveStLaborCode,
  type StLaborResolve,
} from "../domain/stLaborCode.js";
import { syncLinkedProjectStatuses } from "../domain/stStatusSync.js";

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
    try {
      await syncLinkedProjectStatuses(db, connection, tenantId);
    } catch (err) {
      console.error(`ServiceTitan status sync did not finish. ${errorText(err)}`);
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
  let datedJobs: Array<{ id: string; jobStatus: string | null; createdOn: string | null }> = [];
  if (readProjectJobs && externalProjectId) {
    try {
      const listed = await readProjectJobs.call(connection.client, externalProjectId);
      datedJobs = listed.map((job) => ({
        id: job.id,
        jobStatus: job.jobStatus,
        createdOn: job.createdOn,
      }));
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
    client.query<{ id: string; external_job_id: string; source_job_status: string | null }>(
      `SELECT id::text AS id, external_job_id, source_job_status
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
  const jobIds = jobs.rows.map((job) => job.external_job_id);
  const paid = await readPaidLabor(
    jobIds,
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
  const laborSource = chooseLaborCostSource({
    payrollReadSucceeded: paid.grossPay != null,
    matchingPaidHourRows: paid.grossPay ? countMatchingPaidHourRows(jobIds, paid.grossPay) : 0,
    age: projectPayrollAge(datedJobs, observedAt.getTime()),
  });
  if (laborSource === "none_recent_payroll_missing") warnings.push(RECENT_PAYROLL_MISSING_WARNING);
  let adjustmentItems: Array<{
    id: string | null;
    employeeId: string | null;
    amount: number | null;
    jobId: string | null;
    invoiceId: string | null;
    postedOn: string | null;
  }> = [];
  let adjustmentsAvailable = false;
  if (paid.grossPay && connection.client.readPayrollAdjustments) {
    try {
      const read = await connection.client.readPayrollAdjustments.call(connection.client, {
        postedOnOrAfter: windowStart.toISOString(),
      });
      if (read.forbidden) {
        warnings.push("Payroll adjustments: ServiceTitan read failed (HTTP 403).");
      } else if (!read.unavailable) {
        adjustmentsAvailable = true;
        adjustmentItems = read.items;
        if (read.capped) warnings.push("Payroll adjustments: pagination limit reached.");
      }
    } catch (err) {
      warnings.push(`Payroll adjustments: ${errorText(err)}`);
    }
  }
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
  const estimate =
    laborSource === "billed_labor_25pct"
      ? await estimateWithoutPayroll({
          connection,
          jobIds: jobs.rows
            .filter((job) => !isCanceledJobStatus(job.source_job_status))
            .map((job) => job.external_job_id),
          lines: operational.lines,
          technicians,
          warnings,
        })
      : null;
  await db.withTenant(tenantId, async (client) => {
    const stampRow = await client.query<{ labor_refreshed_at: Date | null }>(
      `SELECT labor_refreshed_at FROM projects.projects WHERE id = $1`,
      [projectId],
    );
    const previouslyStamped = stampRow.rows[0]?.labor_refreshed_at != null;
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
    if (laborSource) {
      await saveLaborCostSource(client, {
        projectId,
        source: laborSource,
        estimate: laborSource === "billed_labor_25pct" ? estimate : null,
      });
    }
    await applyResolvedLaborCode(client, tenantId, laborCode);
    let jp = await readStoredProjectMoney(client, projectId);
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
    const invoiceIds = [...new Set(operational.lines.map((line) => line.invoiceId))];
    const breakdown = paid.grossPay
      ? laborBreakdown({
          burden: st.laborBurden,
          workHours: workedHours(namedResults),
          driveHours: 0,
          grossPay: nonPtoGrossPayOnJobs(jobIds, paid.grossPay),
          adjustments: adjustmentsAvailable
            ? sumTiedAdjustments(adjustmentItems, {
                jobIds,
                invoiceIds,
                technicianIds: technicianIdsOnProject(jobIds, paid.grossPay, namedResults),
              }).sum
            : null,
          adjustmentsAvailable,
          hoursSource: paid.hoursSource,
        })
      : null;
    const prior = await readStoredReconciliation(client, projectId);
    const choice = chooseStLaborBurden({
      breakdown,
      projectGrossPayRows: paid.grossPay ? grossPayRowsOnJobs(jobIds, paid.grossPay) : 0,
      previouslyStamped,
      priorBurden: prior?.lines.find((line) => line.key === "laborBurden")?.st ?? null,
    });
    let stLabor: StLaborBreakdown | null = choice.breakdown;
    if (choice.carriedPrior) {
      if (choice.laborBurden != null) st = withLaborBurden(st, choice.laborBurden);
      stLabor = prior?.st_labor ?? null;
    } else if (choice.laborBurden != null) {
      st = withLaborBurden(st, choice.laborBurden);
    }
    if (laborSource === "billed_labor_25pct" && estimate) {
      jp = withLaborBurden(jp, estimate.total);
      const published = publishedServiceTitanLabor(externalProjectId);
      if (published != null) st = withLaborBurden(st, published);
    }
    warnings.push(...neverLaborRevenueWarnings(operational.lines));
    const lines = reconcileFinancials(jp, st).map((line) => laborLine(line, laborSource, estimate));
    await writeFinancialReconciliation(client, {
      tenantId,
      projectId,
      observedAt,
      lines,
      technicians: await technicianSnapshot(client, projectId, technicians),
      error: warnings.length > 0 ? warnings.join("; ") : null,
      stLabor,
    });
  });
  try {
    await storeProjectFinancialSummary(
      db,
      connection,
      tenantId,
      projectId,
      observedAt,
      externalProjectId,
      jobs.rows.map((job) => job.external_job_id),
      warnings,
    );
  } catch (err) {
    warnings.push(`Project summary: ${errorText(err)}`);
  }
  return { warnings };
}

/**
 * Contract, budget, change orders, retainage, and open invoices.
 * A failed read leaves the last stored figures. Nothing is written to ServiceTitan.
 */
async function storeProjectFinancialSummary(
  db: Database,
  connection: ServiceTitanSource,
  tenantId: string,
  projectId: string,
  observedAt: Date,
  externalProjectId: string | null,
  jobIds: readonly string[],
  warnings: string[],
): Promise<void> {
  const readEstimates = connection.client.readProjectEstimates;
  const readInvoices = connection.client.readJobInvoiceSummaries;
  const readRetainage = connection.client.readProjectRetainage;
  if (!readEstimates && !readInvoices && !readRetainage) return;

  let estimates: EstimateRead[] | null = null;
  let invoices: InvoiceHeaderRead[] | null = null;
  let projectRetainage: number | null | undefined;

  if (readEstimates && externalProjectId) {
    try {
      estimates = await readEstimates.call(connection.client, externalProjectId, jobIds);
    } catch (err) {
      warnings.push(`Estimates: ${errorText(err)}`);
    }
  }
  if (readInvoices && jobIds.length > 0) {
    const collected: InvoiceHeaderRead[] = [];
    let failed = false;
    for (const jobId of jobIds) {
      try {
        collected.push(...(await readInvoices.call(connection.client, jobId)));
      } catch (err) {
        failed = true;
        warnings.push(`Job ${jobId} invoice summary: ${errorText(err)}`);
      }
    }
    if (!failed) invoices = collected;
  }
  if (readRetainage && externalProjectId) {
    try {
      projectRetainage = await readRetainage.call(connection.client, externalProjectId);
    } catch (err) {
      warnings.push(`Project retainage: ${errorText(err)}`);
    }
  }
  if (!estimates && !invoices && projectRetainage == null) return;
  const summary = summarizeServiceTitanReads({
    estimates,
    invoices,
    projectRetainage: projectRetainage ?? null,
  });
  await db.withTenant(tenantId, (client) =>
    writeProjectSummary(client, { tenantId, projectId, observedAt, summary }),
  );
}

async function estimateWithoutPayroll(input: {
  connection: ServiceTitanSource;
  jobIds: readonly string[];
  lines: readonly StoredInvoiceLine[];
  technicians: readonly ResolvedTechPay[];
  warnings: string[];
}): Promise<LaborEstimate> {
  const rates = new Map<string, number | null>();
  for (const tech of input.technicians) {
    const id = technicianIdKey(tech.id);
    if (id) rates.set(id, tech.appliedBurdenRate);
  }
  let rows: WorkedTimesheet[] = [];
  const bulk = input.connection.client.readJobTimesheetsForJobs;
  if (input.jobIds.length === 0) {
    rows = [];
  } else if (bulk) {
    try {
      const read = await bulk.call(input.connection.client, input.jobIds);
      if (read.forbidden) {
        input.warnings.push("Payroll job timesheets: ServiceTitan read failed (HTTP 403). Burden was left at 0.");
      } else if (read.capped) {
        input.warnings.push("Payroll job timesheets: pagination limit reached. Burden was left at 0.");
      } else {
        rows = read.timesheets;
      }
    } catch (err) {
      input.warnings.push(`Payroll job timesheets: ${errorText(err)} Burden was left at 0.`);
    }
  } else {
    const readOne = input.connection.client.readJobTimesheets;
    for (const jobId of input.jobIds) {
      if (!readOne) {
        input.warnings.push("Payroll job timesheets are not configured. Burden was left at 0.");
        break;
      }
      try {
        const read = await readOne.call(input.connection.client, jobId);
        if (read.forbidden) {
          input.warnings.push(`Job ${jobId} timesheets: ServiceTitan read failed (HTTP 403).`);
          continue;
        }
        rows.push(...read.timesheets.map((row) => ({ ...row, jobId })));
      } catch (err) {
        input.warnings.push(`Job ${jobId} timesheets: ${errorText(err)}`);
      }
    }
  }
  const burden = burdenFromArrivedDone(rows, rates);
  if (burden.techsMissingRate > 0) {
    input.warnings.push(
      `Labor burden: ${burden.techsMissingRate} technician${burden.techsMissingRate === 1 ? "" : "s"} with arrived-to-done hours had no burden rate.`,
    );
  }
  return laborEstimateFromBilled({
    billedLabor: roundMoney(input.lines.filter((line) => line.kind === "labor").reduce((sum, line) => sum + line.total, 0)),
    plfeLabor: plfeOnlyBilledLabor(input.lines),
    burden: burden.burden,
    burdenHours: burden.hours,
  });
}

function laborLine(
  line: ReconciliationLine,
  source: LaborCostSource | null,
  estimate: LaborEstimate | null,
): ReconciliationLine {
  if (line.key !== "laborBurden") return line;
  if (source === "billed_labor_25pct" && estimate) {
    return {
      ...line,
      label: "Labor cost (commission + burden)",
      status: "estimated",
      commission: estimate.commission,
      burden: estimate.burden,
      billed_labor: estimate.billed_labor,
      billed_labor_plfe: estimate.billed_labor_plfe,
    };
  }
  if (source === "none_recent_payroll_missing") return { ...line, status: "missing" };
  return line;
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

function laborBreakdown(input: Omit<StLaborBreakdown, "total">): StLaborBreakdown {
  return { ...input, total: stLaborTotal(input.burden, input.grossPay, input.adjustments) };
}

function workedHours(results: readonly LaborJobResult[]): number {
  let sum = 0;
  for (const result of results) {
    if (result.outcome !== "timesheet") continue;
    for (const draft of result.drafts) sum += draft.hours;
  }
  return roundMoney(sum);
}

function grossPayRowsOnJobs(jobIds: readonly string[], items: readonly GrossPayItem[]): number {
  const wanted = new Set(jobIds);
  let count = 0;
  for (const item of items) {
    if (grossPayItemTooOld(item)) continue;
    if (item.jobId && wanted.has(item.jobId)) count += 1;
  }
  return count;
}

function technicianIdsOnProject(
  jobIds: readonly string[],
  items: readonly GrossPayItem[],
  results: readonly LaborJobResult[],
): string[] {
  const wanted = new Set(jobIds);
  const ids = new Set<string>();
  for (const item of items) {
    if (!item.jobId || !wanted.has(item.jobId)) continue;
    const id = technicianIdKey(item.technicianId);
    if (id) ids.add(id);
  }
  for (const result of results) {
    for (const draft of result.drafts) {
      const id = technicianIdKey(draft.externalTechnicianId);
      if (id) ids.add(id);
    }
  }
  return [...ids];
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
