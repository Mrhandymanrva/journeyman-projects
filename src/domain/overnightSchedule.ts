/**
 * One ServiceTitan refresh per day at 2:00 AM America/New_York.
 * There is no hourly interval. A process that was down at 2 AM runs one
 * catch-up on boot only when a previous night finished and today's 2 AM
 * was missed. The first boot, with no finished night, waits until 2 AM.
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
