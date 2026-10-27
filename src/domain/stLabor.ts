import type { GrossPayItem } from "../adapters/serviceTitan.js";
import { newYorkDate } from "./fieldStart.js";
import { roundMoney } from "./projectFinancials.js";
import { grossPayItemTooOld } from "./grossPay.js";
import { isBeforeSourceFloor } from "./sourceFloor.js";

/** One payroll job-timesheet stretch. Used only for burden, not for labor hours. */
export const STRETCH_CAP_HOURS = 14;

/**
 * Commission used when a project has no matching payroll gross-pay rows.
 * Mason: 25% of billed labor. Not a setting.
 */
export const BILLED_LABOR_COMMISSION_FRACTION = 0.25;

/**
 * A project is recent when it has no non-canceled job created more than this
 * many days before the refresh. Recent projects with no payroll rows are
 * flagged and are not estimated. Dalton's first job is 2024-12-19, so Dalton
 * is older even though its last job completed on 2026-09-11. A last-completion
 * rule of 60 days would skip Dalton. Segreto's jobs are October 2026, inside
 * this window, so Segreto is recent. Jobs with no created date do not make a
 * project older.
 */
export const RECENT_PROJECT_DAYS = 60;

export const COMMISSION_LINE_LABEL = "Commission (25% of billed labor)";
export const BURDEN_LINE_LABEL = "Labor burden";
export const NO_PAYROLL_LABOR_LABEL = "Labor at 25% of billed labor (no payroll data)";
export const RECENT_PAYROLL_MISSING_WARNING =
  "This project's jobs were created within the last 60 days and ServiceTitan payroll returned no paid timesheet hours for them. Labor was not estimated at 25% of billed labor.";

/**
 * ServiceTitan does not expose Project Financials Expense > Labor on a GET.
 * reporting/v2 report-categories and report-category reports only list custom
 * reports. The rows themselves are POST .../reports/{id}/data. This service
 * does not call that. Job and project payloads do not include the figure.
 */
export const PROJECT_LABOR_EXPENSE_UNAVAILABLE =
  "No read-only GET returns Project Financials Expense > Labor. GET reporting/v2/tenant/{tenant}/report-categories and GET reporting/v2/tenant/{tenant}/report-category/{category}/reports only list custom reports. Report rows are POST reporting/v2/tenant/{tenant}/report-category/{category}/reports/{id}/data, which this service does not call. Job and project payloads do not include labor expense.";

/** Burden when payroll gross pay has no paid hours. Arrived to done, 14 hour cap, no drive time. */
export const TIMESHEET_BURDEN_ENDPOINT = "GET payroll/v2/tenant/{tenant}/jobs/timesheets";

export type LaborCostSource = "payroll" | "billed_labor_25pct" | "none_recent_payroll_missing";
export type ProjectPayrollAge = "older" | "recent";

export interface LaborEstimate {
  commission: number;
  burden: number;
  total: number;
  /** Reconciliation billedLabor. Commission is 25% of this figure. */
  billed_labor: number;
  burden_hours: number;
  burden_source: "payroll_job_timesheets_arrived_done";
  label: typeof NO_PAYROLL_LABOR_LABEL;
  commission_label: typeof COMMISSION_LINE_LABEL;
  burden_label: typeof BURDEN_LINE_LABEL;
}

export type HoursPayrollSource = "gross-pay" | "job-timesheet" | "mixed";

export interface WorkedTimesheet {
  id: string;
  jobId?: string | null;
  appointmentId?: string | null;
  technicianId?: string | null;
  technicianName?: string | null;
  arrivedOn?: string | null;
  dispatchedOn?: string | null;
  doneOn?: string | null;
  canceledOn?: string | null;
  paidDurationHours?: number | null;
}

export interface WorkedHours {
  /** arrived → done, or dispatched → done when arrive is missing. Capped at 14h. */
  work: number;
  /** dispatched → arrived. Capped at 14h. Not part of labor hours. */
  drive: number;
}

export interface WorkedTimesheetDraft {
  id: string;
  appointmentId: string | null;
  technicianId: string | null;
  technicianName: string | null;
  workDate: string;
  hours: number;
}

