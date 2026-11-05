/**
 * Aggregate-only extras for the ServiceTitan labor diagnostic.
 * Nothing here is used to price labor, commission, or burden.
 */
import type { GrossPayItem } from "../adapters/serviceTitan.js";
import { grossPayItemTooOld } from "./grossPay.js";
import { roundMoney } from "./projectFinancials.js";
import { isBeforeSourceFloor, SOURCE_RECORD_MIN_DAY } from "./sourceFloor.js";
import {
  STRETCH_CAP_HOURS,
  burdenComparisonTarget,
  burdenDollarsFromHours,
  grossPayRowDollars,
  isCanceledJobStatus,
  isInvoiceRelatedBonus,
  isPaidTimeOff,
  type PayrollAdjustmentRow,
  type TechHourSlice,
} from "./stLabor.js";

export type ActivityKind = "arrived" | "working" | "paused" | "resumed" | "done";
export type FinalizedFlag = "yes" | "no" | "unknown";

export interface PayrollPeriodFact {
  id: string;
  status: string | null;
  startedOn: string | null;
  endedOn: string | null;
  approvedOn: string | null;
}

export interface ActivityEvent {
  jobId: string;
  appointmentId: string | null;
  technicianId: string | null;
  at: string;
  kind: ActivityKind;
}

export interface CountTotal {
  count: number;
  total: number;
}

export interface CommissionPayrollGroup {
  payroll_id: string | null;
  status: string | null;
  finalized: FinalizedFlag;
  period_start: string | null;
  period_end: string | null;
  close_at: string | null;
  count: number;
  total: number;
  /** Null when this payroll has no close timestamp. */
  on_or_before_close: CountTotal | null;
  after_close: CountTotal | null;
}

export interface CommissionResidual {
  subset: string;
  commission_count: number;
  commission_total: number;
  basis: "st_labor_minus_posted_commission" | "st_labor_burden_only" | "none";
  burden_target: number | null;
  note: string;
}

export interface CommissionBreakdown {
  rows: number;
  total: number;
  earliest: string | null;
  latest: string | null;
  by_month: Array<{ month: string; count: number; total: number }>;
  by_payroll: CommissionPayrollGroup[];
  by_finalized: Array<{ finalized: FinalizedFlag; count: number; total: number }>;
  /** ServiceTitan labor minus this subset when the subset is below that labor. Otherwise the labor figure itself. */
  residuals: CommissionResidual[];
  payroll_status_available: boolean;
  note: string;
}

export interface ActivityBurdenReport {
  source: "job_history_and_appointment_status";
  endpoint: string;
  available: boolean;
  hours: number | null;
  amount: number | null;
  techs_missing_rate: number | null;
  span_count: number;
  pause_gaps_removed: number;
  spans_capped: number;
  open_spans_ignored: number;
  cap_hours: number;
  drive_included: false;
  included_in_burden: false;
  gaps: Array<{
    subset: string;
    burden_target: number | null;
    delta: number | null;
  }>;
  note: string;
}

export interface TechnicianAdjustmentReport {
  available: boolean;
  project_date_start: string | null;
  project_date_end: string | null;
  tied_to_project_jobs: CountTotal | null;
  /** No job id, technician worked this project's jobs, posted inside the project date range. */
  untied_for_project_techs: CountTotal | null;
  note: string;
}

const ACTIVITY_ENDPOINT = "GET jpm/v2/tenant/{tenant}/jobs/{id}/history";

function norm(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[\s_-]/g, "");
}

/** Working or arrived starts work. Dispatch does not. Paused-to-resumed is not work. */
export function classifyActivityEvent(input: {
  eventType?: string | null;
  status?: string | null;
  memo?: string | null;
}): ActivityKind | null {
  const parts = [input.eventType, input.status, input.memo].map(norm).filter(Boolean);
  const text = parts.join(" ");
  if (!text) return null;
  if (/dispatch/.test(text) && !/arriv|working|paused|resum|done|complet/.test(text)) return null;
  if (/resum/.test(text)) return "resumed";
  if (/paus|onhold|\bhold\b/.test(text) || norm(input.status) === "hold") return "paused";
  if (/arriv/.test(text)) return "arrived";
  if (/working|inprogress/.test(text)) return "working";
  if (/done|complet/.test(text)) return "done";
  return null;
}

const NEGATIVE_PAYROLL_STATUS =
  /unapproved|notapproved|disapproved|needsapproval|unfinalized|unposted|notposted|pending|draft|processing|inprogress/;

