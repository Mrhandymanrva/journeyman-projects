import { addDays } from "./scheduleBoard.js";

/**
 * Project progress uses one list: the schedule.
 *
 * The schedule is three kinds of dated work, counted together:
 * - Gantt activities whose status is not cancelled
 * - ServiceTitan appointments whose status is not cancelled
 * - preconstruction tasks
 *
 * A row counts as complete only from a status already stored on it:
 * - activity or appointment status "complete"
 * - precon task status "done" or "waived" (the checklist treats both as finished)
 * Nothing in this module marks work complete.
 *
 * Next 7 days is today through the sixth day after today, inclusive.
 * An activity or appointment counts when its date window overlaps that range.
 * A precon task counts when its due date falls in that range.
 * A row with no date stays in the progress total and stays out of the next 7 days.
 *
 * ServiceTitan appointments are the rows a schedule read returned.
 * appointmentReadWindow asks for at most 63 days and always includes the next 7 days.
 */
export const SCHEDULE_PROGRESS_CAPTION =
  "Gantt activities, ServiceTitan appointments, and precon tasks";

const DAY = 86400000;

function day(value) {
  const match = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function spanDays(from, to) {
  return Math.round(
    (Date.parse(to + "T12:00:00Z") - Date.parse(from + "T12:00:00Z")) / DAY,
  );
}

export function appointmentReadWindow(today, project = {}) {
  const nextEnd = addDays(today, 6);
  const start = day(project.scheduled_start) || day(project.actual_start);
  const end = day(project.scheduled_end);
  let from = today;
  let to = nextEnd;
  if (start && start < from) from = start;
  if (end && end > to) to = end;
  if (spanDays(from, to) > 62) {
    to = end && spanDays(today, end) <= 62 && end >= nextEnd ? end : nextEnd;
    from = addDays(to, -62);
    if (from > today) from = today;
  }
  if (to < nextEnd) to = nextEnd;
  if (from > today) from = today;
  if (spanDays(from, to) > 62) from = addDays(to, -62);
  return { from, to };
}

function names(row) {
  return (row.resources || []).map((r) => r.name).filter(Boolean);
}

function activityItem(row) {
  const start = day(row.window_start);
  return {
    kind: "activity",
    id: String(row.id ?? ""),
    title: row.title || "Activity",
    start,
    end: day(row.window_end) || start,
    complete: row.status === "complete",
    cancelled: row.status === "cancelled",
    status: row.status || "",
    detail: [row.phase, row.vendor_name, ...names(row)].filter(Boolean).join(" · "),
  };
}

function appointmentItem(row) {
  const start = day(row.window_start) || day(row.appointment_start);
  return {
    kind: "appointment",
    id: String(row.id ?? ""),
    title: row.title || "ServiceTitan appointment",
    start,
    end: day(row.window_end) || day(row.appointment_end) || start,
    complete: row.status === "complete",
    cancelled: row.status === "cancelled",
    status: row.status || "",
    detail: [row.phase || "ServiceTitan", ...names(row)].filter(Boolean).join(" · "),
  };
}

function preconItem(row) {
  const due = day(row.due_on);
  return {
    kind: "precon",
    id: String(row.id ?? ""),
    title: row.title || "Preconstruction task",
    start: due,
    end: due,
    complete: row.status === "done" || row.status === "waived",
    cancelled: false,
    status: row.status || "",
    detail: "Preconstruction",
  };
}

function overlaps(item, today, weekEnd) {
  return Boolean(item.start && item.end && item.end >= today && item.start <= weekEnd);
}

export function scheduleProgress({
  activities = [],
  appointments = [],
  preconTasks = [],
  today,
}) {
  const items = [
    ...activities.map(activityItem),
    ...appointments.map(appointmentItem),
    ...preconTasks.map(preconItem),
  ].filter((item) => !item.cancelled);
  const weekEnd = addDays(today, 6);
  const complete = items.filter((item) => item.complete).length;
  const week = items
    .filter((item) => overlaps(item, today, weekEnd))
    .sort(
      (a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title),
    );
  return {
    total: items.length,
    complete,
    percent: items.length ? Math.round((100 * complete) / items.length) : null,
    week,
    caption: SCHEDULE_PROGRESS_CAPTION,
  };
}
