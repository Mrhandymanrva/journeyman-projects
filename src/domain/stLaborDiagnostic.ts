import type { GrossPayItem } from "../adapters/serviceTitan.js";
import { technicianIdKey } from "./commissionLabor.js";
import { grossPayItemTooOld } from "./grossPay.js";
import { PAID_LABOR_LOOKBACK_DAYS } from "./laborActuals.js";
import { publishedServiceTitanLabor, roundMoney } from "./projectFinancials.js";
import { sourceWindowStart } from "./sourceFloor.js";
import {
  BURDEN_MATCH_DOLLARS,
  BURDEN_UNAVAILABLE_LABEL,
  POSTED_COMMISSION_LABEL,
  PROJECT_LABOR_EXPENSE_UNAVAILABLE,
  RECENT_PROJECT_DAYS,
  TIMESHEET_BURDEN_ENDPOINT,
  appointmentHourSlices,
  arrivedDoneHours,
  burdenComparisonTarget,
  burdenDollarsFromHours,
  cappedStretchHours,
  chooseLaborCostSource,
  countMatchingPaidHourRows,
  grossPayRowDollars,
  isCanceledJobStatus,
  isInvoiceRelatedBonus,
  isPaidTimeOff,
  postedInvoiceRelatedBonus,
  projectJobDates,
  projectPayrollAge,
  shiftHoursOnJobDates,
  sumTiedAdjustments,
  type BurdenCandidateRead,
  type LaborCostSource,
  type PayrollAdjustmentRow,
  type TechHourSlice,
  type WorkedTimesheet,
} from "./stLabor.js";
import {
  activityBurdenReport,
  commissionBreakdown,
  projectDateRange,
  splitProjectAdjustments,
  type ActivityBurdenReport,
  type ActivityEvent,
  type CommissionBreakdown,
  type PayrollPeriodFact,
  type TechnicianAdjustmentReport,
} from "./stLaborDiagnosticDetail.js";

export const ST_LABOR_MATCH_DOLLARS = 1;

export interface StLaborDiagnosticJob {
  id: string;
  jobStatus?: string | null;
  createdOn?: string | null;
  completedOn?: string | null;
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
  /** Absent when the caller did not run the extra GET search. Those candidates are reported as not read. */
  candidates?: BurdenCandidateRead | null;
  /** Payroll period status for commission rows. Absent when that GET was not run. */
  payrollPeriods?: { available: boolean; periods: readonly PayrollPeriodFact[]; note: string | null } | null;
  /** Job-history and appointment status events. Absent when that GET was not run. */
  activityEvents?: { available: boolean; events: readonly ActivityEvent[]; note: string | null } | null;
}

export const PROJECT_AGE_RULE =
  "Project age is informational and does not choose commission. A project is older when its earliest non-canceled job was created more than 60 days before the read. Otherwise it is recent, including when created dates are missing. Commission is posted InvoiceRelatedBonus when those rows exist, and 25% of reconciled billed labor when they do not.";

export interface BurdenCandidateReport {
  id: string;
  endpoint: string;
  available: boolean;
  hours: number | null;
  amount: number | null;
  techs_missing_rate: number | null;
  comparison_basis: "st_labor_minus_posted_commission" | "st_labor_burden_only" | "none";
  comparison_amount: number | null;
  delta: number | null;
  matches: boolean;
  included_in_burden: false;
  note: string;
}

