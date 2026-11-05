import { z } from "zod";
import { milestoneCredit } from "../../client/scheduleDefinition.js";
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const date = z.string().date();
const link = z.string().uuid().nullable().default(null);
const base = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000).default(""),
  owner_id: link,
};
const state = z
  .enum(["not_started", "in_progress", "blocked", "complete"])
  .default("not_started");
const rag = z.enum(["green", "amber", "red", "not_assessed"]);
export const controlData = {
  task: z
    .object({
      ...base,
      start_on: date,
      due_on: date,
      completed_on: date.nullable().default(null),
      state,
      parent_id: link,
      dependency_ids: z.array(z.string().uuid()).max(50).default([]),
      milestone_id: link,
      resource_id: link,
      job_link_id: link,
      sort_order: z.number().int().min(0).max(10000).default(0),
      /**
       * Same text rule as schedule_items.phase (trimmed, at most 120 characters).
       * The Gantt and the plan-task picker share this vocabulary via pmCatalog.phases.
       * Blank, whitespace, and omitted all mean the task states no phase.
       */
      phase: z
        .string()
        .trim()
        .max(120)
        .nullish()
        .transform((value) => value || null),
    })
    .strict()
    .refine((b) => b.due_on >= b.start_on, "Finish must be on or after start."),
  goal: z
    .object({
      ...base,
      due_on: date,
      key_results: z
        .array(
          z
            .object({
              name: z.string().trim().min(1).max(150),
              start: z.number().finite(),
              target: z.number().finite(),
              current: z.number().finite(),
              unit: z.string().max(30),
            })
            .strict()
            .refine(
              (b) => b.target !== b.start,
              "Target must differ from starting value.",
            ),
        )
        .max(20)
        .default([]),
      state,
    })
    .strict(),
  milestone: z
    .object({
      ...base,
      due_on: date,
      state,
      completed_on: date.nullable().default(null),
      goal_id: link,
      success_criteria: z.string().max(5000).default(""),
    })
    .strict(),
  risk: z
    .object({
      ...base,
      likelihood: z.number().int().min(1).max(5),
      impact: z.number().int().min(1).max(5),
      roam: z
        .enum(["unassessed", "resolved", "owned", "accepted", "mitigated"])
        .default("unassessed"),
      response: z.string().max(10000).default(""),
      review_on: date,
      trigger: z.string().max(5000).default(""),
    })
    .strict()
    .refine(
      (b) => b.roam !== "owned" || !!b.owner_id,
      "Assign an owner for an Owned risk.",
    ),
  communication: z
    .object({
      ...base,
      audience: z.string().trim().min(1).max(1000),
      channel: z.enum(["email", "phone", "onsite", "meeting", "portal"]),
      cadence: z.enum([
        "once",
        "daily",
        "weekly",
        "fortnightly",
        "monthly",
        "as_needed",
      ]),
      next_on: date.nullable().default(null),
      last_delivered_on: date.nullable().default(null),
      delivery_notes: z.string().max(10000).default(""),
    })
    .strict(),
  reserve: z
    .object({
      ...base,
      category: z.enum([
        "contingency",
        "management_reserve",
        "schedule_buffer",
      ]),
      allocated: z.number().min(0).max(100000000).multipleOf(0.01),
      drawn: z.number().min(0).max(100000000).multipleOf(0.01).default(0),
      risk_id: link,
    })
    .strict()
    .refine(
      (b) => b.drawn <= b.allocated,
      "Drawn reserve cannot exceed its allocation.",
    ),
  document: z
    .object({
      ...base,
      folder: z.enum([
        "charter_scope",
        "contracts_changes",
        "permits",
        "plans_specs",
        "photos",
        "reports",
        "closeout",
        "other",
      ]),
      template: z.string().max(80).default(""),
      content: z.string().max(100000).default(""),
    })
    .strict(),
  report: z
    .object({
      ...base,
      overall: rag,
      scope: rag,
      schedule: rag,
      cost: rag,
      quality: rag,
      achievements: z.string().max(10000).default(""),
      next_steps: z.string().max(10000).default(""),
      decisions: z.string().max(10000).default(""),
      as_of: date.default(today),
    })
    .strict(),
};
export type ControlKind = keyof typeof controlData;
export interface ControlRecord {
  id: string;
  kind: ControlKind;
  data: any;
  active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  file_name?: string | null;
  file_size?: number | null;
}
export function leafTasks(records: ControlRecord[]) {
  const tasks = records.filter((r) => r.active && r.kind === "task");
  const parents = new Set(tasks.map((t) => t.data.parent_id).filter(Boolean));
  return tasks.filter((t) => !parents.has(t.id));
}
export function validateTaskGraph(records: ControlRecord[]) {
  const tasks = records.filter((r) => r.active && r.kind === "task");
  const byId = new Map(tasks.map((r) => [r.id, r]));
  for (const r of tasks) {
    for (const id of [r.data.parent_id, ...r.data.dependency_ids].filter(
      Boolean,
    ))
      if (!byId.has(id))
        throw Error("A task reference is outside this project or archived.");
    if (
      r.data.state === "complete" &&
      tasks.some((c) => c.data.parent_id === r.id)
    )
      throw Error(
        "Complete the child tasks; work packages calculate progress from their children.",
      );
    if (
      r.data.state === "complete" &&
      r.data.dependency_ids.some(
        (id: string) => byId.get(id)?.data.state !== "complete",
      )
    )
      throw Error("Complete predecessor tasks first.");
  }
  for (const mode of ["parent", "dependency"]) {
    const visited = new Set<string>(),
      active = new Set<string>();
    const visit = (id: string) => {
      if (active.has(id))
        throw Error("Task hierarchy and dependencies must not contain cycles.");
      if (visited.has(id)) return;
      active.add(id);
      const r = byId.get(id)!;
      for (const next of mode === "parent"
        ? [r.data.parent_id].filter(Boolean)
        : r.data.dependency_ids)
        visit(next);
      active.delete(id);
      visited.add(id);
    };
    for (const r of tasks) visit(r.id);
  }
}
/**
 * Delivery status for one task, using the checks the task list already shows.
 * Done is the stored complete state. Late is the Overdue check: a due date
 * before today in America/New_York. A due date of today is not late.
 * At risk is the blocked state, which the task list already paints amber.
 * Anything else is on track. A complete task is done even if its due date passed.
 */
