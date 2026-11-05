/**
 * Committed labor on the project Financials page.
 *
 * Hours come from stored ServiceTitan appointment windows
 * (projects.st_plan_appointments). Nothing here calls ServiceTitan, and
 * nothing is written back. The overnight refresh, the Refresh button, and
 * project open already replace those rows.
 *
 * Hours. America/New_York. A working day is Monday–Friday, 7:00 a.m. to
 * 3:00 p.m. (8 hours). For each calendar day an appointment covers, count
 * only the overlap with that window. Saturday and Sunday add nothing.
 * Holidays are not configured, so a weekday holiday still counts. This is
 * working time, not the wall-clock span of a multi-day appointment.
 * An appointment with no technician counts as one technician and is flagged
 * "No technician assigned". Each assigned technician counts once.
 * Canceled and inactive appointments are skipped.
 *
 * Scope. A linked job stays committed while it is not both completed and
 * invoiced. Scheduled and in-progress jobs stay, including a completed job
 * that has no invoice yet, and an invoiced job that is not completed.
 * When the job is completed and invoiced it leaves committed. Its timesheet
 * actuals count, and its appointment windows do not. A job is never in both.
 *
 * Revenue. Sum of that job's invoice lines, or else estimate lines, that are
 * labeled Labor (kind labor) or priced as MHM.25PLFE. MHM 250.Labor and
 * MHM.25LFCO are never labor revenue. Stored estimates do not keep line
 * items, so a job with no such lines is marked estimated: hours times the
 * company billable rate (tenant setting, otherwise $188).
 *
 * Cost. Payroll has not posted for a job that is still committed, so
 * commission is 25% of that labor revenue (the same fraction as billed labor
 * with no InvoiceRelatedBonus). Burden is those hours times the technician's
 * ServiceTitan burden rate: a positive stored technician_labor_rates.burden_rate,
 * otherwise that technician's stored labor_actuals burden_amount divided by
 * hours. A missing rate is flagged "Burden not set" and is not invented.
 * With no labor lines, cost is hours × billable rate × 25% plus burden.
 */

import { DEFAULT_BILLABLE_RATE } from "./commissionLabor.js";
import { neverLaborCode, roundMoney } from "./projectFinancials.js";
import { BILLED_LABOR_COMMISSION_FRACTION, billedLaborCommission } from "./stLabor.js";

export const COMMITTED_ZONE = "America/New_York";
/** 7:00 a.m. */
export const WORKDAY_START_MINUTES = 7 * 60;
/** 3:00 p.m. Eight working hours after 7:00 a.m. */
export const WORKDAY_END_MINUTES = 15 * 60;

export const LABOR_REVENUE_SKU = "MHM.25PLFE";

export const FLAG_UNASSIGNED = "No technician assigned";
export const FLAG_BURDEN = "Burden not set";
export const FLAG_REVENUE_ESTIMATED = "Revenue estimated";

export type CommittedRevenueSource = "invoice" | "estimate" | "estimated";

export interface CommittedTechnician {
  id?: string | null;
  name?: string | null;
}

export interface CommittedAppointment {
  externalJobId: string;
  externalAppointmentId: string;
  jobNumber: string;
  jobStatus: string;
  startsAt: string;
  endsAt: string;
  status: string;
  active: boolean;
  technicians: CommittedTechnician[];
}

export interface CommittedJobLink {
  externalJobId: string;
  jobNumber: string | null;
  jobStatus: string | null;
  active: boolean;
}

export interface CommittedMoneyLine {
  externalJobId: string;
  sku: string | null;
  kind: string | null;
  total: number;
}

export interface CommittedActualRow {
  externalJobId: string;
  technicianId: string | null;
  hours: number;
  laborAmount: number | null;
  burdenAmount: number | null;
  burdenUnset: boolean;
}

export interface CommittedTechRate {
  technicianId: string;
  burdenRate: number | null;
}

export interface CommittedLaborJob {
  jobId: string;
  jobNumber: string;
  jobStatus: string;
  startsOn: string | null;
  endsOn: string | null;
  hours: number;
  technicians: string[];
  revenue: number;
  revenueSource: CommittedRevenueSource;
  cost: number;
  commission: number;
  burden: number;
  flags: string[];
}

export interface CommittedLabor {
  hours: number;
  cost: number;
  revenue: number;
  revenueEstimated: boolean;
  /** Timesheet hours on jobs that have left committed. */
  actualHours: number;
  /** Commission plus burden on those same jobs. */
  actualCost: number;
  actualJobIds: string[];
  jobs: CommittedLaborJob[];
  /** Plain-language method for the Financials tooltip. */
  method: string;
  billableRate: number;
  commissionFraction: number;
}