/** Approved, paid, locked, or otherwise closed. "Unapproved" is not approved. */
export function payrollFinalized(period: PayrollPeriodFact | undefined): FinalizedFlag {
  if (!period) return "unknown";
  const status = norm(period.status);
  const withoutNegatives = status.replace(
    /unapproved|notapproved|disapproved|needsapproval|unfinalized|unposted|notposted/g,
    "",
  );
  if (/approved|paid|locked|final|posted|closed|exported|synced/.test(withoutNegatives)) return "yes";
  if (period.approvedOn && !isBeforeSourceFloor(period.approvedOn)) return "yes";
  if (NEGATIVE_PAYROLL_STATUS.test(status) || status === "open" || status === "active" || status === "inactive") {
    return "no";
  }
  return "unknown";
}

function payrollClose(period: PayrollPeriodFact | undefined): string | null {
  if (!period) return null;
  return period.endedOn || period.approvedOn || null;
}

function monthOf(stamp: string | null): string | null {
  if (!stamp) return null;
  const day = /^(\d{4}-\d{2})/.exec(stamp)?.[1];
  if (day) return day;
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 7);
}

function onOrBefore(stamp: string | null, close: string | null): boolean | null {
  if (!stamp || !close) return null;
  const left = Date.parse(stamp);
  const right = Date.parse(close);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return left <= right;
}

function earlierStamp(current: string | null, next: string): string {
  if (!current) return next;
  const left = Date.parse(current);
  const right = Date.parse(next);
  if (Number.isFinite(left) && Number.isFinite(right)) return right < left ? next : current;
  return next < current ? next : current;
}

function laterStamp(current: string | null, next: string): string {
  if (!current) return next;
  const left = Date.parse(current);
  const right = Date.parse(next);
  if (Number.isFinite(left) && Number.isFinite(right)) return right > left ? next : current;
  return next > current ? next : current;
}

function addCount(bucket: CountTotal, amount: number): void {
  bucket.count += 1;
  bucket.total = roundMoney(bucket.total + amount);
}

interface PostedRow {
  date: string | null;
  payrollId: string | null;
  amount: number;
}

function postedRows(jobIds: readonly string[], items: readonly GrossPayItem[]): PostedRow[] {
  const wanted = new Set(jobIds);
  const rows: PostedRow[] = [];
  for (const item of items) {
    if (grossPayItemTooOld(item)) continue;
    if (!item.jobId || !wanted.has(item.jobId)) continue;
    if (!isInvoiceRelatedBonus(item)) continue;
    if (isPaidTimeOff(item)) continue;
    rows.push({
      date: item.date ?? item.startedOn ?? null,
      payrollId: item.payrollId ?? null,
      amount: grossPayRowDollars(item),
    });
  }
  return rows;
}

function residualFor(subset: string, count: number, total: number, knownLabor: number | null): CommissionResidual {
  const target = burdenComparisonTarget({ knownLabor, postedCommission: total });
  return {
    subset,
    commission_count: count,
    commission_total: total,
    basis: target.basis,
    burden_target: target.amount,
    note: target.note,
  };
}

/**
 * Posted InvoiceRelatedBonus on the project's jobs, grouped for comparison with ServiceTitan labor.
 * Same row filter as posted commission. Not a second commission calculation for the labor card.
 */
