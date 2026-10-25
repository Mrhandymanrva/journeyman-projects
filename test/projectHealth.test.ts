import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import { loadProjectHealth, type HealthCode, type ProjectHealthRow } from "../src/domain/projectHealth.js";
import { runHealthSnapshots, startHealthSnapshotScheduler } from "../src/workers/healthSnapshot.js";
import {
  SCHEMA_FILES,
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const TODAY = "2026-10-25";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let h: Harness;
let t: TenantFixture;
let projectId: string;
let n = 0;

beforeAll(async () => {
  h = await startHarness(SCHEMA_FILES);
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  t = await createTenant(h, { slug: `health-${n++}` });
  const created = await owner().post("/api/v1/projects/projects").send(projectBody());
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  projectId = created.body.data.id as string;
  await q(
    `UPDATE projects.precon_tasks SET due_on = '2026-12-01' WHERE project_id = $1`,
    [projectId],
  );
});

const owner = () => h.as(t.staff.owner!.token);

async function q(sql: string, params: unknown[] = []): Promise<void> {
  await h.db.withTenant(t.id, (db) => db.query(sql, params));
}

async function one<R>(sql: string, params: unknown[] = []): Promise<R> {
  const result = await h.db.withTenant(t.id, (db) => db.query<R>(sql, params));
  return result.rows[0] as R;
}

async function health(today = TODAY): Promise<ProjectHealthRow> {
  const rows = await h.db.withTenant(t.id, (db) => loadProjectHealth(db, today));
  const row = rows.find((item) => item.project_id === projectId);
  expect(row, "health row").toBeTruthy();
  return row!;
}

function reason(row: ProjectHealthRow, code: HealthCode) {
  return row.health.reasons.filter((item) => item.code === code);
}

function nyNoon(day: string): string {
  return `${day}T16:00:00Z`;
}

function shift(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, (month ?? 1) - 1, (date ?? 1) + days)).toISOString().slice(0, 10);
}

async function costCode(code: string): Promise<string> {
  const row = await one<{ id: string }>(
    `SELECT id FROM projects.cost_codes WHERE code = $1`,
    [code],
  );
  return row.id;
}

async function budget(code: string, costType: string, amount: number): Promise<string> {
  const id = await costCode(code);
  await q(
    `INSERT INTO projects.budget_lines (tenant_id, project_id, cost_code_id, cost_type, budget_amount)
     VALUES ($1, $2, $3, $4, $5)`,
    [t.id, projectId, id, costType, amount],
  );
  return id;
}

async function commitPo(codeId: string, costType: string, amount: number, poNumber: string): Promise<void> {
  const inserted = await one<{ id: string }>(
    `INSERT INTO projects.purchase_orders
       (tenant_id, project_id, po_number, supplier_name, cost_code_id, cost_type, amount, scope_text, status, kind)
     VALUES ($1, $2, $3, 'Yard', $4, $5, 1, 'Work', 'issued', 'material')
     RETURNING id`,
    [t.id, projectId, poNumber, codeId, costType],
  );
  await q(
    `INSERT INTO projects.po_lines
       (tenant_id, po_id, line_no, cost_code_id, cost_type, description, original_amount)
     VALUES ($1, $2, 1, $3, $4, '', $5)`,
    [t.id, inserted.id, codeId, costType, amount],
  );
}

async function fieldStart(date: string): Promise<void> {
  const saved = await owner().put(`/api/v1/projects/projects/${projectId}/field-start`).send({ date });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
}

