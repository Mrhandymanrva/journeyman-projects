/** Daily-log dates and times. The console shows America/New_York. */

const ET = "America/New_York";

/** Calendar day in New York, as YYYY-MM-DD for `<input type="date">`. */
export function todayInNewYork(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** `log_date` is a calendar day. Format it without shifting across a timezone. */
export function formatCalendarDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  if (!match) return "";
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function createdInNewYork(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).formatToParts(parsed);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
  const time = `${get("hour")}:${get("minute")} ${get("dayPeriod")}`.replace(
    /\s+/g,
    " ",
  );
  return {
    isoDay: iso,
    date: `${get("month")} ${get("day")}, ${get("year")}`,
    time,
  };
}

/**
 * The log's calendar day, then the time it was written in Eastern Time.
 * "Nov 10, 2026 · 2:14 PM ET". When the write falls on another Eastern day,
 * that day is included so the clock time is not read as the log date.
 */
export function formatDailyLogStamp(log) {
  const day = formatCalendarDay(log?.log_date);
  const created = createdInNewYork(log?.created_at);
  if (!created) return day;
  const written =
    created.isoDay === String(log?.log_date ?? "").slice(0, 10)
      ? `${created.time} ET`
      : `written ${created.date} · ${created.time} ET`;
  return day ? `${day} · ${written}` : `${created.date} · ${created.time} ET`;
}
