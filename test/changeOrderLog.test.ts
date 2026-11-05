import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { GATE_4_CHECKLIST } from "../src/domain/gateReadiness.js";
import { splitSqlStatements } from "../src/db/splitSql.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import {
  SCHEMA_FILES,
  createTenant,
  estimatePayload,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "portfolio-feed-token-for-tests-0003";

let h: Harness;
let t: TenantFixture;
let projectId: string;
let n = 0;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  t = await createTenant(h, { slug: `log-${n++}` });
  const imported = await owner().post("/api/v1/projects/estimate-imports").send(estimatePayload());
  const created = await owner()
    .post("/api/v1/projects/projects")
    .send(
      projectBody({
        estimate_import_id: imported.body.data.id,
        source_kind: "journeyman_estimate",
        contract_value: 41800,
        scheduled_start: "2026-08-01",
        scheduled_end: "2026-09-01",
      }),
    );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  projectId = created.body.data.id;
});

const owner = () => h.as(t.staff.owner!.token);
const manager = () => h.as(t.staff.manager!.token);
const pm = () => h.as(t.staff.pm!.token);
const office = () => h.as(t.staff.office!.token);
const estimator = () => h.as(t.staff.estimator!.token);

async function raise(as = owner(), body: Record<string, unknown> = {}) {
  const res = await as.post(`/api/v1/projects/projects/${projectId}/change-orders`).send({
    description: "Customer upgraded the tile selection",
    customer_amount: 2400,
    lines: [],
    ...body,
  });
  return res;
}

function feed() {
  return supertest(
    createApp({
      database: h.db,
      staffSessions: new MemoryStaffSessions(),
      serveConsole: false,
      portfolio: { tenantId: t.id, token: TOKEN },
    }),
  );
}

describe("change order log", () => {
  it("stamps found and priced when an owner records dollars, and lists the log", async () => {
    const created = await raise();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.found_at).toBeTruthy();
    expect(created.body.data.priced_at).toBeTruthy();

    const list = await owner().get(`/api/v1/projects/projects/${projectId}/change-orders`);
    const row = list.body.data.change_orders[0];
    expect(row.found_at).toBeTruthy();
    expect(row.priced_at).toBeTruthy();
    expect(row.entered_st_at).toBeNull();
    expect(row.st_estimate_number).toBeNull();
    expect(row.signed_at).toBeNull();
  });

  it("lets a coordinator raise an unpriced draft and refuses a priced one before insert", async () => {
    const draft = await raise(pm(), { customer_amount: 0, description: "Found during walkthrough" });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.data.priced_at).toBeNull();

    const priced = await raise(pm(), { customer_amount: 900, description: "Should not exist" });
    expect(priced.status).toBe(403);
    const list = await owner().get(`/api/v1/projects/projects/${projectId}/change-orders`);
    const descriptions = list.body.data.change_orders.map((row: { description: string }) => row.description);
    expect(descriptions).toEqual(["Found during walkthrough"]);
  });

  it("saves a coordinator's description and refuses the dollar fields", async () => {
    const created = await raise();
    const patched = await pm()
      .patch(`/api/v1/projects/change-orders/${created.body.data.id}`)
      .send({ description: "Tile, and the customer is waiting", customer_amount: 9999 });
    expect(patched.status).toBe(403);
    expect(patched.body.error.details.saved).toContain("description");

    const list = await owner().get(`/api/v1/projects/projects/${projectId}/change-orders`);
    const row = list.body.data.change_orders[0];
    expect(row.description).toBe("Tile, and the customer is waiting");
    expect(row.customer_amount).toBe(2400);
  });

  it("lets a manager price a draft the coordinator raised", async () => {
    const created = await raise(pm(), { customer_amount: 0, description: "Needs a price" });
    const priced = await manager()
      .patch(`/api/v1/projects/change-orders/${created.body.data.id}`)
      .send({ customer_amount: 1800 });
    expect(priced.status, JSON.stringify(priced.body)).toBe(200);
    expect(priced.body.data.priced_at).toBeTruthy();
    expect(Number(priced.body.data.customer_amount)).toBe(1800);
  });

  it("records ServiceTitan entry and a signature without posting the budget or requiring send", async () => {
    const budget = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
    const before = budget.body.data.lines.find((line: { code: string }) => line.code === "1110");
    const created = await raise(owner(), {
      lines: [],
      customer_amount: 2400,
    });
    const id = created.body.data.id as string;

    const entered = await pm()
      .post(`/api/v1/projects/change-orders/${id}/entered`)
      .send({ st_estimate_number: "E-1044" });
    expect(entered.status, JSON.stringify(entered.body)).toBe(200);
    expect(entered.body.data.status).toBe("draft");
    expect(entered.body.data.st_estimate_number).toBe("E-1044");

    const signed = await pm()
      .post(`/api/v1/projects/change-orders/${id}/signed`)
      .send({ note: "Signed on site 10/24" });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.data.status).toBe("draft");
    expect(signed.body.data.signature_note).toBe("Signed on site 10/24");

    const margin = await owner().get(`/api/v1/projects/projects/${projectId}/margin`);
    expect(margin.body.data.revised_contract).toBe(41800);
    const afterBudget = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
    const after = afterBudget.body.data.lines.find((line: { code: string }) => line.code === "1110");
    expect(after.budget_amount).toBe(before.budget_amount);

    const refused = await estimator()
      .post(`/api/v1/projects/change-orders/${id}/entered`)
      .send({ st_estimate_number: "E-9" });
    expect(refused.status).toBe(403);
  });

  it("refuses the log once the change order is rejected, and leaves approve's body unchanged", async () => {
    const created = await raise();
    const id = created.body.data.id as string;
    await owner().post(`/api/v1/projects/change-orders/${id}/reject`);
    const entered = await owner()
      .post(`/api/v1/projects/change-orders/${id}/entered`)
      .send({ st_estimate_number: "E-1" });
    expect(entered.status).toBe(409);

    const sent = await raise(owner(), { description: "Second", customer_amount: 100 });
    await owner().post(`/api/v1/projects/change-orders/${sent.body.data.id}/send`);
    const approved = await owner()
      .post(`/api/v1/projects/change-orders/${sent.body.data.id}/approve`)
      .send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.found_at).toBeUndefined();
    expect(approved.body.data.priced_at).toBeUndefined();
    expect(approved.body.data.signed_at).toBeUndefined();
    expect(approved.body.data.status).toBe("approved");
  });
});

