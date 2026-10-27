import type { GrossPayItem } from "../adapters/serviceTitan.js";
import { technicianIdKey } from "./commissionLabor.js";
import { grossPayItemTooOld } from "./grossPay.js";
import { PAID_LABOR_LOOKBACK_DAYS } from "./laborActuals.js";
import { publishedServiceTitanLabor, roundMoney } from "./projectFinancials.js";
import { sourceWindowStart } from "./sourceFloor.js";
import {
  PROJECT_LABOR_EXPENSE_UNAVAILABLE,
  RECENT_PROJECT_DAYS,
  TIMESHEET_BURDEN_ENDPOINT,
  arrivedDoneHours,
  chooseLaborCostSource,
  countMatchingPaidHourRows,
  grossPayRowDollars,
  isCanceledJobStatus,
  isPaidTimeOff,
  projectPayrollAge,
  sumTiedAdjustments,
  type LaborCostSource,
  type PayrollAdjustmentRow,
  type WorkedTimesheet,
} from "./stLabor.js";

export const ST_LABOR_MATCH_DOLLARS = 1;

export interface StLaborDiagnosticJob {
  id: string;
  jobStatus?: string | null;
  createdOn?: string | null;
}

export interface StLaborDiagnosticRead {
  stProjectId: string;
  windowStart: string;
  jobs: readonly StLaborDiagnosticJob[];
  grossPay: {
    pagesRead: number;
    capped: boolean;
    forbidden: boolean;
    skipped: number;
    omitted: number;
    items: readonly GrossPayItem[];
    timesheetTimeWithoutJob: { count: number; withPaidHours: number };
  };
  timesheets: readonly WorkedTimesheet[];
  timesheetsForbidden: boolean;
  burdenRateByTechnician: ReadonlyMap<string, number | null>;
  adjustments: {
    available: boolean;
    items: readonly PayrollAdjustmentRow[];
  };
  invoiceIds: readonly string[];
  invoicesUnread: boolean;
}

export const PROJECT_AGE_RULE =
  "A project is older when its earliest non-canceled job was created more than 60 days before the read. Otherwise it is recent, including when created dates are missing. Recent projects with no matching payroll rows are not estimated at 25% of billed labor.";

export interface StLaborDiagnostic {
  st_project_id: string;
  generated_at: string;
  window_start: string;
  known_service_titan_labor: number | null;
  project_age: "older" | "recent";
  recent_window_days: number;
  age_rule: string;
  labor_source: LaborCostSource | null;
  gross_pay: {
    pages_read: number;
    capped: boolean;
    forbidden: boolean;
    skipped: number;
    omitted: number;
    rows: number;
    rows_with_job_id: number;
    rows_without_job_id: number;
    date_range: { earliest: string | null; latest: string | null };
    payroll_id_count: number;
    payroll_ids: string[];
    by_type: Array<{
      gross_pay_item_type: string;
      count: number;
      with_paid_hours: number;
      sum_paid_hours: number;
      sum_amount: number;
      paid_time_off_count: number;
      paid_time_off_amount: number;
    }>;
    per_job: Array<{ job_id: string; count: number }>;
    project_rows_job_not_in_list: number;
    timesheet_time_without_job_id: { count: number; with_paid_hours: number };
    matching_paid_hour_rows: number;
    project_tech_rows_on_other_jobs: number;
    project_tech_rows_without_job: number;
  };
  job_timesheets: {
    forbidden: boolean;
    skipped_canceled_jobs: number;
    arrived_done_hours: number;
    jobs: Array<{
      job_id: string;
      row_count: number;
      canceled_rows: number;
      arrived_done_hours: number;
      paid_duration_rows: number;
    }>;
  };
  project_labor_expense: {
    available: false;
    endpoint: null;
    amount: null;
    reason: string;
    service_titan_labor: number | null;
    delta: null;
  };
  timesheet_burden: {
    endpoint: string;
    hours: number;
    amount: number;
    techs_missing_rate: number;
    included_in_labor_hours: false;
    service_titan_labor: number | null;
    delta: number | null;
    note: string;
  };
  payroll_adjustments: {
    available: boolean;
    count: number;
    sum: number | null;
    tied_by: "job-or-invoice" | "technician" | "none";
    untied: number;
    invoices_unread: boolean;
  };
  notes: string[];
}