export interface CommittedLaborInput {
  appointments: readonly CommittedAppointment[];
  links: readonly CommittedJobLink[];
  invoiceLines: readonly CommittedMoneyLine[];
  estimateLines?: readonly CommittedMoneyLine[];
  /** Job ids with an invoice observation even when no line was stored. */
  invoicedJobIds?: readonly string[];
  actuals: readonly CommittedActualRow[];
  rates: readonly CommittedTechRate[];
  billableRate: number;
}

interface Civil {
  year: number;
  month: number;
  day: number;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function civilKey(day: Civil): string {
  return `${day.year}-${pad(day.month)}-${pad(day.day)}`;
}

function parseCivil(key: string): Civil | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function addCivilDays(day: Civil, count: number): Civil {
  const next = new Date(Date.UTC(day.year, day.month - 1, day.day + count, 12));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function isWeekendDate(key: string): boolean {
  const day = parseCivil(key);
  if (!day) return false;
  const utc = new Date(Date.UTC(day.year, day.month - 1, day.day, 12));
  const weekday = utc.getUTCDay();
  return weekday === 0 || weekday === 6;
}

interface NyClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function nyClock(ms: number): NyClock | null {
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: COMMITTED_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(read("hour"));
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: hour === 24 ? 0 : hour,
    minute: Number(read("minute")),
  };
}

/** UTC instant whose America/New_York clock is the given local time. */
export function zonedLocalToUtc(date: string, hour: number, minute: number): string {
  const day = parseCivil(date);
  if (!day) throw new Error("Invalid civil date.");
  let t = Date.UTC(day.year, day.month - 1, day.day, hour, minute, 0);
  for (let pass = 0; pass < 4; pass += 1) {
    const got = nyClock(t);
    if (!got) break;
    const gotMs = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, 0);
    const want = Date.UTC(day.year, day.month - 1, day.day, hour, minute, 0);
    const delta = want - gotMs;
    if (delta === 0) break;
    t += delta;
  }
  return new Date(t).toISOString();
}

function nyDateKey(ms: number): string | null {
  const clock = nyClock(ms);
  if (!clock || !clock.year) return null;
  return civilKey(clock);
}

/**
 * Working hours for one person. Multi-day appointments do not use the
 * wall-clock difference. Each weekday contributes only its overlap with
 * 7:00 a.m.–3:00 p.m. America/New_York.
 */
export function workingHours(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const firstKey = nyDateKey(start);
  const lastKey = nyDateKey(end);
  if (!firstKey || !lastKey) return 0;
  let day = parseCivil(firstKey);
  const last = parseCivil(lastKey);
  if (!day || !last) return 0;
  let hours = 0;
  const lastKeyNorm = civilKey(last);
  for (let guard = 0; guard < 400; guard += 1) {
    const key = civilKey(day);
    if (!isWeekendDate(key)) {
      const windowStart = Date.parse(zonedLocalToUtc(key, 7, 0));
      const windowEnd = Date.parse(zonedLocalToUtc(key, 15, 0));
      const overlap = Math.min(end, windowEnd) - Math.max(start, windowStart);
      if (overlap > 0) hours += overlap / 3_600_000;
    }
    if (key === lastKeyNorm) break;
    day = addCivilDays(day, 1);
  }
  return roundMoney(hours);
}

export function isCanceledStatus(status: string | null | undefined): boolean {
  return /cancel/i.test(status ?? "");
}

/** Completed, done, or closed. Canceled is not completed. */
export function isCompletedJobStatus(status: string | null | undefined): boolean {
  if (isCanceledStatus(status)) return false;
  const key = (status ?? "").trim().toLowerCase().replace(/[\s_-]/g, "");
  return key === "completed" || key === "complete" || key === "done" || key === "closed";
}

export function isLaborRevenueLine(line: { sku?: string | null; kind?: string | null }): boolean {
  if (neverLaborCode(line.sku)) return false;
  const sku = line.sku?.trim().toLowerCase() ?? "";
  if (sku === LABOR_REVENUE_SKU.toLowerCase()) return true;
  return (line.kind ?? "").trim().toLowerCase() === "labor";
}

export function companyBillableRate(rate: number | null | undefined): number {
  if (rate == null || !Number.isFinite(rate) || rate < 0) return DEFAULT_BILLABLE_RATE;
  return rate;
}

