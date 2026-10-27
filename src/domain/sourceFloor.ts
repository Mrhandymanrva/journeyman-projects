/**
 * Owner rule: any ServiceTitan record whose date is before this day is
 * dropped. The read continues. An old date is never a reason to fail.
 * The day is compared on the calendar prefix of the source string.
 */
export const SOURCE_RECORD_MIN_DAY = "2022-08-02";

export function isBeforeSourceFloor(value: string | null | undefined): boolean {
  if (value == null) return false;
  const text = String(value).trim();
  if (!text) return false;
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
  if (day) return day < SOURCE_RECORD_MIN_DAY;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 10) < SOURCE_RECORD_MIN_DAY;
}

/** Payroll and invoice windows never ask ServiceTitan for days we would drop. */
export function sourceWindowStart(earliestMs: number | null, nowMs: number, lookbackMs: number): Date {
  const floor = Date.parse(`${SOURCE_RECORD_MIN_DAY}T00:00:00.000Z`);
  const candidate = earliestMs ?? nowMs - lookbackMs;
  return new Date(Math.max(floor, candidate));
}
