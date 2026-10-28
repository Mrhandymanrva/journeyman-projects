import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newYorkDate } from "../src/domain/fieldStart.js";
import { loadProjectHealth } from "../src/domain/projectHealth.js";
import { parseHomeFilters, projectLifecycle } from "../src/domain/homeBoard.js";
import {
  addBusinessUnit,
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const HOME = "/api/v1/projects/home";
const DUE = "/api/v1/projects/home/due";

describe("home filter parsing", () => {
  it("defaults to open and keeps cancelled out of completed", () => {
    expect(parseHomeFilters({}).status).toBe("open");
    expect(parseHomeFilters({ status: "  " }).status).toBe("open");
    expect(parseHomeFilters({ status: "completed" }).status).toBe("completed");
    expect(parseHomeFilters({ status: "cancelled" }).status).toBe("cancelled");
    expect(projectLifecycle("complete")).toBe("completed");
    expect(projectLifecycle("cancelled")).toBe("cancelled");
    expect(projectLifecycle("execution")).toBe("open");
    expect(() => parseHomeFilters({ status: "closed" })).toThrow(/status/);
  });
});

describe("home board", () => {
  let h: Harness;
  let n = 0;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  async function project(
    t: TenantFixture,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const created = await h
      .as(t.staff.owner!.token)
      .post("/api/v1/projects/projects")
      .send(projectBody(overrides));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.data.id as string;
  }

  async function q(
    t: TenantFixture,
    sql: string,
    params: unknown[] = [],
  ): Promise<void> {
    await h.db.withTenant(t.id, (db) => db.query(sql, params));
  }

  it("defaults to open, and completed excludes cancelled", async () => {
    const t = await createTenant(h, { slug: `home-filter-${n++}` });
    const openId = await project(t, {
      project_number: `HB-OPEN-${n}`,
      name: "Open Bath",
    });
    const doneId = await project(t, {
      project_number: `HB-DONE-${n}`,
      name: "Finished Bath",
    });
    const cancelledId = await project(t, {
      project_number: `HB-CAN-${n}`,
      name: "Cancelled Bath",
    });
    await q(
      t,
      `UPDATE projects.projects SET stage = 'execution', source_customer_name = 'Ada Whitfield', pm_id = $2 WHERE id = $1`,
      [openId, t.staff.pm!.id],
    );
    await q(
      t,
      `UPDATE projects.projects SET stage = 'complete', source_customer_name = 'Pat Delaney', pm_id = $2 WHERE id = $1`,
      [doneId, t.staff.owner!.id],
    );
    await q(
      t,
      `UPDATE projects.projects SET stage = 'cancelled', source_customer_name = 'Ada Whitfield' WHERE id = $1`,
      [cancelledId],
    );

    const owner = h.as(t.staff.owner!.token);
    const def = await owner.get(HOME);
    expect(def.status, JSON.stringify(def.body)).toBe(200);
    expect(def.body.data.status).toBe("open");
    expect(def.body.data.projects.map((row: { id: string }) => row.id)).toEqual(
      [openId],
    );
    expect(def.body.data.projects[0].lifecycle).toBe("open");
    expect(def.body.data.projects[0].customer).toBe("Ada Whitfield");
    expect(def.body.data.projects[0].pm_name).toBe("pm");

    const completed = await owner.get(HOME).query({ status: "completed" });
    expect(completed.status).toBe(200);
    expect(
      completed.body.data.projects.map((row: { id: string }) => row.id),
    ).toEqual([doneId]);
    expect(completed.body.data.projects[0].lifecycle).toBe("completed");
    expect(
      completed.body.data.projects.some(
        (row: { id: string }) => row.id === cancelledId,
      ),
    ).toBe(false);

    const cancelled = await owner.get(HOME).query({ status: "cancelled" });
    expect(
      cancelled.body.data.projects.map((row: { id: string }) => row.id),
    ).toEqual([cancelledId]);
    expect(cancelled.body.data.projects[0].lifecycle).toBe("cancelled");

    const all = await owner.get(HOME).query({ status: "all" });
    expect(
      new Set(all.body.data.projects.map((row: { id: string }) => row.id)),
    ).toEqual(new Set([openId, doneId, cancelledId]));

    const searched = await owner
      .get(HOME)
      .query({ status: "all", q: "Ada Whitfield" });
    expect(
      new Set(searched.body.data.projects.map((row: { id: string }) => row.id)),
    ).toEqual(new Set([openId, cancelledId]));
    const completedSearch = await owner
      .get(HOME)
      .query({ status: "completed", q: "Ada" });
    expect(completedSearch.body.data.projects).toEqual([]);

    const byStage = await owner
      .get(HOME)
      .query({ status: "open", stage: "execution" });
    expect(
      byStage.body.data.projects.map((row: { id: string }) => row.id),
    ).toEqual([openId]);
    const byPm = await owner
      .get(HOME)
      .query({ status: "all", pm_id: t.staff.pm!.id });
    expect(
      byPm.body.data.projects.map((row: { id: string }) => row.id),
    ).toEqual([openId]);

    const today = newYorkDate(new Date().toISOString());
    const health = await h.db.withTenant(t.id, (db) =>
      loadProjectHealth(db, today),
    );
    const expected = health.find((row) => row.project_id === openId);
    expect(def.body.data.projects[0].health.score).toBe(expected?.health.score);
    expect(def.body.data.projects[0].health.band).toBe(expected?.health.band);

    expect((await owner.get(HOME).query({ status: "nope" })).status).toBe(400);
    expect((await h.request.get(HOME)).status).toBe(401);
    expect((await h.request.get(DUE)).status).toBe(401);
  });

  it("unions WBS tasks, precon tasks, milestones, and Gantt activities", async () => {
    const t = await createTenant(h, { slug: `home-due-${n++}` });
    const projectId = await project(t, {
      project_number: `HB-DUE-${n}`,
      name: "Due Bath",
    });
    const today = newYorkDate(new Date().toISOString());
    const yesterday = shift(today, -1);
    const tomorrow = shift(today, 1);
    const ownerId = t.staff.pm!.id;

    const control = async (
      kind: string,
      data: Record<string, unknown>,
      active = true,
    ) => {
      const result = await h.db.withTenant(t.id, (db) =>
        db.query<{ id: string }>(
          `INSERT INTO projects.project_controls (tenant_id, project_id, kind, data, active)
           VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
          [t.id, projectId, kind, JSON.stringify(data), active],
        ),
      );
      return result.rows[0]!.id;
    };
    const task = (
      title: string,
      due: string,
      state: string,
      milestoneId?: string,
    ) =>
      control("task", {
        title,
        due_on: due,
        start_on: due,
        state,
        owner_id: ownerId,
        milestone_id: milestoneId ?? null,
      });

    await task("Alpha overdue wbs", yesterday, "in_progress");
    await task("Charlie due wbs", today, "not_started");
    await task("Future wbs", tomorrow, "not_started");
    await task("Done wbs", yesterday, "complete");
    await control(
      "task",
      {
        title: "Archived wbs",
        due_on: yesterday,
        start_on: yesterday,
        state: "not_started",
      },
      false,
    );

    const doneMilestone = await control("milestone", {
      title: "Done milestone",
      due_on: yesterday,
      state: "not_started",
      owner_id: ownerId,
    });
    await task("Child done a", yesterday, "complete", doneMilestone);
    await task("Child done b", yesterday, "complete", doneMilestone);

    await control("milestone", {
      title: "Alpha overdue milestone",
      due_on: yesterday,
      state: "complete",
      owner_id: ownerId,
    });
    const openStored = await h.db.withTenant(t.id, (db) =>
      db.query<{ id: string }>(
        `SELECT id FROM projects.project_controls
          WHERE project_id = $1 AND data->>'title' = 'Alpha overdue milestone'`,
        [projectId],
      ),
    );
    await task(
      "Still open child",
      tomorrow,
      "in_progress",
      openStored.rows[0]!.id,
    );

    await control("milestone", {
      title: "Charlie due milestone",
      due_on: today,
      state: "not_started",
    });
    await control("milestone", {
      title: "Future milestone",
      due_on: tomorrow,
      state: "not_started",
    });
    await control("milestone", {
      title: "Manual done milestone",
      due_on: yesterday,
      state: "complete",
    });

    await q(
      t,
      `INSERT INTO projects.precon_tasks
         (tenant_id, project_id, task_type, title, owner_role, due_on, status, sort_order)
       VALUES
         ($1, $2, 'other', 'Alpha overdue precon', 'project_manager', $3::date, 'not_started', 20),
         ($1, $2, 'other', 'Charlie due precon', 'estimator', $4::date, 'in_progress', 21),
         ($1, $2, 'other', 'Done precon', 'project_manager', $3::date, 'done', 22),
         ($1, $2, 'other', 'Waived precon', 'project_manager', $3::date, 'waived', 23),
         ($1, $2, 'other', 'Future precon', 'project_manager', $5::date, 'not_started', 24)`,
      [t.id, projectId, yesterday, today, tomorrow],
    );

    const jurisdiction = await h.db.withTenant(t.id, (db) =>
      db.query<{ id: string }>(
        `INSERT INTO projects.jurisdictions (tenant_id, name, state) VALUES ($1, $2, 'VA') RETURNING id`,
        [t.id, `Home City ${n}`],
      ),
    );
    const permit = await h.db.withTenant(t.id, (db) =>
      db.query<{ id: string }>(
        `INSERT INTO projects.permits (tenant_id, project_id, jurisdiction_id, permit_type)
         VALUES ($1, $2, $3, 'Building') RETURNING id`,
        [t.id, projectId, jurisdiction.rows[0]!.id],
      ),
    );
    await q(
      t,
      `INSERT INTO projects.permit_milestones
         (tenant_id, permit_id, sequence_number, name, owner_role, due_on, status)
       VALUES
         ($1, $2, 1, 'Bravo overdue permit', 'office', $3::date, 'in_progress'),
         ($1, $2, 2, 'Delta due permit', 'project_manager', $4::date, 'pending'),
         ($1, $2, 3, 'Complete permit', 'office', $3::date, 'complete'),
         ($1, $2, 4, 'Future permit', 'office', $5::date, 'pending')`,
      [t.id, permit.rows[0]!.id, yesterday, today, tomorrow],
    );
    await q(
      t,
      `INSERT INTO projects.schedule_items
         (tenant_id, project_id, title, window_start, window_end, status)
       VALUES
         ($1, $2, 'Gantt activity due today', $3::date, $3::date, 'confirmed'),
         ($1, $2, 'Future gantt', $4::date, $4::date, 'proposed'),
         ($1, $2, 'Finished gantt', $5::date, $5::date, 'complete')`,
      [t.id, projectId, today, tomorrow, yesterday],
    );

    const due = await h.as(t.staff.office!.token).get(DUE);
    expect(due.status, JSON.stringify(due.body)).toBe(200);
    expect(due.body.data.today).toBe(today);
    const titles = due.body.data.items.map(
      (item: { title: string }) => item.title,
    );
    expect(titles).toEqual([
      "Alpha overdue milestone",
      "Alpha overdue precon",
      "Alpha overdue wbs",
      "Bravo overdue permit",
      "Charlie due milestone",
      "Charlie due precon",
      "Charlie due wbs",
      "Delta due permit",
      "Gantt activity due today",
    ]);
    const absent = [
      "Done wbs",
      "Archived wbs",
      "Future wbs",
      "Done milestone",
      "Child done a",
      "Future milestone",
      "Done precon",
      "Waived precon",
      "Future precon",
      "Complete permit",
      "Future permit",
      "Future gantt",
      "Finished gantt",
      "Manual done milestone",
    ];
    for (const title of absent) expect(titles).not.toContain(title);

    const byTitle = new Map(
      due.body.data.items.map((item: { title: string }) => [item.title, item]),
    );
    const wbs = byTitle.get("Alpha overdue wbs") as {
      item_type: string;
      overdue: boolean;
      owner_name: string;
      href: string;
    };
    expect(wbs.item_type).toBe("wbs_task");
    expect(wbs.overdue).toBe(true);
    expect(wbs.owner_name).toBe("pm");
    expect(wbs.href).toContain("plan=tasks");
    expect(wbs.href).toContain("#plan");

    const precon = byTitle.get("Charlie due precon") as {
      item_type: string;
      overdue: boolean;
      owner_role: string;
      href: string;
    };
    expect(precon.item_type).toBe("precon_task");
    expect(precon.overdue).toBe(false);
    expect(precon.owner_role).toBe("estimator");
    expect(precon.href).toContain("#precon-permits");

    const milestone = byTitle.get("Charlie due milestone") as {
      item_type: string;
      href: string;
    };
    expect(milestone.item_type).toBe("milestone");
    expect(milestone.href).toContain("plan=roadmap");

    const permitItem = byTitle.get("Bravo overdue permit") as {
      item_type: string;
      overdue: boolean;
      href: string;
    };
    expect(permitItem.item_type).toBe("permit_milestone");
    expect(permitItem.overdue).toBe(true);
    expect(permitItem.href).toContain("#precon-permits");

    const gantt = byTitle.get("Gantt activity due today") as {
      item_type: string;
      overdue: boolean;
      href: string;
    };
    expect(gantt.item_type).toBe("activity");
    expect(gantt.overdue).toBe(false);
    expect(gantt.href).toContain("plan=gantt");

    const board = await h.as(t.staff.owner!.token).get(HOME);
    expect(board.body.data.projects[0].next_milestone.title).toBe(
      "Alpha overdue milestone",
    );
    expect(board.body.data.projects[0].next_milestone.due_on).toBe(yesterday);

    for (const key of ["office", "estimator", "bookkeeper", "pm"] as const) {
      const response = await h.as(t.staff[key]!.token).get(DUE);
      expect(response.status, key).toBe(200);
      expect(response.body.data.items).toHaveLength(titles.length);
    }
  });

  it("limits a unit-scoped project manager to the projects they can already list", async () => {
    const t = await createTenant(h, {
      slug: `home-scope-${n++}`,
      enforceBusinessUnitScoping: true,
      staff: [
        { key: "owner", email: `owner-${n}@example.test`, role: "owner" },
        {
          key: "pm",
          email: `pm-${n}@example.test`,
          role: "project_manager",
          unit: "Main",
        },
        { key: "office", email: `office-${n}@example.test`, role: "office" },
      ],
    });
    const otherUnit = await addBusinessUnit(h, t, "Other");
    const mine = await project(t, {
      project_number: `HB-MINE-${n}`,
      name: "My unit job",
      business_unit_id: t.businessUnits.Main,
    });
    const theirs = await project(t, {
      project_number: `HB-OTHER-${n}`,
      name: "Other unit job",
      business_unit_id: otherUnit,
    });
    const today = newYorkDate(new Date().toISOString());
    for (const id of [mine, theirs]) {
      await q(
        t,
        `INSERT INTO projects.project_controls (tenant_id, project_id, kind, data)
         VALUES ($1, $2, 'task', $3::jsonb)`,
        [
          t.id,
          id,
          JSON.stringify({
            title: id === mine ? "Visible task" : "Hidden task",
            due_on: today,
            start_on: today,
            state: "not_started",
          }),
        ],
      );
    }

    const pm = h.as(t.staff.pm!.token);
    const home = await pm.get(HOME).query({ status: "all" });
    expect(home.status, JSON.stringify(home.body)).toBe(200);
    expect(
      home.body.data.projects.map((row: { id: string }) => row.id),
    ).toEqual([mine]);
    const listed = await pm.get("/api/v1/projects/projects?per_page=200");
    expect(listed.body.data.map((row: { id: string }) => row.id)).toContain(
      mine,
    );
    expect(listed.body.data.map((row: { id: string }) => row.id)).not.toContain(
      theirs,
    );

    const due = await pm.get(DUE);
    expect(
      due.body.data.items.map((item: { title: string }) => item.title),
    ).toEqual(["Visible task"]);

    const office = await h
      .as(t.staff.office!.token)
      .get(HOME)
      .query({ status: "all" });
    expect(
      new Set(office.body.data.projects.map((row: { id: string }) => row.id)),
    ).toEqual(new Set([mine, theirs]));

    const foreign = await createTenant(h, { slug: `home-foreign-${n++}` });
    const outsider = await h
      .as(foreign.staff.owner!.token)
      .get(HOME)
      .query({ status: "all" });
    expect(outsider.status).toBe(200);
    expect(
      outsider.body.data.projects.some((row: { name: string }) =>
        ["My unit job", "Other unit job"].includes(row.name),
      ),
    ).toBe(false);
    const outsiderDue = await h.as(foreign.staff.owner!.token).get(DUE);
    expect(
      outsiderDue.body.data.items.some((item: { title: string }) =>
        ["Visible task", "Hidden task"].includes(item.title),
      ),
    ).toBe(false);
  });
});

function shift(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, (month ?? 1) - 1, (date ?? 1) + days))
    .toISOString()
    .slice(0, 10);
}