export interface StLaborDiagnostic {
  st_project_id: string;
  generated_at: string;
  window_start: string;
  known_service_titan_labor: number | null;
  project_age: "older" | "recent";
  recent_window_days: number;
  age_rule: string;
  labor_source: LaborCostSource | null;
  posted_commission: {
    rows: number;
    amount: number;
    label: string;
  };
  live_burden: {
    available: false;
    amount: null;
    label: string;
    included_in_total: false;
    note: string;
  };
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
    included_in_burden: false;
    service_titan_labor: number | null;
    comparison_basis: BurdenCandidateReport["comparison_basis"];
    comparison_amount: number | null;
    delta: number | null;
    note: string;
  };
  burden_comparison: {
    basis: BurdenCandidateReport["comparison_basis"];
    amount: number | null;
    note: string;
  };
  burden_candidates: BurdenCandidateReport[];
  /** Candidate ids whose dollars are within $1 of the comparison. None of them is the live burden. */
  burden_candidate_matches: string[];
  payroll_adjustments: {
    available: boolean;
    count: number;
    sum: number | null;
    tied_by: "job-or-invoice" | "technician" | "none";
    untied: number;
    invoices_unread: boolean;
  };
  /** Posted InvoiceRelatedBonus grouped by month, payroll, and finalized. Diagnostic only. */
  commission_breakdown: CommissionBreakdown;
  /** Arrived or working to done, with paused-to-resumed gaps removed. Diagnostic only. */
  activity_burden: ActivityBurdenReport;
  /** Adjustments tied to this project's jobs, and untied adjustments for its technicians. */
  technician_adjustments: TechnicianAdjustmentReport;
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
  const posted = input.grossPay.forbidden
    ? { rows: 0, amount: 0 }
    : postedInvoiceRelatedBonus(jobIds, input.grossPay.items);
  const laborSource = chooseLaborCostSource({
    payrollReadSucceeded: !input.grossPay.forbidden,
    postedCommissionRows: posted.rows,
  });
  const comparison = burdenComparisonTarget({ knownLabor: known, postedCommission: posted.amount });

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
  const burdenDelta = comparison.amount == null ? null : roundMoney(burden - comparison.amount);
  const activeJobIds = new Set(jobIds.filter((id) => !canceled.has(id)));
  const candidates = burdenCandidateReports({
    input,
    activeJobIds,
    rates: input.burdenRateByTechnician,
    comparison,
    timesheetSlices: [...hoursByTech.entries()].map(([technicianId, hours]) => ({ technicianId, hours })),
  });
  const tied = sumTiedAdjustments(input.adjustments.items, {
    jobIds,
    invoiceIds: input.invoiceIds,
    technicianIds: [],
  });
  const range = projectDateRange(input.jobs, generatedAt.toISOString());
  const breakdown = commissionBreakdown({
    jobIds,
    items: input.grossPay.forbidden ? [] : input.grossPay.items,
    periods: input.payrollPeriods?.periods ?? [],
    payrollStatusAvailable: input.payrollPeriods?.available === true,
    knownLabor: known,
  });
  const activity = activityBurdenReport({
    available: input.activityEvents?.available === true,
    events: input.activityEvents?.events ?? [],
    activeJobIds,
    rates: input.burdenRateByTechnician,
    residuals: breakdown.residuals,
    note: input.activityEvents?.note ?? null,
  });
  const technicianAdjustments = splitProjectAdjustments({
    available: input.adjustments.available,
    items: input.adjustments.items,
    jobIds: jobSet,
    technicianIds: projectTechs,
    rangeStart: range.start,
    rangeEnd: range.end,
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
    posted_commission: {
      rows: posted.rows,
      amount: posted.amount,
      label: POSTED_COMMISSION_LABEL,
    },
    live_burden: {
      available: false,
      amount: null,
      label: BURDEN_UNAVAILABLE_LABEL,
      included_in_total: false,
      note: "No burden source is approved. Candidates below are not used as burden.",
    },
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
      included_in_burden: false,
      service_titan_labor: known,
      comparison_basis: comparison.basis,
      comparison_amount: comparison.amount,
      delta: burdenDelta,
      note: "Arrived to done, 14 hour cap. A candidate only, not the labor burden, and not a match.",
    },
    burden_comparison: comparison,
    burden_candidates: candidates,
    burden_candidate_matches: candidates.filter((row) => row.matches).map((row) => row.id),
    payroll_adjustments: {
      available: input.adjustments.available,
      count: tied.count,
      sum: input.adjustments.available ? tied.sum : null,
      tied_by: tied.tiedBy,
      untied: tied.untied,
      invoices_unread: input.invoicesUnread,
    },
    commission_breakdown: breakdown,
    activity_burden: activity,
    technician_adjustments: technicianAdjustments,
    notes: [
      PROJECT_AGE_RULE,
      "Commission is the sum of InvoiceRelatedBonus on the project's jobs. When none exist, commission is 25% of reconciled billed labor.",
      "Burden is not available from ServiceTitan. Job-timesheet hours are not used as burden.",
      "Burden candidates are aggregates only. A match within $1 is reported and is not adopted.",
      PROJECT_LABOR_EXPENSE_UNAVAILABLE,
      "Rows dated before 2022-08-02 are omitted. Paid time off is excluded from posted commission.",
      "commission_breakdown, activity_burden, and technician_adjustments are diagnostic aggregates. They do not change labor, commission, or burden.",
    ],
  };
}