describe("closeout", () => {
  it("stores punch, warranty, and the review note, and clears the note", async () => {
    const empty = await owner().get(`/api/v1/projects/projects/${projectId}/closeout`);
    expect(empty.status).toBe(200);
    expect(empty.body.data.punch_done_at).toBeNull();

    const saved = await pm().put(`/api/v1/projects/projects/${projectId}/closeout`).send({
      punch_done: true,
      punch_note: "Walked with the customer",
      warranty_start_on: "2026-11-01",
      review_request_note: "Asked on site",
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.punch_done_at).toBeTruthy();
    expect(saved.body.data.warranty_start_on).toBe("2026-11-01");
    expect(saved.body.data.review_request_recorded_by).toBe(t.staff.pm!.id);
    const firstStamp = saved.body.data.punch_done_at;

    const again = await pm().put(`/api/v1/projects/projects/${projectId}/closeout`).send({
      punch_done: true,
      review_request_note: "",
    });
    expect(again.body.data.punch_done_at).toBe(firstStamp);
    expect(again.body.data.review_request_note).toBeNull();
    expect(again.body.data.review_request_recorded_at).toBeNull();
    expect(again.body.data.warranty_start_on).toBe("2026-11-01");

    const cleared = await owner().put(`/api/v1/projects/projects/${projectId}/closeout`).send({
      punch_done: false,
    });
    expect(cleared.body.data.punch_done_at).toBeNull();

    const refused = await office()
      .put(`/api/v1/projects/projects/${projectId}/closeout`)
      .send({ punch_done: true });
    expect(refused.status).toBe(403);
  });

  it("hints Gate 4 from the closeout row and from a matched retainage draw", async () => {
    const before = await owner().get(`/api/v1/projects/projects/${projectId}`);
    const gate = before.body.data.gates.find((row: { gate_number: number }) => row.gate_number === 4);
    expect(gate.checklist.map((item: { key: string }) => item.key)).toEqual(
      GATE_4_CHECKLIST.map((item) => item.key),
    );
    expect(gate.checklist.find((item: { key: string }) => item.key === "punch_list").ready).toBe(false);
    expect(gate.checklist.find((item: { key: string }) => item.key === "final_draw_invoice").ready).toBe(
      false,
    );

    await owner().put(`/api/v1/projects/projects/${projectId}/closeout`).send({
      punch_done: true,
      final_draw_invoice_number: "ST-88",
    });
    const after = await owner().get(`/api/v1/projects/projects/${projectId}`);
    const hinted = after.body.data.gates.find((row: { gate_number: number }) => row.gate_number === 4);
    const punch = hinted.checklist.find((item: { key: string }) => item.key === "punch_list");
    expect(punch.ready).toBe(true);
    expect(punch.done).toBe(false);
    expect(hinted.checklist.find((item: { key: string }) => item.key === "final_draw_invoice").ready).toBe(
      true,
    );

    await owner().put(`/api/v1/projects/projects/${projectId}/closeout`).send({
      final_draw_invoice_number: null,
    });
    const draws = await owner().get(`/api/v1/projects/projects/${projectId}/draws`);
    const retainage = draws.body.data.draws.find((row: { is_retainage: boolean }) => row.is_retainage);
    expect(retainage).toBeTruthy();
    const recorded = await owner()
      .patch(`/api/v1/projects/draws/${retainage.id}/external-invoice`)
      .send({ external_invoice_number: "RET-1" });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    const matched = await owner().get(`/api/v1/projects/projects/${projectId}`);
    const gateAfter = matched.body.data.gates.find((row: { gate_number: number }) => row.gate_number === 4);
    expect(gateAfter.checklist.find((item: { key: string }) => item.key === "final_draw_invoice").ready).toBe(
      true,
    );
  });

  it("fills only an empty Gate 4 template and does not rewrite project rows", async () => {
    await h.db.withTenant(t.id, async (c) => {
      await c.query(
        `UPDATE projects.stage_gates
            SET checklist = '[{"key":"old","label":"Old answer","done":true}]'::jsonb
          WHERE project_id = $1 AND gate_number = 4`,
        [projectId],
      );
      await c.query(
        `UPDATE projects.gate_templates SET checklist = '[]'::jsonb
          WHERE tenant_id = $1 AND gate_number = 4`,
        [t.id],
      );
      await c.query(
        `UPDATE projects.gate_templates
            SET checklist = '[{"key":"custom","label":"Kept"}]'::jsonb
          WHERE tenant_id = $1 AND gate_number = 1`,
        [t.id],
      );
    });

    const sql = readFileSync(path.join(repoRoot, "db/039_change_order_log_and_closeout.sql"), "utf8");
    await h.db.asOwner(async (c) => {
      for (const stmt of splitSqlStatements(sql)) await c.query(stmt.text);
    });

    const templates = await h.db.withTenant(t.id, async (c) =>
      c.query<{ gate_number: number; checklist: Array<{ key: string }> }>(
        `SELECT gate_number, checklist FROM projects.gate_templates WHERE tenant_id = $1`,
        [t.id],
      ),
    );
    const byNumber = new Map(templates.rows.map((row) => [row.gate_number, row.checklist]));
    expect(byNumber.get(1)?.map((row) => row.key)).toEqual(["custom"]);
    expect(byNumber.get(4)?.map((row) => row.key)).toEqual(GATE_4_CHECKLIST.map((row) => row.key));

    const kept = await h.db.withTenant(t.id, async (c) =>
      c.query<{ checklist: Array<{ key: string }> }>(
        `SELECT checklist FROM projects.stage_gates WHERE project_id = $1 AND gate_number = 4`,
        [projectId],
      ),
    );
    expect(kept.rows[0]?.checklist.map((row) => row.key)).toEqual(["old"]);
    expect(SCHEMA_FILES.some((file) => file.endsWith("039_change_order_log_and_closeout.sql"))).toBe(true);
  });
});

describe("portfolio change orders and closeout", () => {
  it("counts open drafts and hides closeout until the project is in closeout", async () => {
    const priced = await raise(owner(), { description: "Priced", customer_amount: 500 });
    await raise(pm(), { description: "Unpriced", customer_amount: 0 });
    await pm()
      .post(`/api/v1/projects/change-orders/${priced.body.data.id}/entered`)
      .send({ st_estimate_number: "E-20" });
    await pm()
      .post(`/api/v1/projects/change-orders/${priced.body.data.id}/signed`)
      .send({ note: "Signed" });

    const listed = await feed().get("/api/v1/portfolio/projects").set("Authorization", `Bearer ${TOKEN}`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const row = listed.body.data.projects[0];
    expect(row.change_orders).toEqual({
      open: 2,
      unpriced: 1,
      not_in_servicetitan: 1,
      unsigned: 1,
    });
    expect(row.closeout).toBeNull();

    await h.db.withTenant(t.id, async (c) => {
      await c.query(`UPDATE projects.projects SET stage = 'closeout' WHERE id = $1`, [projectId]);
    });
    await owner().put(`/api/v1/projects/projects/${projectId}/closeout`).send({
      punch_done: true,
      photos_done: true,
      warranty_start_on: "2026-12-01",
      review_request_note: "Left a card",
      final_draw_invoice_number: "FD-1",
    });
    const closed = await feed().get("/api/v1/portfolio/projects").set("Authorization", `Bearer ${TOKEN}`);
    expect(closed.body.data.projects[0].closeout).toEqual({
      open_items: 0,
      warranty_start: "2026-12-01",
      review_request_recorded: true,
    });
  });
});
