import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

/**
 * Preconstruction tasks: the shipped template, staff edits, and the rule that
 * a task can point only at a material purchase order on the same project.
 * Overdue is today in America/New_York, not the database session's zone.
 */
describe("preconstruction tasks", () => {
  let h: Harness;
  let t: TenantFixture;
  let other: TenantFixture;

  beforeAll(async () => {
    h = await startHarness();
    t = await createTenant(h, { slug: "precon" });
    other = await createTenant(h, { slug: "precon-other" });
  });
  afterAll(async () => {
    await h?.close();
  });

  const as = (key: keyof TenantFixture["staff"]) => h.as(t.staff[key]!.token);

  async function nyDay(offset: number): Promise<string> {
    const { rows } = await h.db.withTenant(t.id, (db) =>
      db.query<{ day: string }>(
        `SELECT ((now() AT TIME ZONE 'America/New_York')::date + $1::int)::text AS day`,
        [offset],
      ),
    );
    return rows[0]!.day;
  }

  it("seeds the default template from the logged start and lets a coordinator waive any task", async () => {
    const created = await as("owner")
      .post("/api/v1/projects/projects")
      .send(
        projectBody({
          project_number: "PRE-1",
          name: "Precon seed",
          scheduled_start: "2026-11-01",
        }),
      );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.tasks_created).toBe(7);

    const list = await as("office").get(
      `/api/v1/projects/projects/${created.body.data.id}/precon-tasks`,
    );
    expect(list.status).toBe(200);
    const tasks = list.body.data as Array<{
      title: string;
      type: string;
      owner_role: string;
      due_on: string;
      status: string;
      overdue: boolean;
    }>;
    expect(
      tasks.map((task) => [
        task.type,
        task.title,
        task.owner_role,
        task.due_on,
      ]),
    ).toEqual([
      ["site_visit", "Site visit and measure", "estimator", "2026-11-04"],
      ["plans", "Plans or drawings", "project_manager", "2026-11-08"],
      [
        "selection",
        "Selections confirmed with customer",
        "project_manager",
        "2026-11-11",
      ],
      [
        "permit",
        "Permit application submitted",
        "project_manager",
        "2026-11-11",
      ],
      ["material_order", "Materials ordered", "project_manager", "2026-11-15"],
      ["other", "Subs booked", "project_manager", "2026-11-15"],
      ["permit", "Permit approved", "project_manager", "2026-11-22"],
    ]);
    expect(
      tasks.every(
        (task) => task.status === "not_started" && task.overdue === false,
      ),
    ).toBe(true);

    const session = await as("pm").get("/api/v1/projects/session");
    expect(session.body.data.capabilities).toContain("manage_precon_tasks");
    const office = await as("office").get("/api/v1/projects/session");
    expect(office.body.data.capabilities).not.toContain("manage_precon_tasks");

    const siteId = (
      list.body.data as Array<{ id: string; title: string }>
    ).find((task) => task.title === "Site visit and measure")!.id;
    const waived = await as("pm")
      .patch(`/api/v1/projects/precon-tasks/${siteId}`)
      .send({ status: "waived", notes: "  Customer postponed the visit  " });
    expect(waived.status, JSON.stringify(waived.body)).toBe(200);
    expect(waived.body.data.status).toBe("waived");
    expect(waived.body.data.notes).toBe("Customer postponed the visit");
    expect(waived.body.data.overdue).toBe(false);

    const forbidden = await as("estimator")
      .patch(`/api/v1/projects/precon-tasks/${siteId}`)
      .send({ status: "done" });
    expect(forbidden.status).toBe(403);
    const bookkeeper = await as("bookkeeper")
      .post(`/api/v1/projects/projects/${created.body.data.id}/precon-tasks`)
      .send({ type: "other", title: "Extra", owner_role: "project_manager" });
    expect(bookkeeper.status).toBe(403);
  });

  it("counts a task overdue only before today in America/New_York, and never when waived or done", async () => {
    const created = await as("manager")
      .post("/api/v1/projects/projects")
      .send(projectBody({ project_number: "PRE-DUE", name: "Due dates" }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const projectId = created.body.data.id as string;
    const tasks = (
      await as("owner").get(
        `/api/v1/projects/projects/${projectId}/precon-tasks`,
      )
    ).body.data as Array<{ id: string; title: string }>;
    const open = tasks.find((task) => task.title === "Plans or drawings")!;
    const finished = tasks.find((task) => task.title === "Subs booked")!;
    const skipped = tasks.find((task) => task.title === "Materials ordered")!;
    const yesterday = await nyDay(-1);
    const today = await nyDay(0);

    const late = await as("owner")
      .patch(`/api/v1/projects/precon-tasks/${open.id}`)
      .send({ due_on: yesterday, status: "in_progress" });
    expect(late.status, JSON.stringify(late.body)).toBe(200);
    expect(late.body.data.overdue).toBe(true);
    expect(late.body.data.due_on).toBe(yesterday);

    const dueToday = await as("owner")
      .patch(`/api/v1/projects/precon-tasks/${open.id}`)
      .send({ due_on: today });
    expect(dueToday.body.data.overdue).toBe(false);

    await as("owner")
      .patch(`/api/v1/projects/precon-tasks/${finished.id}`)
      .send({ due_on: yesterday, status: "done" });
    await as("owner")
      .patch(`/api/v1/projects/precon-tasks/${skipped.id}`)
      .send({ due_on: yesterday, status: "waived" });
    const after = (
      await as("pm").get(`/api/v1/projects/projects/${projectId}/precon-tasks`)
    ).body.data as Array<{ id: string; overdue: boolean }>;
    expect(after.find((task) => task.id === finished.id)?.overdue).toBe(false);
    expect(after.find((task) => task.id === skipped.id)?.overdue).toBe(false);

    await as("owner")
      .patch(`/api/v1/projects/precon-tasks/${open.id}`)
      .send({ due_on: yesterday, status: "not_started" });
    const overdueAgain = (
      await as("office").get(
        `/api/v1/projects/projects/${projectId}/precon-tasks`,
      )
    ).body.data as Array<{ id: string; overdue: boolean }>;
    expect(overdueAgain.find((task) => task.id === open.id)?.overdue).toBe(
      true,
    );
  });

  it("applies the template once, and refuses a second copy", async () => {
    const created = await as("owner")
      .post("/api/v1/projects/projects")
      .send(
        projectBody({
          project_number: "PRE-APPLY",
          scheduled_start: "2026-11-02",
          name: "Apply template",
        }),
      );
    const projectId = created.body.data.id as string;
    const again = await as("pm")
      .post(
        `/api/v1/projects/projects/${projectId}/precon-tasks/apply-template`,
      )
      .send({});
    expect(again.status, JSON.stringify(again.body)).toBe(409);

    await h.db.withTenant(t.id, (db) =>
      db.query(`DELETE FROM projects.precon_tasks WHERE project_id = $1`, [
        projectId,
      ]),
    );
    const applied = await as("pm")
      .post(
        `/api/v1/projects/projects/${projectId}/precon-tasks/apply-template`,
      )
      .send({});
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expect(applied.body.data).toHaveLength(7);
    expect(applied.body.data[0].due_on).toBe("2026-11-05");
    const duplicate = await as("manager")
      .post(
        `/api/v1/projects/projects/${projectId}/precon-tasks/apply-template`,
      )
      .send({});
    expect(duplicate.status).toBe(409);
    const still = await as("office").get(
      `/api/v1/projects/projects/${projectId}/precon-tasks`,
    );
    expect(still.body.data).toHaveLength(7);
  });

  it("inserts nothing when the tenant template is empty", async () => {
    await h.db.withTenant(t.id, (db) =>
      db.query(
        `DELETE FROM projects.precon_task_templates WHERE tenant_id = $1`,
        [t.id],
      ),
    );
    const created = await as("owner")
      .post("/api/v1/projects/projects")
      .send(projectBody({ project_number: "PRE-EMPTY", name: "No template" }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.tasks_created).toBe(0);
    await h.db.withTenant(t.id, (db) =>
      db.query(`SELECT projects.activate_tenant($1)`, [t.id]),
    );
    const restored = await h.db.withTenant(t.id, (db) =>
      db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.precon_task_templates`,
      ),
    );
    expect(Number(restored.rows[0]?.n)).toBe(7);
  });

  it("links a material order on the same project and rejects a subcontract or another project's order", async () => {
    const created = await as("owner")
      .post("/api/v1/projects/projects")
      .send(projectBody({ project_number: "PRE-PO", name: "Material link" }));
    const projectId = created.body.data.id as string;
    const otherProject = await as("owner")
      .post("/api/v1/projects/projects")
      .send(projectBody({ project_number: "PRE-PO-2", name: "Other job" }));
    const otherId = otherProject.body.data.id as string;
    const code = await h.db.withTenant(t.id, (db) =>
      db.query<{ id: string }>(`SELECT id FROM projects.cost_codes LIMIT 1`),
    );
    const costCodeId = code.rows[0]!.id;
    const ids = await h.db.withTenant(t.id, async (db) => {
      const material = await db.query<{ id: string }>(
        `INSERT INTO projects.purchase_orders
           (tenant_id, project_id, po_number, supplier_name, cost_code_id, cost_type, amount, scope_text, kind)
         VALUES ($1,$2,'MAT-PRE',$3,$4,'M',640,'Lumber','material')
         RETURNING id`,
        [t.id, projectId, "Yard", costCodeId],
      );
      const subcontract = await db.query<{ id: string }>(
        `INSERT INTO projects.purchase_orders
           (tenant_id, project_id, po_number, supplier_name, cost_code_id, cost_type, amount, scope_text, kind)
         VALUES ($1,$2,'SUB-PRE',$3,$4,'S',900,'Tile','subcontract')
         RETURNING id`,
        [t.id, projectId, "Tile Co", costCodeId],
      );
      const elsewhere = await db.query<{ id: string }>(
        `INSERT INTO projects.purchase_orders
           (tenant_id, project_id, po_number, supplier_name, cost_code_id, cost_type, amount, scope_text, kind)
         VALUES ($1,$2,'MAT-ELSE',$3,$4,'M',100,'Nails','material')
         RETURNING id`,
        [t.id, otherId, "Yard", costCodeId],
      );
      await db.query(
        `INSERT INTO projects.vendor_bills
           (tenant_id, po_id, vendor_invoice_number, amount, status)
         VALUES ($1,$2,'YB-1',640,'received')`,
        [t.id, material.rows[0]!.id],
      );
      return {
        material: material.rows[0]!.id,
        subcontract: subcontract.rows[0]!.id,
        elsewhere: elsewhere.rows[0]!.id,
      };
    });

    const tasks = (
      await as("pm").get(`/api/v1/projects/projects/${projectId}/precon-tasks`)
    ).body.data as Array<{ id: string; type: string }>;
    const materialTask = tasks.find((task) => task.type === "material_order")!;
    const permitTask = tasks.find((task) => task.type === "permit")!;

    const subcontract = await as("pm")
      .patch(`/api/v1/projects/precon-tasks/${materialTask.id}`)
      .send({ purchase_order_id: ids.subcontract });
    expect(subcontract.status, JSON.stringify(subcontract.body)).toBe(400);

    const wrongProject = await as("pm")
      .patch(`/api/v1/projects/precon-tasks/${materialTask.id}`)
      .send({ purchase_order_id: ids.elsewhere });
    expect(wrongProject.status).toBe(400);

    const onPermit = await as("pm")
      .patch(`/api/v1/projects/precon-tasks/${permitTask.id}`)
      .send({ purchase_order_id: ids.material });
    expect(onPermit.status).toBe(400);

    const linked = await as("owner")
      .patch(`/api/v1/projects/precon-tasks/${materialTask.id}`)
      .send({ purchase_order_id: ids.material });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.data.material_order_number).toBe("MAT-PRE");
    expect(linked.body.data.material_order_amount).toBe(640);
    expect(linked.body.data.card_charge_state).toBe("awaiting_card_charge");
    expect(linked.body.data.purchase_order_id).toBe(ids.material);

    const hidden = await h
      .as(other.staff.owner!.token)
      .patch(`/api/v1/projects/precon-tasks/${materialTask.id}`)
      .send({ status: "done" });
    expect(hidden.status).toBe(404);
  });

  it("records inspections only on a permit task and returns the permit number", async () => {
    const created = await as("owner")
      .post("/api/v1/projects/projects")
      .send(projectBody({ project_number: "PRE-INSP", name: "Inspections" }));
    const projectId = created.body.data.id as string;
    const jurisdiction = await as("owner")
      .post("/api/v1/projects/jurisdictions")
      .send({
        name: "Precon County",
        state: "VA",
        portal_url: "https://permits.example.test",
        contact_phone: "804-555-0100",
        typical_review_days: 12,
      });
    expect(jurisdiction.status, JSON.stringify(jurisdiction.body)).toBe(201);
    const permit = await as("pm")
      .post(`/api/v1/projects/projects/${projectId}/permits`)
      .send({
        jurisdiction_id: jurisdiction.body.data.id,
        permit_type: "building",
        permit_number: "BLD-44",
      });
    expect(permit.status, JSON.stringify(permit.body)).toBe(201);

    const tasks = (
      await as("pm").get(`/api/v1/projects/projects/${projectId}/precon-tasks`)
    ).body.data as Array<{ id: string; type: string; title: string }>;
    const permitTask = tasks.find(
      (task) => task.title === "Permit application submitted",
    )!;
    const otherTask = tasks.find((task) => task.type === "plans")!;

    const rejected = await as("pm")
      .post(`/api/v1/projects/precon-tasks/${otherTask.id}/inspections`)
      .send({ scheduled_on: "2026-11-01" });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);

    const added = await as("manager")
      .patch(`/api/v1/projects/precon-tasks/${permitTask.id}`)
      .send({
        jurisdiction_id: jurisdiction.body.data.id,
        permit_id: permit.body.data.id,
      });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.data.permit_number).toBe("BLD-44");
    expect(added.body.data.jurisdiction_name).toBe("Precon County");
    expect(added.body.data.portal_url).toBe("https://permits.example.test");
    expect(added.body.data.office).toMatchObject({
      name: "Precon County",
      main_phone: "804-555-0100",
      portal_url: "https://permits.example.test",
      typical_review_days: 12,
    });

    const inspection = await as("pm")
      .post(`/api/v1/projects/precon-tasks/${permitTask.id}/inspections`)
      .send({ scheduled_on: "2026-11-03", notes: "Rough electrical" });
    expect(inspection.status, JSON.stringify(inspection.body)).toBe(201);
    expect(inspection.body.data.result).toBe("pending");

    const failed = await as("owner")
      .patch(`/api/v1/projects/precon-inspections/${inspection.body.data.id}`)
      .send({ result: "failed", occurred_on: "2026-11-03" });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body.data.result).toBe("failed");

    const removed = await as("pm").del(
      `/api/v1/projects/precon-inspections/${inspection.body.data.id}`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.data.deleted).toBe(true);
    const after = await as("office").get(
      `/api/v1/projects/projects/${projectId}/precon-tasks`,
    );
    const row = (
      after.body.data as Array<{ id: string; inspections: unknown[] }>
    ).find((task) => task.id === permitTask.id);
    expect(row?.inspections).toEqual([]);

    const trade = await as("pm")
      .post(`/api/v1/projects/projects/${projectId}/precon-tasks`)
      .send({
        type: "permit",
        title: "Electrical permit",
        owner_role: "project_manager",
        jurisdiction_id: jurisdiction.body.data.id,
      });
    expect(trade.status, JSON.stringify(trade.body)).toBe(201);
    expect(trade.body.data.type).toBe("permit");
    expect(trade.body.data.title).toBe("Electrical permit");

    const secret = await as("owner")
      .post(`/api/v1/projects/projects/${projectId}/precon-tasks`)
      .send({
        type: "other",
        title: "Nope",
        owner_role: "owner",
        password: "secret",
      });
    expect(secret.status).toBe(400);
  });
});