/** Task delivery, used only to decide the Late and At risk flags. */
export type RollupStatus = "done" | "late" | "at_risk" | "on_track";
/** Not started (nothing done), in progress (some done), complete (all done). */
export type MilestoneStatus = "not_started" | "in_progress" | "complete";
export type MilestoneFlag = "late" | "at_risk" | null;
export interface ControlRollup {
  status: MilestoneStatus;
  /** Late or at risk sits beside the status. It is not a status. */
  flag: MilestoneFlag;
  /**
   * Goal percent gives each linked milestone partial credit for tasks done.
   * Null unless this is a goal with at least one milestone.
   */
  percent: number | null;
  done: number;
  total: number;
}
interface RollupTask {
  state?: string;
  due_on?: string;
}
interface RollupRecord {
  id: string;
  kind: string;
  active: boolean;
  data: RollupTask & {
    milestone_id?: string | null;
    goal_id?: string | null;
    state?: string;
    completed_on?: string | null;
  };
}
export function taskRollupStatus(task: RollupTask, asOf: string): RollupStatus {
  if (task.state === "complete") return "done";
  if (task.due_on && task.due_on < asOf) return "late";
  if (task.state === "blocked") return "at_risk";
  return "on_track";
}
export interface MilestoneManual {
  state?: string;
  due_on?: string | null;
}
/**
 * Status comes from how many linked tasks are done.
 * No tasks uses the manual status (not started, in progress, or complete).
 * Late wins over at risk. A complete milestone is not late.
 */
export function milestoneRollup(
  tasks: RollupTask[],
  asOf: string,
  manual?: MilestoneManual | null,
): Pick<ControlRollup, "status" | "flag" | "done" | "total"> {
  const done = tasks.filter((task) => task.state === "complete").length;
  const total = tasks.length;
  if (total === 0) {
    const stored = manual?.state;
    const status: MilestoneStatus =
      stored === "complete"
        ? "complete"
        : stored === "in_progress" || stored === "blocked"
          ? "in_progress"
          : "not_started";
    let flag: MilestoneFlag = null;
    if (status !== "complete" && manual?.due_on && manual.due_on < asOf)
      flag = "late";
    else if (stored === "blocked") flag = "at_risk";
    return { status, flag, done: 0, total: 0 };
  }
  const status: MilestoneStatus =
    done === 0 ? "not_started" : done === total ? "complete" : "in_progress";
  const flags = tasks.map((task) => taskRollupStatus(task, asOf));
  const flag: MilestoneFlag = flags.some((item) => item === "late")
    ? "late"
    : flags.some((item) => item === "at_risk")
      ? "at_risk"
      : null;
  return { status, flag, done, total };
}
/** @deprecated Use milestoneRollup. Kept so older imports still resolve during the rename. */
export function milestoneRollupStatus(
  tasks: RollupTask[],
  asOf: string,
  manual?: MilestoneManual | null,
): MilestoneStatus {
  return milestoneRollup(tasks, asOf, manual).status;
}
export interface GoalPart {
  status: MilestoneStatus;
  flag: MilestoneFlag;
  done: number;
  total: number;
}
/**
 * Each milestone contributes its task credit (3 of 4 tasks = 75% of that milestone).
 * A milestone with no tasks contributes 0, or 100 when its manual status is complete.
 * The goal percent is the average of those shares. No milestones leaves it unset.
 */
