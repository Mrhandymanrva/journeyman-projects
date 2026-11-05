import { isBeforeSourceFloor } from "./sourceFloor.js";

/**
 * Identity for a gross pay row when ServiceTitan sends id null.
 * Amount and amountAdjustment are values, not identity: the same timesheet
 * can be repeated with a different dollar figure.
 */
export function grossPayNaturalKey(item: {
  technicianId: string | null;
  employeeType?: string | null;
  payrollId?: string | null;
  date: string | null;
  activity: string | null;
  activityCode?: string | null;
  type: string | null;
  paidTimeType: string | null;
  paidDurationHours: number | null;
  jobId: string | null;
  projectId?: string | null;
  invoiceId?: string | null;
  startedOn?: string | null;
  endedOn?: string | null;
  sourceEntityId?: string | null;
  jobNumber?: string | null;
}): string {
  return [
    item.technicianId,
    item.employeeType,
    item.payrollId,
    item.date,
    item.activity,
    item.activityCode,
    item.type,
    item.paidTimeType,
    item.paidDurationHours,
    item.jobId,
    item.projectId,
    item.invoiceId,
    item.startedOn,
    item.endedOn,
    item.sourceEntityId,
    item.jobNumber,
  ]
    .map((part) => (part == null ? "" : String(part)))
    .join("|");
}

export function dedupeGrossPayItems<T extends { id: string | null }>(
  items: readonly T[],
  naturalKey: (item: T) => string,
): T[] {
  const kept: T[] = [];
  const seenId = new Set<string>();
  const seenKey = new Set<string>();
  for (const item of items) {
    if (!item.id) continue;
    if (seenId.has(item.id)) continue;
    seenId.add(item.id);
    seenKey.add(naturalKey(item));
    kept.push(item);
  }
  for (const item of items) {
    if (item.id) continue;
    const key = naturalKey(item);
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    kept.push(item);
  }
  return kept;
}

/** A row we can price or attribute. Others are skipped, not a failed page. */
export function grossPayItemUsable(item: {
  technicianId: string | null;
  jobId: string | null;
  projectId?: string | null;
  paidDurationHours: number | null;
  amount: number | null;
}): boolean {
  if (!item.technicianId) return false;
  if (!item.jobId && !item.projectId) return false;
  const hours = item.paidDurationHours;
  const amount = item.amount;
  const hasHours = typeof hours === "number" && Number.isFinite(hours);
  const hasAmount = typeof amount === "number" && Number.isFinite(amount);
  return hasHours || hasAmount;
}

export function grossPayItemTooOld(item: {
  date: string | null;
  startedOn?: string | null;
}): boolean {
  if (item.date) return isBeforeSourceFloor(item.date);
  if (item.startedOn) return isBeforeSourceFloor(item.startedOn);
  return false;
}