export function commissionBreakdown(input: {
  jobIds: readonly string[];
  items: readonly GrossPayItem[];
  periods: readonly PayrollPeriodFact[];
  payrollStatusAvailable: boolean;
  knownLabor: number | null;
}): CommissionBreakdown {
  const rows = postedRows(input.jobIds, input.items);
  const periods = new Map(input.periods.map((period) => [period.id, period]));
  const byMonth = new Map<string, CountTotal>();
  const byPayroll = new Map<string, PostedRow[]>();
  const byFinalized = new Map<FinalizedFlag, CountTotal>();
  let earliest: string | null = null;
  let latest: string | null = null;
  let total = 0;
  for (const row of rows) {
    total = roundMoney(total + row.amount);
    if (row.date && !isBeforeSourceFloor(row.date)) {
      earliest = earlierStamp(earliest, row.date);
      latest = laterStamp(latest, row.date);
    }
    const month = monthOf(row.date) ?? "unknown";
    const monthBucket = byMonth.get(month) ?? { count: 0, total: 0 };
    addCount(monthBucket, row.amount);
    byMonth.set(month, monthBucket);
    const key = row.payrollId ?? "";
    const list = byPayroll.get(key) ?? [];
    list.push(row);
    byPayroll.set(key, list);
    const flag = payrollFinalized(row.payrollId ? periods.get(row.payrollId) : undefined);
    const flagBucket = byFinalized.get(flag) ?? { count: 0, total: 0 };
    addCount(flagBucket, row.amount);
    byFinalized.set(flag, flagBucket);
  }
  const payrollGroups: CommissionPayrollGroup[] = [...byPayroll.entries()]
    .map(([key, group]) => {
      const period = key ? periods.get(key) : undefined;
      const close = payrollClose(period);
      let before: CountTotal | null = close ? { count: 0, total: 0 } : null;
      let after: CountTotal | null = close ? { count: 0, total: 0 } : null;
      let groupTotal = 0;
      let compared = 0;
      for (const row of group) {
        groupTotal = roundMoney(groupTotal + row.amount);
        const side = onOrBefore(row.date, close);
        if (side == null || !before || !after) continue;
        compared += 1;
        addCount(side ? before : after, row.amount);
      }
      if (compared === 0) {
        before = null;
        after = null;
      }
      return {
        payroll_id: key || null,
        status: period?.status ?? null,
        finalized: payrollFinalized(period),
        period_start: period?.startedOn ?? null,
        period_end: period?.endedOn ?? null,
        close_at: close,
        count: group.length,
        total: groupTotal,
        on_or_before_close: before,
        after_close: after,
      };
    })
    .sort((a, b) => (a.payroll_id ?? "").localeCompare(b.payroll_id ?? ""));
  const finalizedGroups = (["yes", "no", "unknown"] as const)
    .map((finalized) => ({ finalized, ...(byFinalized.get(finalized) ?? { count: 0, total: 0 }) }))
    .filter((row) => row.count > 0);
  const residuals: CommissionResidual[] = [
    residualFor("all_posted", rows.length, total, input.knownLabor),
  ];
  for (const group of finalizedGroups) {
    residuals.push(
      residualFor(
        group.finalized === "yes" ? "finalized" : group.finalized === "no" ? "not_finalized" : "finalized_unknown",
        group.count,
        group.total,
        input.knownLabor,
      ),
    );
  }
  for (const group of payrollGroups) {
    if (!group.payroll_id) continue;
    residuals.push(residualFor(`payroll:${group.payroll_id}`, group.count, group.total, input.knownLabor));
  }
  for (const [month, bucket] of [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    residuals.push(residualFor(`month:${month}`, bucket.count, bucket.total, input.knownLabor));
  }
  return {
    rows: rows.length,
    total: roundMoney(total),
    earliest,
    latest,
    by_month: [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, bucket]) => ({ month, count: bucket.count, total: bucket.total })),
    by_payroll: payrollGroups,
    by_finalized: finalizedGroups,
    residuals,
    payroll_status_available: input.payrollStatusAvailable,
    note: "Groups are the posted InvoiceRelatedBonus rows on this project's jobs. Compare each residual with ServiceTitan labor to see which subset that labor figure might include. This does not change the commission line.",
  };
}

/**
 * Working time from arrived or working through done, with each paused gap removed.
 * The next resumed, arrived, or working event ends the gap. Dispatch is not a start.
 * Each span is capped at 14 hours. Open spans are not counted.
 */
