import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { milestoneCredit } from "../client/scheduleDefinition.js";
import {
  attachControlRollups,
  controlData,
  goalRollup,
  milestoneRollup,
  preserveDerivedControlFields,
  taskRollupStatus,
} from "../src/domain/projectControls.js";

const asOf = "2026-10-26";
const task = (
  state: string,
  due_on: string,
): { state: string; due_on: string } => ({ state, due_on });

describe("task roll-up rules", () => {
  it("uses the task list checks: complete, overdue, and blocked", () => {
    expect(taskRollupStatus(task("complete", "2020-01-01"), asOf)).toBe("done");
    expect(taskRollupStatus(task("in_progress", asOf), asOf)).toBe("on_track");
    expect(taskRollupStatus(task("not_started", "2026-10-25"), asOf)).toBe(
      "late",
    );
    expect(taskRollupStatus(task("blocked", "2026-10-25"), asOf)).toBe("late");
    expect(taskRollupStatus(task("blocked", "2026-11-01"), asOf)).toBe(
      "at_risk",
    );
    expect(taskRollupStatus(task("in_progress", "2026-11-01"), asOf)).toBe(
      "on_track",
    );
  });
});

describe("milestone status from linked tasks", () => {
  it("uses the manual status when a milestone has no tasks", () => {
    expect(milestoneRollup([], asOf, { state: "not_started" })).toMatchObject({
      status: "not_started",
      flag: null,
      done: 0,
      total: 0,
    });
    expect(
      milestoneRollup([], asOf, { state: "in_progress", due_on: "2026-11-01" })
        .status,
    ).toBe("in_progress");
    expect(
      milestoneRollup([], asOf, { state: "complete", due_on: "2020-01-01" }),
    ).toMatchObject({ status: "complete", flag: null });
    expect(
      milestoneRollup([], asOf, { state: "not_started", due_on: "2026-10-20" })
        .flag,
    ).toBe("late");
  });

  it("is not started when no linked task is done, even if one is in progress", () => {
    expect(
      milestoneRollup(
        [task("in_progress", "2026-11-02"), task("not_started", "2026-11-03")],
        asOf,
      ),
    ).toMatchObject({ status: "not_started", flag: null, done: 0, total: 2 });
  });

  it("is in progress when some linked tasks are done", () => {
    expect(
      milestoneRollup(
        [task("complete", "2026-11-01"), task("in_progress", "2026-11-02")],
        asOf,
      ),
    ).toMatchObject({ status: "in_progress", flag: null, done: 1, total: 2 });
  });

  it("is completed only when every linked task is done", () => {
    expect(
      milestoneRollup(
        [task("complete", "2020-01-01"), task("complete", "2026-11-01")],
        asOf,
      ),
    ).toMatchObject({ status: "complete", flag: null, done: 2, total: 2 });
  });

  it("shows late as a flag when any linked task is overdue", () => {
    expect(
      milestoneRollup(
        [task("complete", "2026-11-01"), task("not_started", "2026-10-20")],
        asOf,
      ),
    ).toMatchObject({ status: "in_progress", flag: "late", done: 1, total: 2 });
  });

  it("shows at risk as a flag when a linked task is blocked and none are late", () => {
    expect(
      milestoneRollup(
        [task("in_progress", "2026-11-01"), task("blocked", "2026-11-03")],
        asOf,
      ),
    ).toMatchObject({
      status: "not_started",
      flag: "at_risk",
      done: 0,
      total: 2,
    });
  });
});