function burdenCandidateReports(input: {
  input: StLaborDiagnosticRead;
  activeJobIds: ReadonlySet<string>;
  rates: ReadonlyMap<string, number | null>;
  comparison: ReturnType<typeof burdenComparisonTarget>;
  timesheetSlices: TechHourSlice[];
}): BurdenCandidateReport[] {
  const read = input.input.candidates;
  const appointmentStamps = (read?.appointments.appointments ?? []).flatMap((row) => [row.start, row.end]);
  const timesheetStamps = input.input.timesheets.flatMap((row) => [row.arrivedOn, row.doneOn]);
  const jobDates = new Set(projectJobDates(input.input.jobs, [...appointmentStamps, ...timesheetStamps]));
  const technicianIds = new Set<string>();
  for (const item of input.input.grossPay.items) {
    if (item.technicianId && item.jobId && input.activeJobIds.has(item.jobId)) technicianIds.add(item.technicianId);
  }
  for (const row of input.input.timesheets) {
    if (row.technicianId && row.jobId && input.activeJobIds.has(row.jobId)) technicianIds.add(row.technicianId);
  }
  for (const row of read?.assignments.assignments ?? []) {
    if (row.technicianId) technicianIds.add(row.technicianId);
  }

  const grossPaid: TechHourSlice[] = [];
  const grossClock: TechHourSlice[] = [];
  for (const item of input.input.grossPay.items) {
    if (input.input.grossPay.forbidden) break;
    if (!item.jobId || !input.activeJobIds.has(item.jobId)) continue;
    if (isPaidTimeOff(item)) continue;
    if (typeof item.paidDurationHours === "number" && item.paidDurationHours > 0 && item.paidDurationHours < 1000) {
      grossPaid.push({ technicianId: item.technicianId, hours: roundMoney(Math.min(item.paidDurationHours, 14)) });
    }
    const clock = cappedStretchHours(item.startedOn, item.endedOn);
    if (clock != null) grossClock.push({ technicianId: item.technicianId, hours: clock });
  }

  const appointmentHours = appointmentHourSlices({
    assignments: read?.assignments.assignments ?? [],
    appointments: read?.appointments.appointments ?? [],
    jobIds: input.activeJobIds,
  });
  const shiftSlices = shiftHoursOnJobDates({
    shifts: read?.technician_shifts.shifts ?? [],
    technicianIds,
    jobDates,
  });

  const reports: BurdenCandidateReport[] = [
    priceCandidate({
      id: "payroll_job_timesheets",
      endpoint: TIMESHEET_BURDEN_ENDPOINT,
      available: !input.input.timesheetsForbidden,
      slices: input.timesheetSlices,
      rates: input.rates,
      comparison: input.comparison,
      note: input.input.timesheetsForbidden
        ? "Payroll job timesheets were denied."
        : "Arrived to done, 14 hour cap. Not used as the labor burden.",
    }),
    priceCandidate({
      id: "gross_pay_paid_duration",
      endpoint: "GET payroll/v2/tenant/{tenant}/gross-pay-items",
      available: !input.input.grossPay.forbidden,
      slices: grossPaid,
      rates: input.rates,
      comparison: input.comparison,
      note: "Paid duration on the project's jobs, excluding paid time off. Not used as the labor burden.",
    }),
    priceCandidate({
      id: "gross_pay_started_ended",
      endpoint: "GET payroll/v2/tenant/{tenant}/gross-pay-items",
      available: !input.input.grossPay.forbidden,
      slices: grossClock,
      rates: input.rates,
      comparison: input.comparison,
      note: "Started-to-ended duration on gross-pay rows for the project's jobs. Not used as the labor burden.",
    }),
    priceCandidate({
      id: "technician_shifts",
      endpoint: read?.technician_shifts.endpoint ?? "GET dispatch/v2/tenant/{tenant}/technician-shifts",
      available: read?.technician_shifts.available === true,
      slices: shiftSlices,
      rates: input.rates,
      comparison: input.comparison,
      note: read?.technician_shifts.note ?? (read ? "Shifts for project technicians on project job dates." : "Technician shifts were not read."),
    }),
    priceCandidate({
      id: "appointment_assignments",
      endpoint: read?.assignments.endpoint ?? "GET dispatch/v2/tenant/{tenant}/appointment-assignments",
      available: read?.assignments.available === true && read?.appointments.available === true,
      slices: appointmentHours.scheduled,
      rates: input.rates,
      comparison: input.comparison,
      note: "Assigned technician, appointment start to end, 14 hour cap. Not used as the labor burden.",
    }),
    priceCandidate({
      id: "appointment_arrival_windows",
      endpoint: read?.appointments.endpoint ?? "GET jpm/v2/tenant/{tenant}/appointments",
      available: read?.appointments.available === true && read?.assignments.available === true,
      slices: appointmentHours.arrivalWindow,
      rates: input.rates,
      comparison: input.comparison,
      note: "Assigned technician, arrival window start to end, 14 hour cap. Not used as the labor burden.",
    }),
    priceCandidate({
      id: "appointments",
      endpoint: read?.appointments.endpoint ?? "GET jpm/v2/tenant/{tenant}/appointments",
      available: read?.appointments.available === true,
      slices: appointmentHours.appointmentOnly,
      rates: input.rates,
      comparison: input.comparison,
      hoursOnly: true,
      note: "Appointment start to end with no technician, so the burden rate is not applied. Not used as the labor burden.",
    }),
  ];
  const probes = read?.payroll_probes ?? [
    {
      id: "payroll_timesheet_codes" as const,
      endpoint: "GET payroll/v2/tenant/{tenant}/timesheet-codes",
      available: false,
      hours_applicable: false,
      slices: [],
      note: "Timesheet codes were not read.",
    },
    {
      id: "payroll_non_job_timesheets" as const,
      endpoint: "GET payroll/v2/tenant/{tenant}/non-job-timesheets",
      available: false,
      hours_applicable: true,
      slices: [],
      note: "Non-job timesheets were not read.",
    },
    {
      id: "payroll_activity_codes" as const,
      endpoint: "GET payroll/v2/tenant/{tenant}/activity-codes",
      available: false,
      hours_applicable: false,
      slices: [],
      note: "Activity codes were not read.",
    },
  ];
  for (const probe of probes) {
    reports.push(
      priceCandidate({
        id: probe.id,
        endpoint: probe.endpoint,
        available: probe.available,
        slices: probe.hours_applicable ? probe.slices : [],
        rates: input.rates,
        comparison: input.comparison,
        hoursOnly: probe.available && !probe.hours_applicable,
        note: probe.note,
      }),
    );
  }
  return reports;
}

