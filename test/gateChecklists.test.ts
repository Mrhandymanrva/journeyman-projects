import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { splitSqlStatements } from "../src/db/splitSql.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import { GATE_1_CHECKLIST, GATE_2_CHECKLIST } from "../src/domain/gateReadiness.js";
import {
  createTenant,
  projectBody,
  SCHEMA_FILES,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";
import { tickGate } from "./support/tickGate.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "portfolio-feed-token-for-gate-checklists";

describe("gate 1 and gate 2 checklists", () => {
  let h: Harness;
  let t: TenantFixture;
  const owner = () => h.as(t.staff.owner!.token);

  beforeAll(async () => {
    h = await startHarness();
    t = await createTenant(h, { slug: "gates-n5" });
  });
  afterAll(async () => {
    await h?.close();
  });

  async function project(number: string, extra: Record<string, unknown> = {}) {
    const res = await owner()
      .post("/api/v1/projects/projects")
      .send(projectBody({ project_number: number, ...extra }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data as { id: string };
  }

  function item(
    gates: Array<{ gate_number: number; checklist: Array<Record<string, unknown>> }>,
    gateNumber: number,
    key: string,
  ) {
    const gate = gates.find((row) => row.gate_number === gateNumber);
    return gate?.checklist.find((row) => row.key === key);
  }

  it("copies the shipped checklist onto a new project and leaves other gates empty", async () => {
    const created = await project("G-NEW");
    const gates = await owner().get(`/api/v1/projects/projects/${created.id}/gates`);
    expect(gates.status).toBe(200);
    const rows = gates.body.data as Array<{
      gate_number: number;
      checklist: Array<{ key: string; label: string; done: boolean; ready?: boolean }>;
    }>;
    expect(rows.find((row) => row.gate_number === 0)?.checklist).toEqual([]);
    expect(rows.find((row) => row.gate_number === 3)?.checklist).toEqual([]);
    expect(
      rows.find((row) => row.gate_number === 1)?.checklist.map((row) => row.key),
    ).toEqual(GATE_1_CHECKLIST.map((row) => row.key));
    expect(
      rows.find((row) => row.gate_number === 2)?.checklist.map((row) => row.label),
    ).toEqual(GATE_2_CHECKLIST.map((row) => row.label));
    expect(item(rows, 1, "accepted_estimate")?.done).toBe(false);
    expect(item(rows, 1, "accepted_estimate")?.ready).toBe(true);
    expect(item(rows, 1, "scope")?.ready).toBe(false);
    expect(item(rows, 1, "permit_need")?.ready).toBe(true);
    expect(item(rows, 1, "materials")?.ready).toBe(true);
    expect(item(rows, 2, "precon_clear")?.ready).toBe(false);
    expect(item(rows, 2, "subs_compliant")?.ready).toBe(true);
    expect(item(rows, 2, "site_ready")?.ready).toBe(false);
    expect(item(rows, 2, "materials_ordered")?.ready).toBe(false);
  });

  it("refuses approval while a ready item is still unticked", async () => {
    const created = await project("G-TICK");
    const refused = await owner().post(
      `/api/v1/projects/projects/${created.id}/gates/1/approve`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("gate_not_satisfied");
    expect(refused.body.error.details.items).toHaveLength(GATE_1_CHECKLIST.length);

    await tickGate(owner(), created.id, 1);
    const approved = await owner().post(
      `/api/v1/projects/projects/${created.id}/gates/1/approve`,
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe("approved");
  });

  it("turns hints on from live project data and never ticks them", async () => {
    const created = await project("G-HINT", { scheduled_end: "2026-12-01" });
    const codes = await owner().get("/api/v1/projects/cost-codes");
    const codeId = (codes.body.data as Array<{ id: string; code: string }>).find(
      (row) => row.code === "160",
    )!.id;
    const budget = await owner()
      .post(`/api/v1/projects/projects/${created.id}/budget`)
      .send({ cost_code_id: codeId, cost_type: "L", budget_amount: 100 });
    expect(budget.status, JSON.stringify(budget.body)).toBe(201);

    const doc = await owner()
      .post(`/api/v1/projects/projects/${created.id}/controls`)
      .send({
        kind: "document",
        data: { title: "Scope", folder: "charter_scope", template: "", content: "Work." },
      });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);

    const started = await owner()
      .put(`/api/v1/projects/projects/${created.id}/field-start`)
      .send({ date: "2026-11-03" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await h.db.withTenant(t.id, async (c) => {
      await c.query(
        `UPDATE projects.precon_tasks SET status = 'done' WHERE project_id = $1`,
        [created.id],
      );
    });

    const gates = await owner().get(`/api/v1/projects/projects/${created.id}/gates`);
    const rows = gates.body.data as Array<{
      gate_number: number;
      checklist: Array<{ key: string; done: boolean; ready?: boolean }>;
    }>;
    expect(item(rows, 1, "budget_by_cost_code")).toMatchObject({
      done: false,
      ready: true,
    });
    expect(item(rows, 1, "scope")?.ready).toBe(true);
    expect(item(rows, 1, "target_window")?.ready).toBe(true);
    expect(item(rows, 2, "field_start")?.ready).toBe(true);
    expect(item(rows, 2, "precon_clear")?.ready).toBe(true);
    expect(item(rows, 2, "site_ready")?.ready).toBe(false);

    const detail = await owner().get(`/api/v1/projects/projects/${created.id}`);
    const detailGate = (
      detail.body.data.gates as Array<{
        gate_number: number;
        checklist: Array<{ key: string; ready?: boolean }>;
      }>
    ).find((row) => row.gate_number === 1);
    expect(detailGate?.checklist.find((row) => row.key === "scope")?.ready).toBe(true);
  });

  it("apply-template fills an empty project checklist and refuses a filled one", async () => {
    const created = await project("G-APPLY");
    const refused = await owner().post(
      `/api/v1/projects/projects/${created.id}/gates/apply-template`,
    );
    expect(refused.status).toBe(409);

    await h.db.withTenant(t.id, async (c) => {
      await c.query(
        `UPDATE projects.stage_gates SET checklist = '[]'::jsonb WHERE project_id = $1`,
        [created.id],
      );
      await c.query(
        `UPDATE projects.gate_templates
            SET checklist = '[{"key":"custom","label":"Kept"}]'::jsonb
          WHERE tenant_id = $1 AND gate_number = 0`,
        [t.id],
      );
    });

    const applied = await owner().post(
      `/api/v1/projects/projects/${created.id}/gates/apply-template`,
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const rows = applied.body.data as Array<{
      gate_number: number;
      checklist: Array<{ key: string }>;
    }>;
    expect(rows.find((row) => row.gate_number === 1)?.checklist.map((row) => row.key)).toEqual(
      GATE_1_CHECKLIST.map((row) => row.key),
    );
    expect(rows.find((row) => row.gate_number === 0)?.checklist.map((row) => row.key)).toEqual([
      "custom",
    ]);

    const again = await owner().post(
      `/api/v1/projects/projects/${created.id}/gates/apply-template`,
    );
    expect(again.status).toBe(409);
  });

  it("fills only empty gate 1 and gate 2 templates and does not rewrite project rows", async () => {
    const created = await project("G-KEEP");
    await h.db.withTenant(t.id, async (c) => {
      await c.query(
        `UPDATE projects.stage_gates
            SET checklist = '[{"key":"old","label":"Old answer","done":true}]'::jsonb
          WHERE project_id = $1 AND gate_number = 1`,
        [created.id],
      );
      await c.query(
        `UPDATE projects.gate_templates SET checklist = '[]'::jsonb
          WHERE tenant_id = $1 AND gate_number IN (1, 2)`,
        [t.id],
      );
      await c.query(
        `UPDATE projects.gate_templates
            SET checklist = '[{"key":"handoff","label":"Signed"}]'::jsonb
          WHERE tenant_id = $1 AND gate_number = 0`,
        [t.id],
      );
    });

    const sql = readFileSync(
      path.join(repoRoot, "db/039_gate_checklist_defaults.sql"),
      "utf8",
    );
    await h.db.asOwner(async (c) => {
      for (const stmt of splitSqlStatements(sql)) {
        await c.query(stmt.text);
      }
    });

    const templates = await h.db.withTenant(t.id, async (c) =>
      c.query<{ gate_number: number; checklist: Array<{ key: string }> }>(
        `SELECT gate_number, checklist FROM projects.gate_templates
          WHERE tenant_id = $1 ORDER BY gate_number`,
        [t.id],
      ),
    );
    const byNumber = new Map(templates.rows.map((row) => [row.gate_number, row.checklist]));
    expect(byNumber.get(0)?.map((row) => row.key)).toEqual(["handoff"]);
    expect(byNumber.get(1)?.map((row) => row.key)).toEqual(
      GATE_1_CHECKLIST.map((row) => row.key),
    );
    expect(byNumber.get(2)?.map((row) => row.key)).toEqual(
      GATE_2_CHECKLIST.map((row) => row.key),
    );

    const kept = await h.db.withTenant(t.id, async (c) =>
      c.query<{ checklist: Array<{ key: string }> }>(
        `SELECT checklist FROM projects.stage_gates WHERE project_id = $1 AND gate_number = 1`,
        [created.id],
      ),
    );
    expect(kept.rows[0]?.checklist.map((row) => row.key)).toEqual(["old"]);
  });

  it("publishes gate 1 and gate 2 status on the portfolio project feed", async () => {
    const created = await project("G-FEED");
    await tickGate(owner(), created.id, 1);
    await owner().post(`/api/v1/projects/projects/${created.id}/gates/1/approve`);

    const feed = supertest(
      createApp({
        database: h.db,
        staffSessions: new MemoryStaffSessions(),
        serveConsole: false,
        portfolio: { tenantId: t.id, token: TOKEN },
      }),
    );
    const res = await feed
      .get("/api/v1/portfolio/projects")
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = (res.body.data.projects as Array<{ project_number: string; gates: unknown }>).find(
      (project) => project.project_number === "G-FEED",
    );
    expect(row?.gates).toEqual({ gate_1: "approved", gate_2: "open" });
    expect(SCHEMA_FILES.some((file) => file.endsWith("039_gate_checklist_defaults.sql"))).toBe(
      true,
    );
  });
});