export function goalRollup(parts: GoalPart[]): {
  status: MilestoneStatus;
  flag: MilestoneFlag;
  percent: number | null;
} {
  if (parts.length === 0)
    return { status: "not_started", flag: null, percent: null };
  const credit = parts.reduce(
    (sum, part) =>
      sum +
      milestoneCredit({
        linkedTotal: part.total,
        linkedDone: part.done,
        state:
          part.total === 0 && part.status === "complete"
            ? "complete"
            : "not_started",
      }),
    0,
  );
  const percent = Math.round((100 * credit) / parts.length);
  const flag: MilestoneFlag = parts.some((part) => part.flag === "late")
    ? "late"
    : parts.some((part) => part.flag === "at_risk")
      ? "at_risk"
      : null;
  const status: MilestoneStatus = parts.every(
    (part) => part.status === "complete",
  )
    ? "complete"
    : parts.every((part) => part.status === "not_started")
      ? "not_started"
      : "in_progress";
  return { status, flag, percent };
}
const MANUAL_MILESTONE_STATES = new Set([
  "not_started",
  "in_progress",
  "complete",
]);
/**
 * Goals stay calculated. A milestone with linked tasks stays calculated.
 * A milestone with no linked tasks keeps the status someone typed
 * (not started, in progress, or completed).
 */
export function preserveDerivedControlFields<T extends object>(
  kind: string,
  data: T,
  previous?: { state?: string; completed_on?: string | null } | null,
  linkedTaskCount = 0,
): T {
  if (kind !== "goal" && kind !== "milestone") return data;
  const record = data as T & {
    state?: string;
    completed_on?: string | null;
  };
  if (kind === "goal" || linkedTaskCount > 0) {
    record.state = previous?.state ?? "not_started";
    if (kind === "milestone")
      record.completed_on = previous?.completed_on ?? null;
    return record;
  }
  if (!MANUAL_MILESTONE_STATES.has(record.state ?? ""))
    record.state = "in_progress";
  if (record.state === "complete") {
    record.completed_on = record.completed_on ?? previous?.completed_on ?? null;
  } else record.completed_on = null;
  return record;
}
export function attachControlRollups<T extends RollupRecord>(
  records: T[],
  asOf: string,
): Array<T & { rollup: ControlRollup | null }> {
  const activeTasks = records.filter(
    (record) => record.active && record.kind === "task",
  );
  const activeMilestones = records.filter(
    (record) => record.active && record.kind === "milestone",
  );
  const milestones = new Map<string, ControlRollup>();
  for (const milestone of records) {
    if (milestone.kind !== "milestone") continue;
    const linked = activeTasks.filter(
      (task) => task.data.milestone_id === milestone.id,
    );
    const rolled = milestoneRollup(
      linked.map((task) => task.data),
      asOf,
      { state: milestone.data.state, due_on: milestone.data.due_on },
    );
    milestones.set(milestone.id, {
      status: rolled.status,
      flag: rolled.flag,
      percent: null,
      done: rolled.done,
      total: rolled.total,
    });
  }
  const goals = new Map<string, ControlRollup>();
  for (const goal of records) {
    if (goal.kind !== "goal") continue;
    const linked = activeMilestones.filter(
      (milestone) => milestone.data.goal_id === goal.id,
    );
    const parts = linked.map((milestone) => milestones.get(milestone.id)!);
    const rolled = goalRollup(parts);
    goals.set(goal.id, {
      status: rolled.status,
      flag: rolled.flag,
      percent: rolled.percent,
      done: parts.filter((part) => part.status === "complete").length,
      total: linked.length,
    });
  }
  return records.map((record) => ({
    ...record,
    rollup:
      record.kind === "milestone"
        ? (milestones.get(record.id) ?? null)
        : record.kind === "goal"
          ? (goals.get(record.id) ?? null)
          : null,
  }));
}
export function nextCommunicationDate(cadence: string, from: string) {
  const d = new Date(from + "T12:00:00Z");
  if (cadence === "once" || cadence === "as_needed") return null;
  if (cadence === "monthly") {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const end = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
    ).getUTCDate();
    d.setUTCDate(Math.min(day, end));
  } else
    d.setUTCDate(
      d.getUTCDate() + ({ daily: 1, weekly: 7, fortnightly: 14 }[cadence] ?? 0),
    );
  return d.toISOString().slice(0, 10);
}