export function pausedGapHours(events: readonly ActivityEvent[], activeJobIds: ReadonlySet<string>): {
  slices: TechHourSlice[];
  spanCount: number;
  pausesRemoved: number;
  spansCapped: number;
  openIgnored: number;
} {
  const groups = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    if (!activeJobIds.has(event.jobId)) continue;
    if (isBeforeSourceFloor(event.at)) continue;
    const key = `${event.technicianId ?? ""}|${event.jobId}|${event.appointmentId ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }
  const slices: TechHourSlice[] = [];
  let spanCount = 0;
  let pausesRemoved = 0;
  let spansCapped = 0;
  let openIgnored = 0;
  for (const list of groups.values()) {
    const ordered = [...list].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let openStart: string | null = null;
    let paused = false;
    const tech = ordered[0]?.technicianId ?? null;
    const close = (end: string) => {
      if (!openStart) return;
      const from = Date.parse(openStart);
      const to = Date.parse(end);
      openStart = null;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
      const raw = (to - from) / 3_600_000;
      if (!(raw > 0)) return;
      if (raw > STRETCH_CAP_HOURS) spansCapped += 1;
      slices.push({ technicianId: tech, hours: roundMoney(Math.min(raw, STRETCH_CAP_HOURS)) });
      spanCount += 1;
    };
    for (const event of ordered) {
      if (event.kind === "arrived" || event.kind === "working") {
        if (paused) paused = false;
        if (!openStart) openStart = event.at;
        continue;
      }
      if (event.kind === "paused") {
        if (openStart) {
          close(event.at);
          pausesRemoved += 1;
        }
        paused = true;
        continue;
      }
      if (event.kind === "resumed") {
        paused = false;
        if (!openStart) openStart = event.at;
        continue;
      }
      if (event.kind === "done") {
        if (openStart && !paused) close(event.at);
        openStart = null;
        paused = false;
      }
    }
    if (openStart) openIgnored += 1;
  }
  return { slices, spanCount, pausesRemoved, spansCapped, openIgnored };
}

export function activityBurdenReport(input: {
  available: boolean;
  events: readonly ActivityEvent[];
  activeJobIds: ReadonlySet<string>;
  rates: ReadonlyMap<string, number | null>;
  residuals: readonly CommissionResidual[];
  note: string | null;
}): ActivityBurdenReport {
  if (!input.available) {
    return {
      source: "job_history_and_appointment_status",
      endpoint: ACTIVITY_ENDPOINT,
      available: false,
      hours: null,
      amount: null,
      techs_missing_rate: null,
      span_count: 0,
      pause_gaps_removed: 0,
      spans_capped: 0,
      open_spans_ignored: 0,
      cap_hours: STRETCH_CAP_HOURS,
      drive_included: false,
      included_in_burden: false,
      gaps: input.residuals.map((row) => ({
        subset: row.subset,
        burden_target: row.burden_target,
        delta: null,
      })),
      note: input.note ?? "Job history was not read. This does not change the burden line.",
    };
  }
  const spans = pausedGapHours(input.events, input.activeJobIds);
  const priced = burdenDollarsFromHours(spans.slices, input.rates);
  return {
    source: "job_history_and_appointment_status",
    endpoint: ACTIVITY_ENDPOINT,
    available: true,
    hours: priced.hours,
    amount: priced.amount,
    techs_missing_rate: priced.techsMissingRate,
    span_count: spans.spanCount,
    pause_gaps_removed: spans.pausesRemoved,
    spans_capped: spans.spansCapped,
    open_spans_ignored: spans.openIgnored,
    cap_hours: STRETCH_CAP_HOURS,
    drive_included: false,
    included_in_burden: false,
    gaps: input.residuals.map((row) => ({
      subset: row.subset,
      burden_target: row.burden_target,
      delta: row.burden_target == null ? null : roundMoney(priced.amount - row.burden_target),
    })),
    note: "Arrived or working through done, minus each pause until resumed, arrived, or working again. 14 hour cap per span. No drive time. A diagnostic figure only. Burden on the labor card stays not available.",
  };
}

export function projectDateRange(
  jobs: readonly { jobStatus?: string | null; createdOn?: string | null; completedOn?: string | null }[],
  nowIso: string,
): { start: string; end: string } {
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const job of jobs) {
    if (isCanceledJobStatus(job.jobStatus)) continue;
    if (job.createdOn && !isBeforeSourceFloor(job.createdOn) && (!earliest || job.createdOn < earliest)) {
      earliest = job.createdOn;
    }
    if (job.completedOn && !isBeforeSourceFloor(job.completedOn) && (!latest || job.completedOn > latest)) {
      latest = job.completedOn;
    }
  }
  const floor = `${SOURCE_RECORD_MIN_DAY}T00:00:00.000Z`;
  const start = earliest && earliest > floor ? earliest : floor;
  const end = latest && latest > nowIso ? latest : nowIso;
  return { start, end };
}

function inRange(stamp: string | null, start: string, end: string): boolean {
  if (!stamp || isBeforeSourceFloor(stamp)) return false;
  const at = Date.parse(stamp);
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(at) || !Number.isFinite(from) || !Number.isFinite(to)) return false;
  return at >= from && at <= to;
}

export function splitProjectAdjustments(input: {
  available: boolean;
  items: readonly PayrollAdjustmentRow[];
  jobIds: ReadonlySet<string>;
  technicianIds: ReadonlySet<string>;
  rangeStart: string;
  rangeEnd: string;
}): TechnicianAdjustmentReport {
  if (!input.available) {
    return {
      available: false,
      project_date_start: input.rangeStart,
      project_date_end: input.rangeEnd,
      tied_to_project_jobs: null,
      untied_for_project_techs: null,
      note: "Payroll adjustments were not read.",
    };
  }
  const tied: CountTotal = { count: 0, total: 0 };
  const untied: CountTotal = { count: 0, total: 0 };
  for (const row of input.items) {
    if (row.postedOn && isBeforeSourceFloor(row.postedOn)) continue;
    if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) continue;
    if (row.jobId && input.jobIds.has(row.jobId)) {
      addCount(tied, row.amount);
      continue;
    }
    if (row.jobId) continue;
    if (!row.employeeId || !input.technicianIds.has(row.employeeId)) continue;
    if (!inRange(row.postedOn, input.rangeStart, input.rangeEnd)) continue;
    addCount(untied, row.amount);
  }
  return {
    available: true,
    project_date_start: input.rangeStart,
    project_date_end: input.rangeEnd,
    tied_to_project_jobs: tied,
    untied_for_project_techs: untied,
    note: "Tied rows have a job id on this project. Untied rows have no job id, belong to a technician who has a row on this project's jobs, and fall inside the project date range. Nothing before 2022-08-02 is counted. This does not change labor.",
  };
}
