import { addDays } from "./scheduleBoard.js";
import {
  SCHEDULE_CAPTION,
  buildScheduleItems,
  summarizeSchedule,
} from "./scheduleDefinition.js";

/**
 * Project progress and the next 7 days use summarizeSchedule(), the same
 * function as Home's Due today list.
 *
 * ServiceTitan appointments are the rows a schedule read returned.
 * appointmentReadWindow asks for at most 63 days and always includes the next 7 days.
 */
export const SCHEDULE_PROGRESS_CAPTION = SCHEDULE_CAPTION;

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

export function scheduleProgress(input) {
  const summary = summarizeSchedule(
    buildScheduleItems(input),
    input?.today,
  );
  return {
    total: summary.total,
    complete: summary.complete,
    percent: summary.percent,
    week: summary.week,
    caption: summary.caption,
  };
}