export interface PayrollAdjustmentRow {
  id: string | null;
  employeeId: string | null;
  amount: number | null;
  jobId: string | null;
  invoiceId: string | null;
  postedOn: string | null;
}

export interface StLaborBreakdown {
  /** Worked hours × burden rate. Drive is not included. */
  burden: number;
  workHours: number;
  driveHours: number;
  /** Non-PTO gross pay on the project's jobs, including amount adjustments. */
  grossPay: number;
  /** Null when payroll adjustments could not be read. */
  adjustments: number | null;
  adjustmentsAvailable: boolean;
  total: number;
  hoursSource: HoursPayrollSource | null;
}

export function isCanceledJobStatus(status: string | null | undefined): boolean {
  return /cancel/i.test(status ?? "");
}

export function isPaidTimeOff(item: { paidTimeType?: string | null; type?: string | null }): boolean {
  const paid = (item.paidTimeType ?? "").toLowerCase().replace(/[\s_-]/g, "");
  if (paid === "paidtimeoff" || paid === "pto") return true;
  const type = (item.type ?? "").toLowerCase().replace(/[\s_-]/g, "");
  return type === "paidtimeoff" || type === "pto";
}

/** Hours between two stamps, capped at 14. Zero, backwards, and unreadable stamps are null. */
export function cappedStretchHours(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const hours = (to - from) / 3_600_000;
  if (!(hours > 0)) return null;
  return roundMoney(Math.min(hours, STRETCH_CAP_HOURS));
}

/**
 * Arrived → done only. Dispatch and drive are not hours.
 * Canceled rows and rows before 2022-08-02 are zero. Each stretch is capped at 14 hours.
 */
export function arrivedDoneHours(row: WorkedTimesheet): number {
  if (row.canceledOn) return 0;
  const stamp = row.doneOn || row.arrivedOn;
  if (stamp && isBeforeSourceFloor(stamp)) return 0;
  return cappedStretchHours(row.arrivedOn, row.doneOn) ?? 0;
}

/**
 * Burden for a project whose gross pay has no paid hours.
 * Hours are arrived → done, capped at 14, with no drive time. They are not labor hours.
 */
export function burdenFromArrivedDone(
  rows: readonly WorkedTimesheet[],
  rateByTechnician: ReadonlyMap<string, number | null>,
): { hours: number; burden: number; techsMissingRate: number } {
  const hoursByTech = new Map<string, number>();
  for (const row of rows) {
    const hours = arrivedDoneHours(row);
    if (!(hours > 0)) continue;
    const id = row.technicianId?.trim() || "";
    hoursByTech.set(id, roundMoney((hoursByTech.get(id) ?? 0) + hours));
  }
  let hours = 0;
  let burden = 0;
  let techsMissingRate = 0;
  for (const [id, techHours] of hoursByTech) {
    hours = roundMoney(hours + techHours);
    const rate = id ? rateByTechnician.get(id) : null;
    if (rate == null || !(rate > 0)) {
      techsMissingRate += 1;
      continue;
    }
    burden = roundMoney(burden + roundMoney(techHours * rate));
  }
  return { hours, burden, techsMissingRate };
}

/** Gross-pay TimesheetTime rows with paid hours on these jobs. Paid time off does not count. */
export function countMatchingPaidHourRows(jobIds: readonly string[], items: readonly GrossPayItem[]): number {
  const wanted = new Set(jobIds);
  let count = 0;
  for (const item of items) {
    if (grossPayItemTooOld(item)) continue;
    if (!item.jobId || !wanted.has(item.jobId)) continue;
    if ((item.type ?? "").toLowerCase() !== "timesheettime") continue;
    if (isPaidTimeOff(item)) continue;
    const hours = item.paidDurationHours;
    if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours >= 1000) continue;
    count += 1;
  }
  return count;
}

export function projectPayrollAge(
  jobs: readonly { jobStatus?: string | null; createdOn?: string | null }[],
  nowMs: number,
): ProjectPayrollAge {
  let earliest: number | null = null;
  for (const job of jobs) {
    if (isCanceledJobStatus(job.jobStatus)) continue;
    const created = job.createdOn ? Date.parse(job.createdOn) : NaN;
    if (!Number.isFinite(created)) continue;
    if (earliest == null || created < earliest) earliest = created;
  }
  if (earliest == null) return "recent";
  return nowMs - earliest > RECENT_PROJECT_DAYS * 86_400_000 ? "older" : "recent";
}