export function committedLaborMethod(billableRate: number): string {
  const rate = companyBillableRate(billableRate);
  const shown = Number.isInteger(rate) ? String(rate) : rate.toFixed(2);
  return (
    `Committed hours are the stored ServiceTitan appointment windows on linked jobs that are not yet both completed and invoiced. ` +
    `Each weekday counts only the overlap with 7:00 a.m.–3:00 p.m. America/New_York (8 working hours). Weekends count as zero. Wall-clock time across midnight is not used. ` +
    `An appointment with no technician counts as one technician and is flagged. ` +
    `Committed cost, while payroll has not posted, is ${BILLED_LABOR_COMMISSION_FRACTION * 100}% of committed labor revenue plus those hours times the technician's ServiceTitan burden rate. ` +
    `Labor revenue is the job's invoice lines, or else estimate lines, labeled Labor or priced as ${LABOR_REVENUE_SKU}. ` +
    `When those lines are missing, revenue is estimated as hours × $${shown} (the company billable rate) and marked estimated, and cost is that estimate × ${BILLED_LABOR_COMMISSION_FRACTION * 100}% plus burden. ` +
    `The burden rate is the technician's stored ServiceTitan burden rate, or their stored burden dollars divided by hours. A missing rate is flagged and is not invented. ` +
    `A job that is completed and invoiced leaves committed, and only its actuals count, so it is not in both. ` +
    `Nothing is written to ServiceTitan. Appointments are the rows already stored, refreshed overnight, by Refresh, and when the project opens.`
  );
}

function moneySum(lines: readonly CommittedMoneyLine[], jobId: string): number {
  return roundMoney(
    lines
      .filter((line) => line.externalJobId === jobId && isLaborRevenueLine(line))
      .reduce((sum, line) => sum + (Number.isFinite(line.total) ? line.total : 0), 0),
  );
}

function burdenRateFor(
  technicianId: string,
  rates: readonly CommittedTechRate[],
  actuals: readonly CommittedActualRow[],
): number | null {
  const stored = rates.find((rate) => rate.technicianId === technicianId);
  if (stored?.burdenRate != null && stored.burdenRate > 0) return stored.burdenRate;
  let hours = 0;
  let burden = 0;
  let seen = false;
  for (const row of actuals) {
    if (row.technicianId !== technicianId) continue;
    if (!(row.hours > 0) || row.burdenAmount == null) continue;
    seen = true;
    hours += row.hours;
    burden += row.burdenAmount;
  }
  if (!seen || !(hours > 0) || !(burden > 0)) return null;
  return burden / hours;
}

