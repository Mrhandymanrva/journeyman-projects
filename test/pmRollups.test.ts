import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  attachControlRollups,
  controlData,
  goalRollup,
  milestoneRollupStatus,
  preserveDerivedControlFields,
  taskRollupStatus,
  type RollupStatus,
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
  it("stays on track when a milestone has no tasks", () => {
    expect(milestoneRollupStatus([], asOf)).toBe("on_track");
  });

  it("stays on track when only some tasks are done", () => {
    expect(
      milestoneRollupStatus(
        [task("complete", "2026-11-01"), task("in_progress", "2026-11-02")],
        asOf,
      ),
    ).toBe("on_track");
  });

  it("is done only when every linked task is done", () => {
    expect(
      milestoneRollupStatus(
        [task("complete", "2020-01-01"), task("complete", "2026-11-01")],
        asOf,
      ),
    ).toBe("done");
  });

  it("is late when any linked task is overdue", () => {
    expect(
      milestoneRollupStatus(
        [task("complete", "2026-11-01"), task("not_started", "2026-10-20")],
        asOf,
      ),
    ).toBe("late");
  });

  it("is at risk when a linked task is blocked and none are late", () => {
    expect(
      milestoneRollupStatus(
        [task("in_progress", "2026-11-01"), task("blocked", "2026-11-03")],
        asOf,
      ),
    ).toBe("at_risk");
  });
});

describe("goal percent from completed milestones", () => {
  it("leaves the percent unset when a goal has no milestones", () => {
    expect(goalRollup([])).toEqual({ status: "on_track", percent: null });
  });

  it("counts only milestones that are done, including a goal with no key results", () => {
    const statuses: RollupStatus[] = ["done", "on_track", "late", "at_risk"];
    expect(goalRollup(statuses)).toEqual({ status: "late", percent: 25 });
    expect(goalRollup(["done", "done"])).toEqual({
      status: "done",
      percent: 100,
    });
    expect(goalRollup(["on_track", "on_track"])).toEqual({
      status: "on_track",
      percent: 0,
    });

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
      status: "on_track",
      percent: 50,
      done: 1,
      total: 2,
    });
    expect(rolled.find((row) => row.id === "m-done")?.rollup?.status).toBe(
      "done",
    );
    expect(rolled.find((row) => row.id === "m-open")?.rollup).toMatchObject({
      status: "on_track",
      done: 0,
      total: 1,
    });
    expect(
      controlData.goal.parse({ title: "No measure yet", due_on: asOf })
        .key_results,
    ).toEqual([]);
  });

  it("keeps a stored status when a save tries to type a new one", () => {
    const stored = { state: "complete", completed_on: "2026-10-01" };
    const incoming = {
      state: "not_started",
      completed_on: null as string | null,
    };
    expect(preserveDerivedControlFields("milestone", incoming, stored)).toEqual(
      stored,
    );
    expect(
      preserveDerivedControlFields(
        "goal",
        { state: "blocked" },
        { state: "in_progress" },
      ).state,
    ).toBe("in_progress");
    expect(
      preserveDerivedControlFields("milestone", { state: "complete" }, null)
        .state,
    ).toBe("not_started");
  });

  it("shows the calculated status and percent with the existing color tokens", () => {
    const ui = readFileSync("client/projectControls.js", "utf8");
    expect(ui).toContain("Milestones done");
    expect(ui).toContain('done: "complete"');
    expect(ui).toContain('late: "red"');
    expect(ui).toContain('at_risk: "amber"');
    expect(ui).toContain('on_track: "green"');
    expect(ui).toContain("status-${esc(rollupTone[rollup.status]");
    expect(ui).toContain("It cannot be set here.");
    expect(ui).toContain("It cannot be typed in.");
    expect(ui).not.toContain('["task", "goal", "milestone"]');
  });
});