/**
 * Payroll when matching paid-hour rows exist.
 * Otherwise the 25% estimate only for an older project.
 * A failed payroll read returns null so the stored source is left alone.
 */
export function chooseLaborCostSource(input: {
  payrollReadSucceeded: boolean;
  matchingPaidHourRows: number;
  age: ProjectPayrollAge;
}): LaborCostSource | null {
  if (!input.payrollReadSucceeded) return null;
  if (input.matchingPaidHourRows > 0) return "payroll";
  if (input.age === "recent") return "none_recent_payroll_missing";
  return "billed_labor_25pct";
}

export function billedLaborCommission(billedLabor: number): number {
  if (!(billedLabor > 0)) return 0;
  return roundMoney(billedLabor * BILLED_LABOR_COMMISSION_FRACTION);
}

/**
 * Commission from the reconciliation's billedLabor.
 * Pass financialsFromReads().billedLabor. Do not sum invoice lines here.
 */
export function laborEstimateFromBilled(input: {
  billedLabor: number;
  burden: number;
  burdenHours: number;
}): LaborEstimate {
  const billedLabor = roundMoney(input.billedLabor);
  const commission = billedLaborCommission(billedLabor);
  const burden = roundMoney(input.burden);
  return {
    commission,
    burden,
    total: roundMoney(commission + burden),
    billed_labor: billedLabor,
    burden_hours: roundMoney(input.burdenHours),
    burden_source: "payroll_job_timesheets_arrived_done",
    label: NO_PAYROLL_LABOR_LABEL,
    commission_label: COMMISSION_LINE_LABEL,
    burden_label: BURDEN_LINE_LABEL,
  };
}

/**
 * Hours worked from a payroll job timesheet.
 * Work is arrived → done. When arrive is missing, work is dispatched → done.
 * Drive is dispatched → arrived and is never added to work.
 * Labor hours do not use this. Burden uses arrivedDoneHours instead.
 */
export function splitTimesheetHours(row: WorkedTimesheet): WorkedHours {
  if (row.canceledOn) return { work: 0, drive: 0 };
  const stamp = row.doneOn || row.arrivedOn || row.dispatchedOn;
  if (stamp && isBeforeSourceFloor(stamp)) return { work: 0, drive: 0 };
  const arrivedWork = cappedStretchHours(row.arrivedOn, row.doneOn);
  const work = arrivedWork ?? cappedStretchHours(row.dispatchedOn, row.doneOn) ?? 0;
  const drive = row.arrivedOn ? (cappedStretchHours(row.dispatchedOn, row.arrivedOn) ?? 0) : 0;
  return { work, drive };
}

/** Labor-hour drafts from payroll job timesheets. Paid duration is not required. Drive is returned separately. */
export function draftsFromWorkedTimesheets(rows: readonly WorkedTimesheet[]): {
  drafts: WorkedTimesheetDraft[];
  driveHours: number;
} {
  const drafts: WorkedTimesheetDraft[] = [];
  let driveHours = 0;
  for (const row of rows) {
    const split = splitTimesheetHours(row);
    driveHours += split.drive;
    if (!(split.work > 0)) continue;
    const stamp = row.doneOn || row.arrivedOn || row.dispatchedOn;
    drafts.push({
      id: row.id,
      appointmentId: row.appointmentId ?? null,
      technicianId: row.technicianId ?? null,
      technicianName: row.technicianName ?? null,
      workDate: stamp ? newYorkDate(stamp) : newYorkDate(new Date().toISOString()),
      hours: split.work,
    });
  }
  return { drafts, driveHours: roundMoney(driveHours) };
}