describe("goal percent from milestone credit", () => {
  it("leaves the percent unset when a goal has no milestones", () => {
    expect(goalRollup([])).toEqual({
      status: "not_started",
      flag: null,
      percent: null,
    });
  });

  it("gives partial credit for tasks done inside a milestone", () => {
    const threeOfFour = milestoneRollup(
      [
        task("complete", "2026-11-01"),
        task("complete", "2026-11-01"),
        task("complete", "2026-11-01"),
        task("not_started", "2026-11-02"),
      ],
      asOf,
    );
    expect(milestoneCredit({ linkedTotal: 4, linkedDone: 3 })).toBe(0.75);
    expect(milestoneCredit({ state: "complete" })).toBe(1);
    expect(milestoneCredit({ state: "in_progress" })).toBe(0);
    expect(goalRollup([threeOfFour])).toMatchObject({
      status: "in_progress",
      percent: 75,
    });
    expect(
      goalRollup([
        { status: "complete", flag: null, done: 0, total: 0 },
        { status: "not_started", flag: null, done: 0, total: 0 },
      ]),
    ).toMatchObject({ status: "in_progress", percent: 50, flag: null });
    expect(
      goalRollup([
        { status: "complete", flag: null, done: 2, total: 2 },
        { status: "complete", flag: null, done: 1, total: 1 },
      ]),
    ).toMatchObject({ status: "complete", percent: 100 });
  });

  it("counts milestone credit, including a goal with no key results", () => {
    const goal = {
      id: "goal-1",
      kind: "goal",
      active: true,
      data: {
        title: "Room is ready",
        state: "complete",
        key_results: [] as unknown[],
        due_on: "2026-12-01",
      },
    };
    const doneMilestone = {
      id: "m-done",
      kind: "milestone",
      active: true,
      data: { state: "not_started", goal_id: "goal-1", due_on: "2026-11-01" },
    };
    const openMilestone = {
      id: "m-open",
      kind: "milestone",
      active: true,
      data: { state: "complete", goal_id: "goal-1", due_on: "2026-11-08" },
    };
    const records = [
      goal,
      doneMilestone,
      openMilestone,
      {
        id: "t1",
        kind: "task",
        active: true,
        data: {
          state: "complete",
          due_on: "2026-10-01",
          milestone_id: "m-done",
        },
      },
      {
        id: "t2",
        kind: "task",
        active: true,
        data: {
          state: "in_progress",
          due_on: "2026-11-08",
          milestone_id: "m-open",
        },
      },
      {
        id: "t-archived",
        kind: "task",
        active: false,
        data: {
          state: "not_started",
          due_on: "2020-01-01",
          milestone_id: "m-open",
        },
      },
    ];
    const rolled = attachControlRollups(records, asOf);
    expect(goal.data.state).toBe("complete");
    expect(goal.data.key_results).toEqual([]);
    expect(rolled.find((row) => row.id === "goal-1")?.rollup).toEqual({
      status: "in_progress",
      flag: null,
      percent: 50,
      done: 1,
      total: 2,
    });
    expect(rolled.find((row) => row.id === "m-done")?.rollup?.status).toBe(
      "complete",
    );
    expect(rolled.find((row) => row.id === "m-open")?.rollup).toMatchObject({
      status: "not_started",
      flag: null,
      done: 0,
      total: 1,
    });
    expect(
      controlData.goal.parse({ title: "No measure yet", due_on: asOf })
        .key_results,
    ).toEqual([]);
  });

  it("keeps a calculated status when linked tasks exist, and allows a manual status when they do not", () => {
    const stored = { state: "complete", completed_on: "2026-10-01" };
    const incoming = {
      state: "not_started",
      completed_on: null as string | null,
    };
    expect(
      preserveDerivedControlFields("milestone", incoming, stored, 2),
    ).toEqual(stored);
    expect(
      preserveDerivedControlFields(
        "goal",
        { state: "blocked" },
        { state: "in_progress" },
      ).state,
    ).toBe("in_progress");
    expect(
      preserveDerivedControlFields(
        "milestone",
        { state: "complete", completed_on: "2026-10-26" },
        null,
        0,
      ),
    ).toMatchObject({ state: "complete", completed_on: "2026-10-26" });
    expect(
      preserveDerivedControlFields(
        "milestone",
        { state: "blocked", completed_on: null },
        null,
        0,
      ).state,
    ).toBe("in_progress");
  });

  it("shows one milestone percent, a separate late flag, and collapsed key results", () => {
    const ui = readFileSync("client/projectControls.js", "utf8");
    expect(ui).toContain(">Progress</strong>");
    expect(ui).toContain("Add a measured number (optional)");
    expect(ui).toContain('not_started: "Not started"');
    expect(ui).toContain('in_progress: "In progress"');
    expect(ui).toContain('complete: "Completed"');
    expect(ui).toContain('late: "Late"');
    expect(ui).toContain('at_risk: "At risk"');
    expect(ui).toContain("It cannot be set here.");
    expect(ui).toContain("It cannot be typed in.");
    expect(ui).toContain("delete-record");
    expect(ui).toContain("Status (RAG)");
    expect(ui).toContain("Risk register (ROAM)");
    expect(ui).not.toContain("Milestones done");
    expect(ui).not.toContain('["task", "goal", "milestone"]');
    const workspace = readFileSync("client/workspace.js", "utf8");
    expect(workspace).not.toContain('status: "RAG status"');
    expect(workspace).toContain('requested === "status"');
    expect(workspace).toContain('url.hash = "risks"');
  });
});
