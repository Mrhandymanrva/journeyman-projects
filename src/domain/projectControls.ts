import { z } from "zod";
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
export type RollupStatus = "done" | "late" | "at_risk" | "on_track";
export interface ControlRollup {
  status: RollupStatus;
  /** Share of linked milestones that are done. Null unless this is a goal with at least one. */
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
function worstOpen(statuses: RollupStatus[]): RollupStatus {
  if (statuses.some((status) => status === "late")) return "late";
  if (statuses.some((status) => status === "at_risk")) return "at_risk";
  return "on_track";
}
/** No linked tasks stays on track. Done only when every linked task is done. */
export function milestoneRollupStatus(
  tasks: RollupTask[],
  asOf: string,
): RollupStatus {
  if (tasks.length === 0) return "on_track";
  const statuses = tasks.map((task) => taskRollupStatus(task, asOf));
  if (statuses.every((status) => status === "done")) return "done";
  return worstOpen(statuses);
}
/** Percent counts milestones whose own roll-up is done. No milestones leaves it unset. */
export function goalRollup(milestoneStatuses: RollupStatus[]): {
  status: RollupStatus;
  percent: number | null;
} {
  if (milestoneStatuses.length === 0)
    return { status: "on_track", percent: null };
  const done = milestoneStatuses.filter((status) => status === "done").length;
  const percent = Math.round((100 * done) / milestoneStatuses.length);
  if (done === milestoneStatuses.length) return { status: "done", percent };
  return { status: worstOpen(milestoneStatuses), percent };
}
/**
 * Keep the stored status and completion date. The screen calculates over them
 * and does not offer a way to type a new value.
 */
export function preserveDerivedControlFields<T extends object>(
  kind: string,
  data: T,
  previous?: { state?: string; completed_on?: string | null } | null,
): T {
  if (kind !== "goal" && kind !== "milestone") return data;
  const record = data as T & {
    state?: string;
    completed_on?: string | null;
  };
  record.state = previous?.state ?? "not_started";
  if (kind === "milestone")
    record.completed_on = previous?.completed_on ?? null;
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
    const status = milestoneRollupStatus(
      linked.map((task) => task.data),
      asOf,
    );
    milestones.set(milestone.id, {
      status,
      percent: null,
      done: linked.filter((task) => task.data.state === "complete").length,
      total: linked.length,
    });
  }
  const goals = new Map<string, ControlRollup>();
  for (const goal of records) {
    if (goal.kind !== "goal") continue;
    const linked = activeMilestones.filter(
      (milestone) => milestone.data.goal_id === goal.id,
    );
    const statuses = linked.map(
      (milestone) => milestones.get(milestone.id)!.status,
    );
    const rolled = goalRollup(statuses);
    goals.set(goal.id, {
      status: rolled.status,
      percent: rolled.percent,
      done: statuses.filter((status) => status === "done").length,
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