export function hoursPayrollSource(grossPayJobs: number, timesheetJobs: number): HoursPayrollSource | null {
  if (grossPayJobs > 0 && timesheetJobs > 0) return "mixed";
  if (grossPayJobs > 0) return "gross-pay";
  if (timesheetJobs > 0) return "job-timesheet";
  return null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Dollar figure on one gross-pay row: amount plus amountAdjustment. */
export function grossPayRowDollars(item: { amount?: number | null; amountAdjustment?: number | null }): number {
  const amount = finite(item.amount);
  const adjustment = finite(item.amountAdjustment);
  if (amount == null && adjustment == null) return 0;
  return roundMoney((amount ?? 0) + (adjustment ?? 0));
}

/**
 * Gross pay on the project's jobs, every type except paid time off.
 * TimesheetTime wages, performance pay, and other non-PTO types all count.
 */
export function nonPtoGrossPayOnJobs(jobIds: readonly string[], items: readonly GrossPayItem[]): number {
  const wanted = new Set(jobIds);
  let sum = 0;
  for (const item of items) {
    if (grossPayItemTooOld(item)) continue;
    if (!item.jobId || !wanted.has(item.jobId)) continue;
    if (isPaidTimeOff(item)) continue;
    sum += grossPayRowDollars(item);
  }
  return roundMoney(sum);
}

export function stLaborTotal(burden: number, grossPay: number, adjustments: number | null): number {
  return roundMoney(burden + grossPay + (adjustments ?? 0));
}

export function sumTiedAdjustments(
  items: readonly PayrollAdjustmentRow[],
  scope: { jobIds: readonly string[]; invoiceIds: readonly string[]; technicianIds: readonly string[] },
): { sum: number; count: number; tiedBy: "job-or-invoice" | "technician" | "none"; untied: number } {
  const jobs = new Set(scope.jobIds);
  const invoices = new Set(scope.invoiceIds);
  const techs = new Set(scope.technicianIds);
  const usable = items.filter((row) => {
    if (row.postedOn && isBeforeSourceFloor(row.postedOn)) return false;
    return finite(row.amount) != null;
  });
  const hasJobOrInvoice = usable.some((row) => row.jobId || row.invoiceId);
  if (hasJobOrInvoice) {
    let sum = 0;
    let count = 0;
    let untied = 0;
    for (const row of usable) {
      const onJob = row.jobId != null && jobs.has(row.jobId);
      const onInvoice = row.invoiceId != null && invoices.has(row.invoiceId);
      if (!onJob && !onInvoice) {
        untied += 1;
        continue;
      }
      sum += row.amount ?? 0;
      count += 1;
    }
    return { sum: roundMoney(sum), count, tiedBy: count > 0 ? "job-or-invoice" : "none", untied };
  }
  let sum = 0;
  let count = 0;
  for (const row of usable) {
    if (!row.employeeId || !techs.has(row.employeeId)) continue;
    sum += row.amount ?? 0;
    count += 1;
  }
  return {
    sum: roundMoney(sum),
    count,
    tiedBy: count > 0 ? "technician" : "none",
    untied: usable.length - count,
  };
}

/**
 * Which ServiceTitan labor figure to store.
 * A successful read with rows or hours on this project replaces the stored figure.
 * A failed read, or an empty read of a project that was already stamped, keeps the prior figure.
 * A project that was never stamped does not keep a prior 0.
 * `laborBurden` null means leave the hours × burden rate already on the computed side.
 */
export function chooseStLaborBurden(input: {
  breakdown: StLaborBreakdown | null;
  projectGrossPayRows: number;
  previouslyStamped: boolean;
  priorBurden: number | null;
}): { laborBurden: number | null; carriedPrior: boolean; breakdown: StLaborBreakdown | null } {
  const signal =
    input.breakdown != null &&
    (input.projectGrossPayRows > 0 ||
      input.breakdown.workHours > 0 ||
      input.breakdown.grossPay !== 0 ||
      (input.breakdown.adjustments ?? 0) !== 0);
  if (input.breakdown && (signal || !input.previouslyStamped)) {
    return { laborBurden: input.breakdown.total, carriedPrior: false, breakdown: input.breakdown };
  }
  if (input.previouslyStamped && input.priorBurden != null) {
    return { laborBurden: input.priorBurden, carriedPrior: true, breakdown: null };
  }
  return { laborBurden: null, carriedPrior: false, breakdown: null };
}