function uniquePush(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

interface ResolvedJob {
  jobId: string;
  jobNumber: string;
  jobStatus: string;
  invoiced: boolean;
}

function resolveJobs(input: CommittedLaborInput): Map<string, ResolvedJob> {
  const jobs = new Map<string, ResolvedJob>();
  const invoiced = new Set(
    (input.invoicedJobIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
  );
  for (const line of input.invoiceLines) {
    if (line.externalJobId.trim()) invoiced.add(line.externalJobId.trim());
  }
  for (const link of input.links) {
    if (!link.active) continue;
    const jobId = link.externalJobId.trim();
    if (!jobId) continue;
    jobs.set(jobId, {
      jobId,
      jobNumber: link.jobNumber?.trim() || jobId,
      jobStatus: link.jobStatus?.trim() || "",
      invoiced: invoiced.has(jobId),
    });
  }
  for (const appointment of input.appointments) {
    const jobId = appointment.externalJobId.trim();
    const known = jobs.get(jobId);
    if (!known) continue;
    if (!known.jobStatus && appointment.jobStatus.trim()) known.jobStatus = appointment.jobStatus.trim();
    if (known.jobNumber === jobId && appointment.jobNumber.trim()) known.jobNumber = appointment.jobNumber.trim();
  }
  return jobs;
}

function formatNyDate(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: COMMITTED_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(ms));
}

function technicianLabel(tech: CommittedTechnician): string {
  const name = tech.name?.trim();
  if (name) return name;
  const id = tech.id?.trim();
  return id ? `Technician ${id}` : "Technician";
}

export function buildCommittedLabor(input: CommittedLaborInput): CommittedLabor {
  const billableRate = companyBillableRate(input.billableRate);
  const jobs = resolveJobs(input);
  const committedJobs: CommittedLaborJob[] = [];
  const actualJobIds: string[] = [];
  let actualHours = 0;
  let actualCost = 0;

  for (const job of jobs.values()) {
    if (isCanceledStatus(job.jobStatus)) continue;
    const closed = isCompletedJobStatus(job.jobStatus) && job.invoiced;
    if (!closed) continue;
    actualJobIds.push(job.jobId);
    const rows = input.actuals.filter((row) => row.externalJobId === job.jobId);
    const hours = roundMoney(rows.reduce((sum, row) => sum + (row.hours > 0 ? row.hours : 0), 0));
    const burden = roundMoney(
      rows.reduce((sum, row) => sum + (row.burdenAmount != null && row.burdenAmount > 0 ? row.burdenAmount : 0), 0),
    );
    const priced = rows.filter((row) => row.laborAmount != null);
    const invoiceLabor = moneySum(input.invoiceLines, job.jobId);
    const commission =
      priced.length > 0
        ? roundMoney(priced.reduce((sum, row) => sum + (row.laborAmount ?? 0), 0))
        : billedLaborCommission(invoiceLabor);
    actualHours = roundMoney(actualHours + hours);
    actualCost = roundMoney(actualCost + roundMoney(commission + burden));
  }

  for (const job of jobs.values()) {
    if (isCanceledStatus(job.jobStatus)) continue;
    if (isCompletedJobStatus(job.jobStatus) && job.invoiced) continue;
    const appointments = input.appointments.filter(
      (row) =>
        row.externalJobId === job.jobId &&
        row.active &&
        !isCanceledStatus(row.status) &&
        row.startsAt &&
        row.endsAt,
    );
    if (appointments.length === 0) continue;

    let hours = 0;
    let burden = 0;
    const flags: string[] = [];
    const techNames: string[] = [];
    let startsAt: string | null = null;
    let endsAt: string | null = null;

    for (const appointment of appointments) {
      const personHours = workingHours(appointment.startsAt, appointment.endsAt);
      if (startsAt == null || Date.parse(appointment.startsAt) < Date.parse(startsAt)) startsAt = appointment.startsAt;
      if (endsAt == null || Date.parse(appointment.endsAt) > Date.parse(endsAt)) endsAt = appointment.endsAt;
      const techs = new Map<string, CommittedTechnician>();
      for (const tech of appointment.technicians) {
        const id = tech.id?.trim() || "";
        const name = tech.name?.trim() || "";
        if (!id && !name) continue;
        techs.set(id || `name:${name}`, tech);
      }
      if (techs.size === 0) {
        hours = roundMoney(hours + personHours);
        uniquePush(flags, FLAG_UNASSIGNED);
        uniquePush(flags, FLAG_BURDEN);
        uniquePush(techNames, "Unassigned");
        continue;
      }
      for (const tech of techs.values()) {
        hours = roundMoney(hours + personHours);
        uniquePush(techNames, technicianLabel(tech));
        const id = tech.id?.trim() || "";
        const rate = id ? burdenRateFor(id, input.rates, input.actuals) : null;
        if (rate == null) {
          uniquePush(flags, FLAG_BURDEN);
          continue;
        }
        burden = roundMoney(burden + roundMoney(personHours * rate));
      }
    }

    const invoiceLabor = moneySum(input.invoiceLines, job.jobId);
    const estimateLabor = moneySum(input.estimateLines ?? [], job.jobId);
    let revenue: number;
    let revenueSource: CommittedRevenueSource;
    if (invoiceLabor > 0) {
      revenue = invoiceLabor;
      revenueSource = "invoice";
    } else if (estimateLabor > 0) {
      revenue = estimateLabor;
      revenueSource = "estimate";
    } else {
      revenue = roundMoney(hours * billableRate);
      revenueSource = "estimated";
      uniquePush(flags, FLAG_REVENUE_ESTIMATED);
    }
    const commission = billedLaborCommission(revenue);
    const cost = roundMoney(commission + burden);
    committedJobs.push({
      jobId: job.jobId,
      jobNumber: job.jobNumber,
      jobStatus: job.jobStatus || "Scheduled",
      startsOn: formatNyDate(startsAt),
      endsOn: formatNyDate(endsAt),
      hours,
      technicians: techNames,
      revenue,
      revenueSource,
      cost,
      commission,
      burden,
      flags,
    });
  }

  committedJobs.sort((a, b) => a.jobNumber.localeCompare(b.jobNumber) || a.jobId.localeCompare(b.jobId));
  actualJobIds.sort((a, b) => a.localeCompare(b));
  const hours = roundMoney(committedJobs.reduce((sum, job) => sum + job.hours, 0));
  const cost = roundMoney(committedJobs.reduce((sum, job) => sum + job.cost, 0));
  const revenue = roundMoney(committedJobs.reduce((sum, job) => sum + job.revenue, 0));
  return {
    hours,
    cost,
    revenue,
    revenueEstimated: committedJobs.some((job) => job.revenueSource === "estimated"),
    actualHours,
    actualCost,
    actualJobIds,
    jobs: committedJobs,
    method: committedLaborMethod(billableRate),
    billableRate,
    commissionFraction: BILLED_LABOR_COMMISSION_FRACTION,
  };
}