function priceCandidate(input: {
  id: string;
  endpoint: string;
  available: boolean;
  slices: readonly TechHourSlice[];
  rates: ReadonlyMap<string, number | null>;
  comparison: ReturnType<typeof burdenComparisonTarget>;
  note: string;
  hoursOnly?: boolean;
}): BurdenCandidateReport {
  if (!input.available) {
    return {
      id: input.id,
      endpoint: input.endpoint,
      available: false,
      hours: null,
      amount: null,
      techs_missing_rate: null,
      comparison_basis: input.comparison.basis,
      comparison_amount: input.comparison.amount,
      delta: null,
      matches: false,
      included_in_burden: false,
      note: input.note,
    };
  }
  if (input.hoursOnly) {
    const hours = roundMoney(input.slices.reduce((sum, slice) => sum + (slice.hours > 0 ? slice.hours : 0), 0));
    return {
      id: input.id,
      endpoint: input.endpoint,
      available: true,
      hours,
      amount: null,
      techs_missing_rate: null,
      comparison_basis: input.comparison.basis,
      comparison_amount: input.comparison.amount,
      delta: null,
      matches: false,
      included_in_burden: false,
      note: input.note,
    };
  }
  const priced = burdenDollarsFromHours(input.slices, input.rates);
  const delta = input.comparison.amount == null ? null : roundMoney(priced.amount - input.comparison.amount);
  return {
    id: input.id,
    endpoint: input.endpoint,
    available: true,
    hours: priced.hours,
    amount: priced.amount,
    techs_missing_rate: priced.techsMissingRate,
    comparison_basis: input.comparison.basis,
    comparison_amount: input.comparison.amount,
    delta,
    matches: delta != null && Math.abs(delta) <= BURDEN_MATCH_DOLLARS,
    included_in_burden: false,
    note: input.note,
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
  readBurdenCandidates?(input: {
    jobIds: readonly string[];
    technicianIds: readonly string[];
    startsOnOrAfter: string;
    endsOnOrBefore: string;
  }): Promise<BurdenCandidateRead>;
  readPayrollPeriods?(ids: readonly string[]): Promise<{
    available: boolean;
    periods: PayrollPeriodFact[];
    note: string | null;
  }>;
  readJobActivity?(jobIds: readonly string[]): Promise<{
    available: boolean;
    events: ActivityEvent[];
    note: string | null;
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
  const technicianIds = new Set<string>();
  for (const item of gross.items) {
    if (item.technicianId && item.jobId && activeIds.includes(item.jobId)) technicianIds.add(item.technicianId);
  }
  for (const row of timesheets) {
    if (row.technicianId && row.jobId && activeIds.includes(row.jobId)) technicianIds.add(row.technicianId);
  }
  let candidates: BurdenCandidateRead | null = null;
  if (client.readBurdenCandidates) {
    try {
      candidates = await client.readBurdenCandidates({
        jobIds: activeIds,
        technicianIds: [...technicianIds],
        startsOnOrAfter: window.start,
        endsOnOrBefore: now.toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      candidates = {
        technician_shifts: {
          available: false,
          endpoint: "GET dispatch/v2/tenant/{tenant}/technician-shifts",
          shifts: [],
          note: `Technician shifts: ${message}`,
        },
        appointments: {
          available: false,
          endpoint: "GET jpm/v2/tenant/{tenant}/appointments",
          appointments: [],
          note: message,
        },
        assignments: {
          available: false,
          endpoint: "GET dispatch/v2/tenant/{tenant}/appointment-assignments",
          assignments: [],
          note: message,
        },
        payroll_probes: [],
      };
    }
  }
  const projectJobIds = new Set(jobs.map((job) => job.id));
  const payrollIds = [
    ...new Set(
      gross.forbidden
        ? []
        : gross.items
            .filter(
              (item) =>
                item.payrollId &&
                item.jobId &&
                projectJobIds.has(item.jobId) &&
                !grossPayItemTooOld(item) &&
                isInvoiceRelatedBonus(item) &&
                !isPaidTimeOff(item),
            )
            .map((item) => item.payrollId as string),
    ),
  ];
  let payrollPeriods: { available: boolean; periods: PayrollPeriodFact[]; note: string | null } | null = null;
  if (client.readPayrollPeriods) {
    try {
      payrollPeriods = await client.readPayrollPeriods(payrollIds);
    } catch (err) {
      payrollPeriods = {
        available: false,
        periods: [],
        note: err instanceof Error ? err.message : String(err),
      };
    }
  }
  let activityEvents: { available: boolean; events: ActivityEvent[]; note: string | null } | null = null;
  if (client.readJobActivity) {
    try {
      activityEvents = await client.readJobActivity(activeIds);
    } catch (err) {
      activityEvents = {
        available: false,
        events: [],
        note: err instanceof Error ? err.message : String(err),
      };
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
      candidates,
      payrollPeriods,
      activityEvents,
    },
    now,
  );
}
