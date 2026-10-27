/**
 * One ServiceTitan refresh per day at 2:00 AM America/New_York.
 * There is no hourly interval. A restart runs the missed night when a due
 * instant was saved and not finished, when the last finish is older than
 * the latest 2 AM, or when nothing has been saved and that 2 AM was within
 * the last six hours. A first boot earlier in the day waits until 2 AM.
 */

export const OVERNIGHT_TIME_ZONE = "America/New_York";
export const OVERNIGHT_HOUR = 2;

export interface ZonedClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedClock(instant: Date, timeZone = OVERNIGHT_TIME_ZONE): ZonedClock {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function shiftDays(clock: ZonedClock, days: number): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + days));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

/** UTC instant whose America/New_York clock is 2:00:00 on that civil date. */
export function overnightInstant(year: number, month: number, day: number): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, 7, 0, 0));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const clock = zonedClock(guess);
    const actual = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
    const desired = Date.UTC(year, month - 1, day, OVERNIGHT_HOUR, 0, 0);
    const next = new Date(guess.getTime() + (desired - actual));
    if (next.getTime() === guess.getTime()) return next;
    guess = next;
  }
  return guess;
}

export function mostRecentOvernight(now: Date): Date {
  const clock = zonedClock(now);
  const today = overnightInstant(clock.year, clock.month, clock.day);
  if (today.getTime() <= now.getTime()) return today;
  const previous = shiftDays(clock, -1);
  return overnightInstant(previous.year, previous.month, previous.day);
}

export function nextOvernight(now: Date): Date {
  const clock = zonedClock(now);
  const today = overnightInstant(clock.year, clock.month, clock.day);
  if (today.getTime() > now.getTime()) return today;
  const tomorrow = shiftDays(clock, 1);
  return overnightInstant(tomorrow.year, tomorrow.month, tomorrow.day);
}

/**
 * True only after at least one overnight run has finished and the latest
 * 2 AM America/New_York is still newer than that finish.
 */
export function missedOvernightCatchUp(now: Date, lastFinishedAt: Date | null): boolean {
  if (!lastFinishedAt || Number.isNaN(lastFinishedAt.getTime())) return false;
  return lastFinishedAt.getTime() < mostRecentOvernight(now).getTime();
}

/** A deploy that lands inside this window after 2 AM, with no saved night, catch-up runs. */
export const OVERNIGHT_CATCH_UP_WINDOW_MS = 6 * 60 * 60 * 1000;

export type RefreshBootAction = "catch-up" | "wait";

function validInstant(value: Date | null | undefined): Date | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  return value;
}

/**
 * Whether this process should run the overnight refresh now.
 * A saved due instant that has passed, and has not finished, always runs.
 * A previous finish older than the latest 2 AM runs.
 * A blank due and a blank finish run only in the six hours after 2 AM,
 * so a restart the same morning still writes the night the timer lost.
 */
export function refreshBootAction(
  now: Date,
  dueAt: Date | null,
  finishedAt: Date | null,
): RefreshBootAction {
  const due = validInstant(dueAt);
  const finished = validInstant(finishedAt);
  if (due && due.getTime() <= now.getTime() && (!finished || finished.getTime() < due.getTime())) {
    return "catch-up";
  }
  if (finished && missedOvernightCatchUp(now, finished)) return "catch-up";
  if (!due && !finished) {
    const elapsed = now.getTime() - mostRecentOvernight(now).getTime();
    if (elapsed >= 0 && elapsed <= OVERNIGHT_CATCH_UP_WINDOW_MS) return "catch-up";
  }
  return "wait";
}