describe("project health", () => {
  it("does not flag a logged start that has passed or is near when field start is empty", async () => {
    await q(`UPDATE projects.projects SET scheduled_start = '2026-09-01' WHERE id = $1`, [projectId]);
    const past = await health();
    expect(reason(past, "field_start")).toEqual([]);
    expect(past.health).toEqual({ score: 100, band: "green", reasons: [] });

    await q(`UPDATE projects.projects SET scheduled_start = $2 WHERE id = $1`, [projectId, shift(TODAY, 3)]);
    const soon = await health();
    expect(reason(soon, "field_start")).toEqual([]);
    expect(soon.health.band).toBe("green");
  });

  it("flags field start only when it slips more than 7 days, and a slip suppresses the window", async () => {
    await q(`UPDATE projects.projects SET scheduled_start = '2026-10-01' WHERE id = $1`, [projectId]);
    await fieldStart("2026-10-08");
    expect(reason(await health(), "field_start")).toEqual([]);

    await fieldStart("2026-10-09");
    expect(reason(await health(), "field_start")).toEqual([
      {
        code: "field_start",
        band: "red",
        detail: "Field start is 8 days after the logged start",
      },
    ]);

    await q(`UPDATE projects.projects SET scheduled_start = $2 WHERE id = $1`, [projectId, TODAY]);
    await fieldStart(shift(TODAY, 7));
    expect(reason(await health(), "field_start")).toEqual([
      {
        code: "field_start",
        band: "yellow",
        detail: `Field start is ${shift(TODAY, 7)} and Gate 2 is not approved`,
      },
    ]);

    await fieldStart(shift(TODAY, 8));
    await q(`UPDATE projects.projects SET scheduled_start = $2 WHERE id = $1`, [projectId, shift(TODAY, 6)]);
    expect(reason(await health(), "field_start")).toEqual([]);

    await q(`UPDATE projects.projects SET scheduled_start = '2026-10-01' WHERE id = $1`, [projectId]);
    await fieldStart(shift(TODAY, 1));
    const slipped = reason(await health(), "field_start");
    expect(slipped).toHaveLength(1);
    expect(slipped[0]?.band).toBe("red");

    await q(
      `UPDATE projects.stage_gates SET status = 'approved' WHERE project_id = $1 AND gate_number = 2`,
      [projectId],
    );
    await q(`UPDATE projects.projects SET scheduled_start = $2 WHERE id = $1`, [projectId, TODAY]);
    await fieldStart(shift(TODAY, 1));
    expect(reason(await health(), "field_start")).toEqual([]);
  });

  it("treats a preconstruction task more than 7 days overdue as red and a shorter overdue as yellow", async () => {
    await q(
      `INSERT INTO projects.precon_tasks
         (tenant_id, project_id, task_type, title, owner_role, due_on, status, sort_order)
       VALUES ($1, $2, 'other', 'Call today', 'project_manager', $3, 'not_started', 40)`,
      [t.id, projectId, TODAY],
    );
    expect(reason(await health(), "precon")).toEqual([]);

    await q(
      `INSERT INTO projects.precon_tasks
         (tenant_id, project_id, task_type, title, owner_role, due_on, status, sort_order)
       VALUES ($1, $2, 'other', 'Waived late', 'project_manager', $3, 'waived', 41)`,
      [t.id, projectId, shift(TODAY, -30)],
    );
    expect(reason(await health(), "precon")).toEqual([]);

    await q(
      `INSERT INTO projects.precon_tasks
         (tenant_id, project_id, task_type, title, owner_role, due_on, status, sort_order)
       VALUES ($1, $2, 'other', 'One week', 'project_manager', $3, 'not_started', 42)`,
      [t.id, projectId, shift(TODAY, -7)],
    );
    expect(reason(await health(), "precon")).toEqual([
      { code: "precon", band: "yellow", detail: "A preconstruction task is overdue" },
    ]);

    await q(
      `INSERT INTO projects.precon_tasks
         (tenant_id, project_id, task_type, title, owner_role, due_on, status, sort_order)
       VALUES ($1, $2, 'other', 'Eight days', 'project_manager', $3, 'in_progress', 43)`,
      [t.id, projectId, shift(TODAY, -8)],
    );
    expect(reason(await health(), "precon")).toEqual([
      { code: "precon", band: "red", detail: "A preconstruction task is more than 7 days overdue" },
    ]);
    expect((await health()).health.score).toBe(80);
  });

  it("uses 80 and 100 for budget, keeps a zero baseline quiet, and folds uncoded hours into the budget reason", async () => {
    const code = await budget("220", "S", 1000);
    await commitPo(code, "S", 790, "PO-79");
    expect(reason(await health(), "budget")).toEqual([]);

    await q(`DELETE FROM projects.po_lines WHERE po_id IN (SELECT id FROM projects.purchase_orders WHERE project_id = $1)`, [projectId]);
    await q(`DELETE FROM projects.purchase_orders WHERE project_id = $1`, [projectId]);
    await commitPo(code, "S", 800, "PO-80");
    expect(reason(await health(), "budget")).toEqual([
      { code: "budget", band: "yellow", detail: "Committed cost is 80% of baseline" },
    ]);

    await q(`DELETE FROM projects.po_lines WHERE po_id IN (SELECT id FROM projects.purchase_orders WHERE project_id = $1)`, [projectId]);
    await q(`DELETE FROM projects.purchase_orders WHERE project_id = $1`, [projectId]);
    await commitPo(code, "S", 1000, "PO-100");
    expect(reason(await health(), "budget")).toEqual([
      { code: "budget", band: "red", detail: "Committed cost is 100% of baseline" },
    ]);

    await q(`DELETE FROM projects.budget_lines WHERE project_id = $1`, [projectId]);
    await q(`DELETE FROM projects.po_lines WHERE po_id IN (SELECT id FROM projects.purchase_orders WHERE project_id = $1)`, [projectId]);
    await q(`DELETE FROM projects.purchase_orders WHERE project_id = $1`, [projectId]);
    await budget("220", "S", 1000);
    const hot = await budget("210", "L", 100);
    await commitPo(hot, "L", 120, "PO-HOT");
    expect(reason(await health(), "budget")).toEqual([
      { code: "budget", band: "red", detail: "A cost line is over 110% of its baseline" },
    ]);

    await q(`DELETE FROM projects.budget_lines WHERE project_id = $1`, [projectId]);
    await q(`DELETE FROM projects.po_lines WHERE po_id IN (SELECT id FROM projects.purchase_orders WHERE project_id = $1)`, [projectId]);
    await q(`DELETE FROM projects.purchase_orders WHERE project_id = $1`, [projectId]);
    await budget("220", "S", 0);
    await q(
      `INSERT INTO projects.labor_actuals
         (tenant_id, project_id, external_job_id, work_date, hours, source)
       VALUES ($1, $2, 'job-1', '2026-10-20', 4, 'timesheet')`,
      [t.id, projectId],
    );
    expect(reason(await health(), "budget")).toEqual([
      { code: "budget", band: "yellow", detail: "hours not on a cost code" },
    ]);

    await q(`DELETE FROM projects.budget_lines WHERE project_id = $1`, [projectId]);
    const again = await budget("220", "S", 1000);
    await commitPo(again, "S", 1000, "PO-RED");
    const folded = reason(await health(), "budget");
    expect(folded).toEqual([
      {
        code: "budget",
        band: "red",
        detail: "Committed cost is 100% of baseline. Hours not on a cost code.",
      },
    ]);
    expect((await health()).health.score).toBe(80);
  });

  it("flags an unschedulable vendor as red and an expiring document as yellow", async () => {
    const blocked = await one<{ id: string }>(
      `INSERT INTO projects.vendors (tenant_id, legal_name, email) VALUES ($1, 'Blocked Co', 'blocked@v.test') RETURNING id`,
      [t.id],
    );
    await q(
      `INSERT INTO projects.schedule_items
         (tenant_id, project_id, title, vendor_id, window_start, window_end, status)
       VALUES ($1, $2, 'Tile', $3, '2026-10-25', '2026-10-26', 'proposed')`,
      [t.id, projectId, blocked.id],
    );
    expect(reason(await health(), "sub_compliance")).toEqual([
      { code: "sub_compliance", band: "red", detail: "A vendor on this project is not schedulable" },
    ]);

    await q(`DELETE FROM projects.schedule_items WHERE project_id = $1`, [projectId]);
    const expiring = await one<{ id: string }>(
      `INSERT INTO projects.vendors (tenant_id, legal_name, email) VALUES ($1, 'Renew Co', 'renew@v.test') RETURNING id`,
      [t.id],
    );
    await q(
      `INSERT INTO projects.vendor_documents (tenant_id, vendor_id, kind, expires_on, file_key)
       SELECT $1, $2, k::projects.doc_kind, CURRENT_DATE + 10, 'file'
         FROM unnest(ARRAY['master_agreement','tax_form','license','gl_insurance','wc_insurance','auto_insurance']) AS k`,
      [t.id, expiring.id],
    );
    await q(
      `INSERT INTO projects.schedule_items
         (tenant_id, project_id, title, vendor_id, window_start, window_end, status)
       VALUES ($1, $2, 'Paint', $3, '2026-10-25', '2026-10-26', 'proposed')`,
      [t.id, projectId, expiring.id],
    );
    expect(reason(await health(), "sub_compliance")).toEqual([
      {
        code: "sub_compliance",
        band: "yellow",
        detail: "A required document is inside its warn window",
      },
    ]);
  });

  it("flags a stale approved draw or a 30-day unpaid invoice as red, and a 3-day earned draw as yellow", async () => {
    await q(
      `UPDATE projects.draws
          SET status = 'approved', approved_at = $2, approved_by = $3, label = 'Draw 2'
        WHERE project_id = $1 AND sequence_number = 1`,
      [projectId, nyNoon(shift(TODAY, -7)), t.staff.owner!.id],
    );
    expect(reason(await health(), "draws")).toEqual([]);

    await q(
      `UPDATE projects.draws SET approved_at = $2 WHERE project_id = $1 AND sequence_number = 1`,
      [projectId, nyNoon(shift(TODAY, -8))],
    );
    const row = await health();
    expect(reason(row, "draws")).toEqual([
      {
        code: "draws",
        band: "red",
        detail: "Draw 2 approved 8 days ago with no invoice number",
      },
    ]);

    await q(
      `UPDATE projects.draws
          SET status = 'scheduled', approved_at = NULL, approved_by = NULL
        WHERE project_id = $1 AND sequence_number = 1`,
      [projectId],
    );
    const system = await one<{ id: string }>(
      `INSERT INTO projects.external_systems (tenant_id, adapter_key, display_name)
       VALUES ($1, 'servicetitan', 'ServiceTitan') RETURNING id`,
      [t.id],
    );
    await q(
      `INSERT INTO projects.st_invoice_observations
         (tenant_id, project_id, external_system_id, external_invoice_id, invoice_number, total, balance, invoiced_on)
       VALUES ($1, $2, $3, 'inv-9', 'INV-9', 1000, 40, $4)`,
      [t.id, projectId, system.id, shift(TODAY, -30)],
    );
    await q(
      `UPDATE projects.draws SET external_invoice_number = 'INV-9' WHERE project_id = $1 AND sequence_number = 2`,
      [projectId],
    );
    expect(reason(await health(), "draws")).toEqual([]);

    await q(
      `UPDATE projects.st_invoice_observations SET invoiced_on = $2 WHERE project_id = $1`,
      [projectId, shift(TODAY, -31)],
    );
    expect(reason(await health(), "draws")).toEqual([
      {
        code: "draws",
        band: "red",
        detail: "Invoice INV-9 has been unpaid for more than 30 days",
      },
    ]);

    await q(`DELETE FROM projects.st_invoice_observations WHERE project_id = $1`, [projectId]);
    await q(
      `UPDATE projects.draws SET external_invoice_number = NULL WHERE project_id = $1 AND sequence_number = 2`,
      [projectId],
    );
    await q(
      `UPDATE projects.draws SET status = 'earned', earned_at = $2 WHERE project_id = $1 AND sequence_number = 2`,
      [projectId, nyNoon(shift(TODAY, -2))],
    );
    expect(reason(await health(), "draws")).toEqual([]);
    await q(
      `UPDATE projects.draws SET earned_at = $2 WHERE project_id = $1 AND sequence_number = 2`,
      [projectId, nyNoon(shift(TODAY, -3))],
    );
    expect(reason(await health(), "draws")).toEqual([
      { code: "draws", band: "yellow", detail: "A draw has been earned and not approved for 3 days" },
    ]);

    await q(
      `UPDATE projects.draws
          SET status = 'approved', approved_at = $2, approved_by = $3, label = 'Draw 2'
        WHERE project_id = $1 AND sequence_number = 1`,
      [projectId, nyNoon(shift(TODAY, -8)), t.staff.owner!.id],
    );
    const both = reason(await health(), "draws");
    expect(both).toHaveLength(1);
    expect(both[0]?.band).toBe("red");
  });

  it("flags closeout from the stage and from an approved Gate 3", async () => {
    expect(reason(await health(), "closeout")).toEqual([]);
    await q(`UPDATE projects.projects SET stage = 'execution' WHERE id = $1`, [projectId]);
    expect(reason(await health(), "closeout")).toEqual([]);
    await q(
      `UPDATE projects.stage_gates SET status = 'approved' WHERE project_id = $1 AND gate_number = 3`,
      [projectId],
    );
    expect(reason(await health(), "closeout")).toEqual([
      {
        code: "closeout",
        band: "yellow",
        detail: "Gate 3 is approved and closeout still has open items",
      },
    ]);
    await q(`UPDATE projects.projects SET stage = 'closeout' WHERE id = $1`, [projectId]);
    expect(reason(await health(), "closeout")).toEqual([
      { code: "closeout", band: "red", detail: "Closeout has open items" },
    ]);
    await q(
      `INSERT INTO projects.project_closeout
         (project_id, tenant_id, punch_done_at, photos_done_at, final_draw_invoice_number,
          warranty_start_on, review_request_note, review_request_recorded_at, review_request_recorded_by)
       VALUES ($1, $2, now(), now(), 'F-1', '2026-11-01', 'Asked', now(), $3)`,
      [projectId, t.id, t.staff.owner!.id],
    );
    expect(reason(await health(), "closeout")).toEqual([]);
  });

  it("calls under-billed and over-billed out, and over wins when both are set", async () => {
    const draw = await one<{ amount: string }>(
      `SELECT amount::text AS amount FROM projects.draws WHERE project_id = $1 AND sequence_number = 1`,
      [projectId],
    );
    await q(
      `UPDATE projects.draws SET status = 'earned', earned_at = $2 WHERE project_id = $1 AND sequence_number = 1`,
      [projectId, nyNoon(TODAY)],
    );
    const under = await health();
    expect(under.billing).toEqual({ position: "under", amount: Number(draw.amount) });

    await q(
      `INSERT INTO projects.change_orders
         (tenant_id, project_id, co_number, description, customer_amount, status)
       VALUES ($1, $2, 1, 'Tile upgrade', 500, 'approved')`,
      [t.id, projectId],
    );
    expect((await health()).billing.amount).toBe(Number(draw.amount) + 500);

    const system = await one<{ id: string }>(
      `INSERT INTO projects.external_systems (tenant_id, adapter_key, display_name)
       VALUES ($1, 'health-ar', 'Health read') RETURNING id`,
      [t.id],
    );
    await q(
      `INSERT INTO projects.project_job_links
         (tenant_id, project_id, external_system_id, external_job_id, title, source_active)
       VALUES ($1, $2, $3, 'job-9', 'Field', true)`,
      [t.id, projectId, system.id],
    );
    await q(
      `INSERT INTO projects.st_invoice_observations
         (tenant_id, project_id, external_system_id, external_invoice_id, invoice_number,
          external_job_id, total, balance, invoiced_on)
       VALUES ($1, $2, $3, 'inv-open', 'ST-1', 'job-9', 400, 400, $4)`,
      [t.id, projectId, system.id, TODAY],
    );
    expect((await health()).billing).toEqual({ position: "over", amount: 400 });
  });

  it("subtracts a red and a different yellow, and floors six reds at 0", async () => {
    const code = await budget("220", "S", 1000);
    await commitPo(code, "S", 1000, "PO-FLOOR");
    await q(
      `INSERT INTO projects.precon_tasks
         (tenant_id, project_id, task_type, title, owner_role, due_on, status, sort_order)
       VALUES ($1, $2, 'other', 'Late by a day', 'project_manager', $3, 'not_started', 40)`,
      [t.id, projectId, shift(TODAY, -1)],
    );
    const mixed = await health();
    expect(mixed.health.score).toBe(72);
    expect(mixed.health.band).toBe("red");
    expect(mixed.health.reasons.map((item) => item.code)).toEqual(["budget", "precon"]);

    await q(`UPDATE projects.projects SET scheduled_start = '2026-10-01' WHERE id = $1`, [projectId]);
    await fieldStart("2026-10-20");
    const blocked = await one<{ id: string }>(
      `INSERT INTO projects.vendors (tenant_id, legal_name, email) VALUES ($1, 'No Docs', 'nodocs@v.test') RETURNING id`,
      [t.id],
    );
    await q(
      `INSERT INTO projects.schedule_items
         (tenant_id, project_id, title, vendor_id, window_start, window_end, status)
       VALUES ($1, $2, 'Demo', $3, '2026-10-25', '2026-10-26', 'proposed')`,
      [t.id, projectId, blocked.id],
    );
    await q(
      `UPDATE projects.precon_tasks SET due_on = $2 WHERE project_id = $1 AND title = 'Late by a day'`,
      [projectId, shift(TODAY, -8)],
    );
    await q(
      `UPDATE projects.draws
          SET status = 'approved', approved_at = $2, approved_by = $3
        WHERE project_id = $1 AND sequence_number = 1`,
      [projectId, nyNoon(shift(TODAY, -8)), t.staff.owner!.id],
    );
    await q(`UPDATE projects.projects SET stage = 'closeout' WHERE id = $1`, [projectId]);
    const floored = await health();
    expect(floored.health.reasons).toHaveLength(6);
    expect(floored.health.band).toBe("red");
    expect(floored.health.score).toBe(0);
  });

  it("writes active projects and a completion day, skips cancelled work, and does not open a socket", async () => {
    const second = await owner().post("/api/v1/projects/projects").send(projectBody({ name: "Done today" }));
    const third = await owner().post("/api/v1/projects/projects").send(projectBody({ name: "Done yesterday" }));
    const fourth = await owner().post("/api/v1/projects/projects").send(projectBody({ name: "Cancelled" }));
    const doneToday = second.body.data.id as string;
    const doneYesterday = third.body.data.id as string;
    const cancelled = fourth.body.data.id as string;
    await q(`UPDATE projects.projects SET stage = 'complete', actual_end = '2026-01-15' WHERE id = $1`, [doneToday]);
    await q(`UPDATE projects.projects SET stage = 'complete', actual_end = '2026-01-14' WHERE id = $1`, [doneYesterday]);
    await q(`UPDATE projects.projects SET stage = 'cancelled' WHERE id = $1`, [cancelled]);

    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      throw new Error("socket");
    }) as typeof fetch;
    let first: { written: number; skipped: string | null };
    try {
      first = await runHealthSnapshots(h.db, t.id, { today: "2026-01-15" });
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual([]);
    expect(first.skipped).toBeNull();
    expect(first.written).toBe(2);

    const again = await runHealthSnapshots(h.db, t.id, { today: "2026-01-15" });
    expect(again).toEqual({ written: 0, skipped: "already_ran" });

    const code = await budget("220", "S", 1000);
    await commitPo(code, "S", 1000, "PO-LATER");
    const held = await runHealthSnapshots(h.db, t.id, { today: "2026-01-15" });
    expect(held.skipped).toBe("already_ran");
    const stored = await one<{ score: number }>(
      `SELECT score FROM projects.project_health_snapshots WHERE project_id = $1 AND snapshot_on = '2026-01-15'`,
      [projectId],
    );
    expect(stored.score).toBe(100);

    const replaced = await runHealthSnapshots(h.db, t.id, { today: "2026-01-15", replace: true });
    expect(replaced.written).toBe(2);
    const updated = await one<{ score: number; band: string }>(
      `SELECT score, band FROM projects.project_health_snapshots WHERE project_id = $1 AND snapshot_on = '2026-01-15'`,
      [projectId],
    );
    expect(updated).toEqual({ score: 80, band: "red" });

    const ids = await h.db.withTenant(t.id, (db) =>
      db.query<{ project_id: string }>(
        `SELECT project_id::text AS project_id FROM projects.project_health_snapshots WHERE snapshot_on = '2026-01-15'`,
      ),
    );
    expect(ids.rows.map((row) => row.project_id).sort()).toEqual([projectId, doneToday].sort());

    const source = readFileSync(path.join(repoRoot, "src/workers/healthSnapshot.ts"), "utf8");
    expect(source).not.toMatch(/serviceTitan|quickbooks|servicetitan\.io|fetch\(/);
    const migration = readFileSync(path.join(repoRoot, "db/041_project_health_snapshots.sql"), "utf8");
    expect(migration).not.toMatch(/scheduled_start\s*=/);
    expect(SCHEMA_FILES.some((file) => file.endsWith("041_project_health_snapshots.sql"))).toBe(true);
    expect(startHealthSnapshotScheduler(h.db, undefined)).toBeUndefined();
  });

  it("lets an owner replace today's rows and keeps the portfolio token off that route", async () => {
    const token = "portfolio-feed-token-for-health-01";
    const feed = supertest(
      createApp({
        database: h.db,
        staffSessions: new MemoryStaffSessions(),
        serveConsole: false,
        portfolio: { tenantId: t.id, token },
      }),
    );
    const denied = await feed.post("/api/v1/projects/health-snapshots/run").set("Authorization", `Bearer ${token}`).send({});
    expect(denied.status).toBe(401);
    const manager = await h.as(t.staff.manager!.token).post("/api/v1/projects/health-snapshots/run").send({});
    expect(manager.status).toBe(403);

    const ran = await owner().post("/api/v1/projects/health-snapshots/run").send({});
    expect(ran.status, JSON.stringify(ran.body)).toBe(200);
    expect(ran.body.data.written).toBeGreaterThanOrEqual(1);

    const listed = await feed.get("/api/v1/portfolio/projects").set("Authorization", `Bearer ${token}`);
    const project = (listed.body.data.projects as Array<{ id: string; health: { band: string } }>).find(
      (row) => row.id === projectId,
    );
    expect(project?.health.band).toBe("green");

    const history = await feed
      .get(`/api/v1/portfolio/projects/${projectId}/snapshots?days=90`)
      .set("Authorization", `Bearer ${token}`);
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect(history.body.data.snapshots.map((row: { snapshot_on: string }) => row.snapshot_on)).toContain(
      ran.body.data.snapshot_on,
    );

    const other = await createTenant(h, { slug: `health-other-${n++}` });
    const foreignProject = await h.as(other.staff.owner!.token).post("/api/v1/projects/projects").send(projectBody());
    const missing = await feed
      .get(`/api/v1/portfolio/projects/${foreignProject.body.data.id}/snapshots`)
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(404);
    expect((await feed.get("/api/v1/portfolio/projects/not-a-uuid/snapshots").set("Authorization", `Bearer ${token}`)).status).toBe(404);
    expect((await feed.get(`/api/v1/portfolio/projects/${projectId}/snapshots?days=0`).set("Authorization", `Bearer ${token}`)).status).toBe(400);

    const summary = await feed.get("/api/v1/portfolio/summary").set("Authorization", `Bearer ${token}`);
    expect(summary.body.data.totals.health.green).toBeGreaterThanOrEqual(1);
  });
});