export function knownServiceTitanLabor(stProjectId: string): number | null {
  return publishedServiceTitanLabor(stProjectId);
}

export function paidLaborWindowStart(
  jobs: readonly { createdOn?: string | null }[],
  nowMs = Date.now(),
): { start: string; missingCreatedOn: boolean } {
  let earliest: number | null = null;
  for (const job of jobs) {
    const created = job.createdOn ? Date.parse(job.createdOn) : NaN;
    if (Number.isFinite(created) && (earliest == null || created < earliest)) earliest = created;
  }
  return {
    missingCreatedOn: earliest == null,
    start: sourceWindowStart(
      earliest == null ? null : earliest - 86_400_000,
      nowMs,
      PAID_LABOR_LOOKBACK_DAYS * 86_400_000,
    ).toISOString(),
  };
}

function positiveHours(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Aggregate ServiceTitan payroll for one project.
 * The result has no technician names, ids, rates, or per-person amounts.
 * Burden from job timesheets is a difference next to ServiceTitan's labor expense, not a match.
 */
export function buildStLaborDiagnostic(input: StLaborDiagnosticRead, generatedAt = new Date()): StLaborDiagnostic {
  const jobIds = input.jobs.map((job) => job.id);
  const jobSet = new Set(jobIds);
  const canceled = new Set(input.jobs.filter((job) => isCanceledJobStatus(job.jobStatus)).map((job) => job.id));
  const known = knownServiceTitanLabor(input.stProjectId);
  const age = projectPayrollAge(input.jobs, generatedAt.getTime());
  const matchingPaidHours = input.grossPay.forbidden
    ? 0
    : countMatchingPaidHourRows(jobIds, input.grossPay.items);
  const laborSource = chooseLaborCostSource({
    payrollReadSucceeded: !input.grossPay.forbidden,
    matchingPaidHourRows: matchingPaidHours,
    age,
  });

  const typeBuckets = new Map<
    string,
    {
      count: number;
      withPaidHours: number;
      sumPaidHours: number;
      sumAmount: number;
      paidTimeOffCount: number;
      paidTimeOffAmount: number;
    }
  >();
  const perJob = new Map<string, number>(jobIds.map((id) => [id, 0]));
  let projectRowsJobNotInList = 0;
  let rowsWithJob = 0;
  let rowsWithoutJob = 0;
  let earliest: string | null = null;
  let latest: string | null = null;
  const payrollIds = new Set<string>();
  const projectTechs = new Set<string>();
  for (const item of input.grossPay.items) {
    if (item.payrollId) payrollIds.add(item.payrollId);
    if (item.date) {
      if (!earliest || item.date < earliest) earliest = item.date;
      if (!latest || item.date > latest) latest = item.date;
    }
    if (item.jobId) rowsWithJob += 1;
    else rowsWithoutJob += 1;
    const onProjectJob = item.jobId != null && jobSet.has(item.jobId);
    if (onProjectJob && item.technicianId) projectTechs.add(item.technicianId);
    if (item.projectId === input.stProjectId && (!item.jobId || !jobSet.has(item.jobId))) projectRowsJobNotInList += 1;
    if (!onProjectJob) continue;
    perJob.set(item.jobId!, (perJob.get(item.jobId!) ?? 0) + 1);
    const type = item.type?.trim() || "unspecified";
    const bucket = typeBuckets.get(type) ?? {
      count: 0,
      withPaidHours: 0,
      sumPaidHours: 0,
      sumAmount: 0,
      paidTimeOffCount: 0,
      paidTimeOffAmount: 0,
    };
    bucket.count += 1;
    const dollars = grossPayRowDollars(item);
    bucket.sumAmount = roundMoney(bucket.sumAmount + dollars);
    if (positiveHours(item.paidDurationHours)) {
      bucket.withPaidHours += 1;
      bucket.sumPaidHours = roundMoney(bucket.sumPaidHours + (item.paidDurationHours ?? 0));
    }
    if (isPaidTimeOff(item)) {
      bucket.paidTimeOffCount += 1;
      bucket.paidTimeOffAmount = roundMoney(bucket.paidTimeOffAmount + dollars);
    }
    typeBuckets.set(type, bucket);
  }
  for (const row of input.timesheets) {
    if (!row.technicianId || !row.jobId || !jobSet.has(row.jobId) || canceled.has(row.jobId)) continue;
    if (row.canceledOn) continue;
    projectTechs.add(row.technicianId);
  }
  let projectTechOtherJobs = 0;
  let projectTechWithoutJob = 0;
  for (const item of input.grossPay.items) {
    if (!item.technicianId || !projectTechs.has(item.technicianId)) continue;
    if (!item.jobId) projectTechWithoutJob += 1;
    else if (!jobSet.has(item.jobId)) projectTechOtherJobs += 1;
  }

  const jobSheets = new Map<string, { rowCount: number; canceledRows: number; arrivedDoneHours: number; paidDurationRows: number }>();
  for (const id of jobIds) {
    if (canceled.has(id)) continue;
    jobSheets.set(id, { rowCount: 0, canceledRows: 0, arrivedDoneHours: 0, paidDurationRows: 0 });
  }
  let arrivedDone = 0;
  let techsMissingRate = 0;
  const hoursByTech = new Map<string, number>();
  for (const row of input.timesheets) {
    const jobId = row.jobId ?? "";
    if (!jobSet.has(jobId) || canceled.has(jobId)) continue;
    const sheet = jobSheets.get(jobId) ?? { rowCount: 0, canceledRows: 0, arrivedDoneHours: 0, paidDurationRows: 0 };
    sheet.rowCount += 1;
    if (row.canceledOn) sheet.canceledRows += 1;
    if (positiveHours(row.paidDurationHours)) sheet.paidDurationRows += 1;
    const hours = arrivedDoneHours(row);
    if (hours > 0) {
      sheet.arrivedDoneHours = roundMoney(sheet.arrivedDoneHours + hours);
      arrivedDone = roundMoney(arrivedDone + hours);
      const tech = row.technicianId?.trim() || "";
      hoursByTech.set(tech, roundMoney((hoursByTech.get(tech) ?? 0) + hours));
    }
    jobSheets.set(jobId, sheet);
  }
  let burden = 0;
  for (const [tech, hours] of hoursByTech) {
    const rate = tech ? input.burdenRateByTechnician.get(tech) : null;
    if (rate == null || !(rate > 0)) {
      techsMissingRate += 1;
      continue;
    }
    burden = roundMoney(burden + roundMoney(hours * rate));
  }
  const burdenDelta = known == null ? null : roundMoney(burden - known);
  const tied = sumTiedAdjustments(input.adjustments.items, {
    jobIds,
    invoiceIds: input.invoiceIds,
    technicianIds: [],
  });

  return {
    st_project_id: input.stProjectId,
    generated_at: generatedAt.toISOString(),
    window_start: input.windowStart,
    known_service_titan_labor: known,
    project_age: age,
    recent_window_days: RECENT_PROJECT_DAYS,
    age_rule: PROJECT_AGE_RULE,
    labor_source: laborSource,
    gross_pay: {
      pages_read: input.grossPay.pagesRead,
      capped: input.grossPay.capped,
      forbidden: input.grossPay.forbidden,
      skipped: input.grossPay.skipped,
      omitted: input.grossPay.omitted,
      rows: input.grossPay.items.length,
      rows_with_job_id: rowsWithJob,
      rows_without_job_id: rowsWithoutJob,
      date_range: { earliest, latest },
      payroll_id_count: payrollIds.size,
      payroll_ids: [...payrollIds].sort(),
      by_type: [...typeBuckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([gross_pay_item_type, bucket]) => ({
          gross_pay_item_type,
          count: bucket.count,
          with_paid_hours: bucket.withPaidHours,
          sum_paid_hours: bucket.sumPaidHours,
          sum_amount: bucket.sumAmount,
          paid_time_off_count: bucket.paidTimeOffCount,
          paid_time_off_amount: bucket.paidTimeOffAmount,
        })),
      per_job: [...perJob.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([job_id, count]) => ({ job_id, count })),
      project_rows_job_not_in_list: projectRowsJobNotInList,
      timesheet_time_without_job_id: {
        count: input.grossPay.timesheetTimeWithoutJob.count,
        with_paid_hours: input.grossPay.timesheetTimeWithoutJob.withPaidHours,
      },
      matching_paid_hour_rows: matchingPaidHours,
      project_tech_rows_on_other_jobs: projectTechOtherJobs,
      project_tech_rows_without_job: projectTechWithoutJob,
    },
    job_timesheets: {
      forbidden: input.timesheetsForbidden,
      skipped_canceled_jobs: canceled.size,
      arrived_done_hours: arrivedDone,
      jobs: [...jobSheets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([job_id, sheet]) => ({
          job_id,
          row_count: sheet.rowCount,
          canceled_rows: sheet.canceledRows,
          arrived_done_hours: sheet.arrivedDoneHours,
          paid_duration_rows: sheet.paidDurationRows,
        })),
    },
    project_labor_expense: {
      available: false,
      endpoint: null,
      amount: null,
      reason: PROJECT_LABOR_EXPENSE_UNAVAILABLE,
      service_titan_labor: known,
      delta: null,
    },
    timesheet_burden: {
      endpoint: TIMESHEET_BURDEN_ENDPOINT,
      hours: arrivedDone,
      amount: burden,
      techs_missing_rate: techsMissingRate,
      included_in_labor_hours: false,
      service_titan_labor: known,
      delta: burdenDelta,
      note: "Arrived to done, 14 hour cap, no drive time. Shown next to ServiceTitan Expense > Labor as a difference, not a match.",
    },
    payroll_adjustments: {
      available: input.adjustments.available,
      count: tied.count,
      sum: input.adjustments.available ? tied.sum : null,
      tied_by: tied.tiedBy,
      untied: tied.untied,
      invoices_unread: input.invoicesUnread,
    },
    notes: [
      PROJECT_AGE_RULE,
      "Labor hours stay ServiceTitan gross-pay paid duration. Job-timesheet stamps are used only for burden when payroll has no matching rows.",
      "Dispatch time is not part of labor hours or burden.",
      PROJECT_LABOR_EXPENSE_UNAVAILABLE,
      "Gross pay of every type except paid time off still feeds the reconciliation breakdown when payroll rows exist.",
      "Rows dated before 2022-08-02 are omitted.",
    ],
  };
}

export class StLaborDiagnosticError extends Error {
  constructor(
    readonly kind: "validation" | "conflict" | "source",
    message: string,
  ) {
    super(message);
    this.name = "StLaborDiagnosticError";
  }
}

export interface StLaborDiagnosticClient {
  readProjectJobs?(projectId: string): Promise<
    Array<{ id: string; jobNumber: string; jobStatus: string; createdOn: string | null; completedOn: string | null }>
  >;
  readGrossPayItems?(query: { dateOnOrAfter: string; dateOnOrBefore?: string }): Promise<{
    forbidden: boolean;
    items: GrossPayItem[];
    skipped?: number;
    omitted?: number;
    capped?: boolean;
    pagesRead?: number;
    timesheetTimeWithoutJob?: { count: number; withPaidHours: number };
  }>;
  readJobTimesheetsForJobs?(jobIds: readonly string[]): Promise<{
    forbidden: boolean;
    capped?: boolean;
    timesheets: WorkedTimesheet[];
  }>;
  readJobTimesheets?(jobId: string): Promise<{
    forbidden: boolean;
    timesheets: WorkedTimesheet[];
  }>;
  readTechnicians?(): Promise<Array<{ id: string | number; burdenRate: number | null }>>;
  readPayrollAdjustments?(query: { postedOnOrAfter?: string }): Promise<{
    forbidden: boolean;
    unavailable: boolean;
    items: PayrollAdjustmentRow[];
  }>;
  readInvoicesForJobs?(
    jobIds: readonly string[],
    modifiedSince: string | null,
  ): Promise<{
    forbidden: boolean;
    invoices: Array<{ externalInvoiceId: string }>;
  }>;
}

const TIMESHEET_BATCH = 4;

/**
 * GET-only payroll read for one ServiceTitan project.
 * Job timesheets are requested in one bulk call when the client has it, otherwise four jobs at a time.
 */
export async function readStLaborDiagnostic(
  client: StLaborDiagnosticClient | null | undefined,
  stProjectId: string,
  now = new Date(),
): Promise<StLaborDiagnostic> {
  if (!/^\d+$/.test(stProjectId)) {
    throw new StLaborDiagnosticError("validation", "Use a numeric ServiceTitan project id.");
  }
  if (!client?.readProjectJobs || !client.readGrossPayItems) {
    throw new StLaborDiagnosticError("conflict", "ServiceTitan payroll reads are not configured.");
  }
  let jobs: StLaborDiagnosticJob[];
  try {
    jobs = await client.readProjectJobs(stProjectId);
  } catch (err) {
    throw new StLaborDiagnosticError(
      "source",
      `ServiceTitan jobs: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const window = paidLaborWindowStart(jobs, now.getTime());
  let gross: Awaited<ReturnType<NonNullable<StLaborDiagnosticClient["readGrossPayItems"]>>>;
  try {
    gross = await client.readGrossPayItems({ dateOnOrAfter: window.start });
  } catch (err) {
    throw new StLaborDiagnosticError(
      "source",
      `Payroll gross pay items: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const activeIds = jobs.filter((job) => !isCanceledJobStatus(job.jobStatus)).map((job) => job.id);
  let timesheets: WorkedTimesheet[] = [];
  let timesheetsForbidden = false;
  if (client.readJobTimesheetsForJobs) {
    try {
      const read = await client.readJobTimesheetsForJobs(activeIds);
      timesheetsForbidden = read.forbidden;
      if (!read.forbidden) timesheets = read.timesheets.map((row) => ({ ...row, technicianName: null }));
    } catch (err) {
      throw new StLaborDiagnosticError(
        "source",
        `Payroll job timesheets: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (client.readJobTimesheets) {
    for (let offset = 0; offset < activeIds.length; offset += TIMESHEET_BATCH) {
      const batch = activeIds.slice(offset, offset + TIMESHEET_BATCH);
      const reads = await Promise.all(
        batch.map(async (jobId) => {
          const read = await client.readJobTimesheets!(jobId);
          return { jobId, read };
        }),
      );
      for (const result of reads) {
        if (result.read.forbidden) {
          timesheetsForbidden = true;
          continue;
        }
        timesheets.push(
          ...result.read.timesheets.map((row) => ({
            ...row,
            jobId: row.jobId ?? result.jobId,
            technicianName: null,
          })),
        );
      }
    }
  }
  const burdenRateByTechnician = new Map<string, number | null>();
  if (client.readTechnicians) {
    try {
      for (const tech of await client.readTechnicians()) {
        const id = technicianIdKey(tech.id);
        if (id) burdenRateByTechnician.set(id, tech.burdenRate);
      }
    } catch (err) {
      throw new StLaborDiagnosticError(
        "source",
        `Technicians: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  let adjustments: { available: boolean; items: PayrollAdjustmentRow[] } = { available: false, items: [] };
  if (client.readPayrollAdjustments) {
    try {
      const read = await client.readPayrollAdjustments({ postedOnOrAfter: window.start });
      if (!read.forbidden && !read.unavailable) adjustments = { available: true, items: read.items };
    } catch (err) {
      throw new StLaborDiagnosticError(
        "source",
        `Payroll adjustments: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  let invoiceIds: string[] = [];
  let invoicesUnread = false;
  const needsInvoices = adjustments.items.some((row) => row.invoiceId);
  if (needsInvoices) {
    if (!client.readInvoicesForJobs) {
      invoicesUnread = true;
    } else {
      try {
        const read = await client.readInvoicesForJobs(activeIds, null);
        if (read.forbidden) invoicesUnread = true;
        else invoiceIds = read.invoices.map((row) => row.externalInvoiceId);
      } catch {
        invoicesUnread = true;
      }
    }
  }
  return buildStLaborDiagnostic(
    {
      stProjectId,
      windowStart: window.start,
      jobs,
      grossPay: {
        pagesRead: gross.pagesRead ?? 0,
        capped: gross.capped === true,
        forbidden: gross.forbidden,
        skipped: gross.skipped ?? 0,
        omitted: gross.omitted ?? 0,
        items: gross.items,
        timesheetTimeWithoutJob: gross.timesheetTimeWithoutJob ?? { count: 0, withPaidHours: 0 },
      },
      timesheets,
      timesheetsForbidden,
      burdenRateByTechnician,
      adjustments,
      invoiceIds,
      invoicesUnread,
    },
    now,
  );
}
