/**
 * One schedule for the project dashboard and Home's Due today list.
 *
 * Kinds, in the order Mason's Oct 26 default is extended by Home:
 * - Gantt activities (not cancelled)
 * - ServiceTitan appointments, when the caller supplies a schedule read
 * - preconstruction tasks
 * - WBS tasks (Home already counted these)
 * - plan milestones and permit milestones (Home already counted these)
 *
 * A row is complete only from a status already stored on it.
 * Nothing here marks work complete.
 *
 * Next 7 days is today through the sixth day after today, inclusive.
 * A span (activity or appointment) counts when its window overlaps that range.
 * A dated point (precon, WBS, milestone) counts when its due date falls in range.
 * A row with no date stays in the progress total and stays out of the next 7 days.
 *
 * Due today / overdue is the incomplete rows whose date has arrived:
 * a point is due when its due date is today or earlier;
 * a span is due when its window has started (overdue when the window has ended).
 *
 * Plan-milestone credit is partial: 3 of 4 linked tasks is 0.75.
 * A milestone with no linked tasks is 0, or 1 when its manual status is complete.
 */

export const SCHEDULE_CAPTION =
  "Gantt activities, ServiceTitan appointments, precon tasks, WBS tasks, and milestones";

export function addDays(date, n) {
  return new Date(Date.parse(date + "T12:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
}

function day(value) {
  const match = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function meta(row) {
  return {
    project_id: row.project_id ?? null,
    project_number: row.project_number ?? null,
    project_name: row.project_name ?? null,
    owner_name: row.owner_name ?? null,
    owner_role: row.owner_role ?? null,
  };
}

/**
 * Share of a milestone that is done, from 0 to 1.
 * Pass `tasks` when the linked task rows are in hand.
 * Otherwise pass linkedTotal / linkedDone counts.
 * With no tasks, only a manual status of complete counts as done.
 */
export function milestoneCredit(input = {}) {
  const hasTasks = Array.isArray(input.tasks);
  const total = hasTasks ? input.tasks.length : Number(input.linkedTotal) || 0;
  const done = hasTasks
    ? input.tasks.filter(
        (task) => (task?.state ?? task?.data?.state) === "complete",
      ).length
    : Number(input.linkedDone) || 0;
  if (total <= 0) return input.state === "complete" ? 1 : 0;
  return done / total;
}

export function milestoneIsComplete(input = {}) {
  return milestoneCredit(input) === 1;
}

function names(row) {
  return (row.resources || []).map((r) => r.name).filter(Boolean);
}

export function itemFromActivity(row) {
  const start = day(row.window_start ?? row.start);
  return {
    kind: "activity",
    id: String(row.id ?? row.item_id ?? ""),
    title: row.title || "Activity",
    start,
    end: day(row.window_end ?? row.end) || start,
    complete: row.status === "complete",
    cancelled: row.status === "cancelled",
    status: row.status || "",
    detail: [row.phase, row.vendor_name, ...names(row)].filter(Boolean).join(" · "),
    ...meta(row),
  };
}

export function itemFromAppointment(row) {
  const start = day(row.window_start) || day(row.appointment_start) || day(row.start);
  return {
    kind: "appointment",
    id: String(row.id ?? row.item_id ?? ""),
    title: row.title || "ServiceTitan appointment",
    start,
    end: day(row.window_end) || day(row.appointment_end) || day(row.end) || start,
    complete: row.status === "complete",
    cancelled: row.status === "cancelled",
    status: row.status || "",
    detail: [row.phase || "ServiceTitan", ...names(row)].filter(Boolean).join(" · "),
    ...meta(row),
  };
}

export function itemFromPrecon(row) {
  const due = day(row.due_on ?? row.end);
  const status = row.status || "";
  return {
    kind: "precon",
    id: String(row.id ?? row.item_id ?? ""),
    title: row.title || "Preconstruction task",
    start: due,
    end: due,
    complete: status === "done" || status === "waived",
    cancelled: false,
    status,
    detail: "Preconstruction",
    ...meta(row),
  };
}

export function itemFromWbs(row) {
  const data = row.data || {};
  const due = day(data.due_on ?? row.due_on);
  const state = data.state ?? row.state ?? "";
  return {
    kind: "wbs_task",
    id: String(row.id ?? row.item_id ?? ""),
    title: data.title || row.title || "Task",
    start: due,
    end: due,
    complete: state === "complete",
    cancelled: row.active === false,
    status: state,
    detail: "WBS task",
    ...meta(row),
  };
}

export function itemFromMilestone(row, tasks) {
  const data = row.data || {};
  const due = day(data.due_on ?? row.due_on);
  const state = data.state ?? row.state ?? "";
  const linked = Array.isArray(tasks)
    ? tasks.filter((task) => {
        const id = task.data?.milestone_id ?? task.milestone_id;
        return id && String(id) === String(row.id ?? row.item_id ?? "");
      })
    : undefined;
  const credit = milestoneCredit(
    linked
      ? { tasks: linked, state }
      : {
          linkedTotal: row.linked_total ?? row.linkedTotal,
          linkedDone: row.linked_done ?? row.linkedDone,
          state,
        },
  );
  return {
    kind: "milestone",
    id: String(row.id ?? row.item_id ?? ""),
    title: data.title || row.title || "Milestone",
    start: due,
    end: due,
    complete: credit === 1,
    cancelled: row.active === false,
    status: state,
    detail: "Milestone",
    ...meta(row),
  };
}

export function itemFromPermit(row) {
  const status = row.status || "";
  if (status === "failed" || status === "not_applicable") return null;
  const due = day(row.due_on ?? row.end);
  return {
    kind: "permit_milestone",
    id: String(row.id ?? row.item_id ?? ""),
    title: row.name || row.title || "Permit milestone",
    start: due,
    end: due,
    complete: status === "complete",
    cancelled: false,
    status,
    detail: "Permit milestone",
    ...meta(row),
  };
}

export function buildScheduleItems({
  activities = [],
  appointments = [],
  preconTasks = [],
  wbsTasks = [],
  milestones = [],
  permitMilestones = [],
  controlRecords = [],
} = {}) {
  const records = Array.isArray(controlRecords) ? controlRecords : [];
  const controlTasks = records.filter(
    (row) => row && row.kind === "task" && row.active !== false,
  );
  const controlMilestones = records.filter(
    (row) => row && row.kind === "milestone" && row.active !== false,
  );
  const tasks = controlTasks.length ? controlTasks : wbsTasks;
  const milestoneRows = controlMilestones.length ? controlMilestones : milestones;
  const taskListForMilestones = controlTasks.length ? controlTasks : null;
  return [
    ...activities.map(itemFromActivity),
    ...appointments.map(itemFromAppointment),
    ...preconTasks.map(itemFromPrecon),
    ...tasks.map(itemFromWbs),
    ...milestoneRows.map((row) => itemFromMilestone(row, taskListForMilestones)),
    ...permitMilestones.map(itemFromPermit),
  ].filter((item) => item && !item.cancelled);
}

function overlaps(item, today, weekEnd) {
  return Boolean(item.start && item.end && item.end >= today && item.start <= weekEnd);
}

function isOverdue(item, today) {
  return Boolean(item.end && item.end < today);
}

function isDueTodayOrOverdue(item, today) {
  if (item.complete || !item.end) return false;
  if (item.kind === "activity" || item.kind === "appointment") {
    return Boolean(item.start && item.start <= today);
  }
  return item.end <= today;
}

function dueSort(a, b) {
  if (Boolean(a.overdue) !== Boolean(b.overdue)) return a.overdue ? -1 : 1;
  const byDate = String(a.end || "").localeCompare(String(b.end || ""));
  if (byDate) return byDate;
  const byProject = String(a.project_name || "").localeCompare(String(b.project_name || ""));
  if (byProject) return byProject;
  return String(a.title || "").localeCompare(String(b.title || ""));
}

export function summarizeSchedule(items, today) {
  const live = (items || []).filter((item) => item && !item.cancelled);
  const weekEnd = addDays(today, 6);
  const complete = live.filter((item) => item.complete).length;
  const week = live
    .filter((item) => overlaps(item, today, weekEnd))
    .sort(
      (a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title),
    );
  const due = live
    .filter((item) => isDueTodayOrOverdue(item, today))
    .map((item) => ({ ...item, overdue: isOverdue(item, today) }))
    .sort(dueSort);
  return {
    total: live.length,
    complete,
    percent: live.length ? Math.round((100 * complete) / live.length) : null,
    week,
    due,
    caption: SCHEDULE_CAPTION,
  };
}
