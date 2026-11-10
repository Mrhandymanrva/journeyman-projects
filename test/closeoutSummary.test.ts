import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hasExecutableSql, splitSqlStatements } from "../src/db/splitSql.js";
import { roundMoney } from "../src/domain/projectFinancials.js";
import {
  SCHEMA_FILES,
  createTenant,
  estimatePayload,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const migration = path.join(repoRoot, "db/063_project_closeout_summary.sql");

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
  t = await createTenant(h, { slug: `closeout-report-${n++}` });
  const imported = await owner()
    .post("/api/v1/projects/estimate-imports")
    .send(estimatePayload());
  const created = await owner()
    .post("/api/v1/projects/projects")
    .send(
      projectBody({
        name: "Whitfield Primary Bath",
        estimate_import_id: imported.body.data.id,
        source_kind: "journeyman_estimate",
        contract_value: 41800,
        scheduled_start: "2026-08-01",
        scheduled_end: "2026-09-01",
        pm_id: t.staff.pm!.id,
        estimator_id: t.staff.estimator!.id,
      }),
    );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  projectId = created.body.data.id;
});

const owner = () => h.as(t.staff.owner!.token);
const pm = () => h.as(t.staff.pm!.token);
const office = () => h.as(t.staff.office!.token);
const bookkeeper = () => h.as(t.staff.bookkeeper!.token);

function summaryUrl(suffix = "") {
  return `/api/v1/projects/projects/${projectId}/closeout/summary${suffix}`;
}

function reportBody(overrides: Record<string, unknown> = {}) {
  const narrative = {
    scope: "Bath remodel narrative",
    schedule_commentary: "Started a few days late.",
    cost_commentary: "Margin held.",
    lessons_learned: "",
    learning_outcomes_summary: "",
    performance_summary: "The crew coordinated the tile delivery.",
    critical_thinking: "",
    ...((overrides.narrative as object) ?? {}),
  };
  const postMortem = {
    initial_expectations: "Finish in August.",
    milestones: [],
    achievements_obstacles: "",
    roadblocks: "Lead time on tile.",
    additional_resources: "",
    root_causes: "",
    key_takeaways: "",
    action_items: "",
    next_steps: "",
    ...((overrides.post_mortem as object) ?? {}),
  };
  return {
    version: 1,
    report_date: "2026-11-10",
    roles: [
      {
        name: "Pat Manager",
        role: "Project manager",
        responsibilities: "Runs the job.",
      },
    ],
    risks: [],
    communications: [],
    learning_outcomes: [],
    ...overrides,
    narrative,
    post_mortem: postMortem,
  };
}

const finished = () =>
  reportBody({
    narrative: {
      lessons_learned: "Order tile earlier.",
      learning_outcomes_summary: "",
      critical_thinking: "",
    },
    post_mortem: {
      achievements_obstacles: "The tile work was clean. The grout was late.",
      root_causes: "The supplier date was taken on faith.",
      key_takeaways: "Confirm lead times at award.",
      action_items: "Add lead time to the buyout checklist.",
      next_steps: "Walk the warranty items next week.",
    },
  });

async function applyMigration() {
  for (const statement of splitSqlStatements(readFileSync(migration, "utf8"))) {
    if (!hasExecutableSql(statement.text)) continue;
    await h.db.asOwner((db) => db.query(statement.text));
  }
}

async function enterCloseout() {
  await h.db.withTenant(t.id, (db) =>
    db.query(
      `UPDATE projects.staff SET full_name = 'Pat Manager' WHERE id = $1`,
      [t.staff.pm!.id],
    ),
  );
  await h.db.withTenant(t.id, (db) =>
    db.query(
      `UPDATE projects.staff SET full_name = 'Eve Estimator' WHERE id = $1`,
      [t.staff.estimator!.id],
    ),
  );
  await h.db.withTenant(t.id, (db) =>
    db.query(
      `UPDATE projects.projects
          SET stage = 'closeout',
              source_customer_name = 'Whitfield Household',
              source_project_summary = 'Primary bath remodel',
              field_start = '2026-08-03',
              field_start_source = 'manual',
              field_start_appointment_id = NULL,
              field_start_observed_at = now(),
              field_start_set_by = $2,
              actual_start = '2026-08-04',
              actual_end = '2026-08-28'
        WHERE id = $1`,
      [projectId, t.staff.pm!.id],
    ),
  );
}

describe("closeout summary migration", () => {
  it("adds the summary columns and can be applied twice", async () => {
    expect(
      SCHEMA_FILES.some((file) =>
        file.endsWith("063_project_closeout_summary.sql"),
      ),
    ).toBe(true);
    for (const file of [
      "src/provision.ts",
      "scripts/applySql.ts",
      "scripts/devServer.ts",
    ]) {
      expect(readFileSync(path.join(repoRoot, file), "utf8")).toContain(
        "063_project_closeout_summary.sql",
      );
    }
    const sql = readFileSync(migration, "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS summary jsonb/);
    expect(sql).toMatch(
      /DROP CONSTRAINT IF EXISTS project_closeout_summary_draft_check/,
    );

    await applyMigration();
    await applyMigration();
    const columns = await h.db.asOwner((db) =>
      db.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'projects'
            AND table_name = 'project_closeout'
            AND column_name LIKE 'summary%'
          ORDER BY column_name`,
      ),
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "summary",
      "summary_finalized_at",
      "summary_finalized_by",
      "summary_updated_at",
      "summary_updated_by",
    ]);
  });
});

describe("final project report", () => {
  it("maps pulled figures and does not copy document bodies or log text", async () => {
    await enterCloseout();
    const milestone = await pm()
      .post(`/api/v1/projects/projects/${projectId}/controls`)
      .send({
        kind: "milestone",
        data: {
          title: "Tile set",
          due_on: "2026-08-20",
          state: "complete",
          completed_on: "2026-08-22",
          success_criteria: "Floor is set",
        },
      });
    expect(milestone.status, JSON.stringify(milestone.body)).toBe(201);
    const risk = await pm()
      .post(`/api/v1/projects/projects/${projectId}/controls`)
      .send({
        kind: "risk",
        data: {
          title: "Tile delay",
          description: "Supplier lead time",
          likelihood: 3,
          impact: 4,
          response: "Order early",
          review_on: "2026-08-15",
          roam: "mitigated",
        },
      });
    expect(risk.status, JSON.stringify(risk.body)).toBe(201);
    const communication = await pm()
      .post(`/api/v1/projects/projects/${projectId}/controls`)
      .send({
        kind: "communication",
        data: {
          title: "Weekly owner call",
          audience: "Customer",
          channel: "phone",
          cadence: "weekly",
          delivery_notes: "Friday afternoon",
        },
      });
    expect(communication.status, JSON.stringify(communication.body)).toBe(201);
    const scope = await pm()
      .post(`/api/v1/projects/projects/${projectId}/controls`)
      .send({
        kind: "document",
        data: {
          title: "Scope of work",
          folder: "charter_scope",
          content: "DO_NOT_LEAK_SCOPE_BODY",
        },
      });
    expect(scope.status, JSON.stringify(scope.body)).toBe(201);
    expect(
      (
        await pm()
          .post(`/api/v1/projects/projects/${projectId}/controls`)
          .send({
            kind: "document",
            data: { title: "After photo", folder: "photos", content: "pixels" },
          })
      ).status,
    ).toBe(201);
    expect(
      (
        await pm()
          .post(`/api/v1/projects/projects/${projectId}/controls`)
          .send({
            kind: "document",
            data: {
              title: "Warranty letter",
              folder: "closeout",
              content: "letter",
            },
          })
      ).status,
    ).toBe(201);
    const task = await pm()
      .post(`/api/v1/projects/projects/${projectId}/controls`)
      .send({
        kind: "task",
        data: {
          title: "Set tile",
          start_on: "2026-08-10",
          due_on: "2026-08-18",
          state: "complete",
          completed_on: "2026-08-19",
        },
      });
    expect(task.status, JSON.stringify(task.body)).toBe(201);

    const raised = await owner()
      .post(`/api/v1/projects/projects/${projectId}/change-orders`)
      .send({
        description: "Customer upgraded the tile",
        customer_amount: 2400,
        lines: [],
      });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    await owner().post(
      `/api/v1/projects/change-orders/${raised.body.data.id}/send`,
    );
    const approved = await owner()
      .post(`/api/v1/projects/change-orders/${raised.body.data.id}/approve`)
      .send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    await h.db.withTenant(t.id, async (db) => {
      await db.query(
        `INSERT INTO projects.vendors (tenant_id, legal_name, email, active, trades)
         VALUES ($1, 'Tile Co', 'tile@example.test', true, ARRAY['tile'])`,
        [t.id],
      );
      const vendor = await db.query<{ id: string }>(
        `SELECT id FROM projects.vendors WHERE email = 'tile@example.test'`,
      );
      const request = await db.query<{ id: string }>(
        `INSERT INTO projects.bid_requests (tenant_id, project_id, subject, scope, created_by)
         VALUES ($1, $2, 'Tile bid', 'Set the tile', $3)
         RETURNING id`,
        [t.id, projectId, t.staff.owner!.id],
      );
      await db.query(
        `INSERT INTO projects.bid_recipients (tenant_id, request_id, vendor_id, email, response_status)
         VALUES ($1, $2, $3, 'tile@example.test', 'awarded')`,
        [t.id, request.rows[0]!.id, vendor.rows[0]!.id],
      );
      const code = await db.query<{ id: string }>(
        `SELECT cost_code_id AS id FROM projects.budget_lines WHERE project_id = $1 LIMIT 1`,
        [projectId],
      );
      const po = await db.query<{ id: string }>(
        `INSERT INTO projects.purchase_orders
           (tenant_id, project_id, po_number, supplier_name, kind, status, scope_text, amount)
         VALUES ($1, $2, $3, 'Tile shop', 'material', 'issued', 'Tile', 0)
         RETURNING id`,
        [t.id, projectId, `PO-${projectId.slice(0, 8)}`],
      );
      await db.query(
        `INSERT INTO projects.po_lines
           (tenant_id, po_id, line_no, cost_code_id, cost_type, description, original_amount)
         VALUES ($1, $2, 1, $3, 'M', 'Tile', 500)`,
        [t.id, po.rows[0]!.id, code.rows[0]!.id],
      );
      await db.query(
        `INSERT INTO projects.vendor_bills
           (tenant_id, po_id, vendor_invoice_number, amount, status)
         VALUES ($1, $2, 'B-1', 125.50, 'approved')`,
        [t.id, po.rows[0]!.id],
      );
      await db.query(
        `INSERT INTO projects.daily_logs (tenant_id, project_id, log_date, author_id, work_completed)
         VALUES ($1, $2, '2026-08-12', $3, 'DO_NOT_LEAK_LOG')`,
        [t.id, projectId, t.staff.pm!.id],
      );
    });

    await pm().put(`/api/v1/projects/projects/${projectId}/closeout`).send({
      punch_done: true,
      punch_note: "Tile edge",
      final_draw_invoice_number: "1184",
      warranty_start_on: "2026-11-01",
    });

    const financials = await owner().get(
      `/api/v1/projects/projects/${projectId}/financials/summary`,
    );
    expect(financials.status).toBe(200);
    const position = await owner().get(
      `/api/v1/projects/projects/${projectId}/cost-position`,
    );
    const report = await pm().get(summaryUrl());
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const data = report.body.data;
    expect(data.available).toBe(true);
    expect(data.can_edit).toBe(true);
    expect(data.can_view_costs).toBe(true);
    expect(data.pulled.cover).toMatchObject({
      name: "Whitfield Primary Bath",
      customer: "Whitfield Household",
      stage: "closeout",
      pm_name: "Pat Manager",
    });
    expect(data.pulled.cover.address).toContain("4412 Grove Avenue");
    expect(data.pulled.scope.summary).toBe("Primary bath remodel");
    expect(data.pulled.scope.charter_documents).toEqual(["Scope of work"]);
    expect(data.pulled.schedule.scheduled_start).toBe("2026-08-01");
    expect(data.pulled.schedule.field_start).toBe("2026-08-03");
    expect(data.pulled.schedule.actual_start).toBe("2026-08-04");
    expect(data.pulled.schedule.milestones).toEqual([
      expect.objectContaining({
        title: "Tile set",
        due_on: "2026-08-20",
        completed_on: "2026-08-22",
      }),
    ]);
    expect(data.pulled.schedule.tasks).toEqual([
      expect.objectContaining({
        title: "Set tile",
        start_on: "2026-08-10",
        due_on: "2026-08-18",
        completed_on: "2026-08-19",
      }),
    ]);
    expect(data.pulled.risks[0]).toMatchObject({
      description: "Tile delay: Supplier lead time",
      impact: 4,
      probability: 3,
      mitigation: "Order early",
      roam: "mitigated",
    });
    expect(data.pulled.communications[0]).toMatchObject({
      audience: "Customer",
      channel: "phone",
      cadence: "weekly",
      notes: "Friday afternoon",
    });
    expect(
      data.pulled.suggested_roles.map((row: { name: string }) => row.name),
    ).toEqual(
      expect.arrayContaining(["Pat Manager", "Eve Estimator", "Tile Co"]),
    );
    expect(data.pulled.costs.contract_value).toBe(
      financials.body.data.contractValue.value,
    );
    expect(data.pulled.costs.budgeted_expense).toBe(
      financials.body.data.totalBudgetedExpense.value,
    );
    expect(data.pulled.costs.actual_margin).toBe(
      financials.body.data.actualMargin.value,
    );
    expect(data.pulled.costs.budgeted_margin).toBe(
      financials.body.data.budgetedMargin.value,
    );
    const committed = roundMoney(
      position.body.data.reduce(
        (sum: number, row: { committed_open: number }) =>
          sum + Number(row.committed_open),
        0,
      ),
    );
    const totalCommitted = roundMoney(
      position.body.data.reduce(
        (sum: number, row: { total_committed: number }) =>
          sum + Number(row.total_committed),
        0,
      ),
    );
    expect(data.pulled.costs.committed_open).toBe(committed);
    expect(data.pulled.costs.total_committed).toBe(totalCommitted);
    expect(data.pulled.costs.approved_change_orders).toBe(2400);
    expect(data.pulled.costs.purchase_orders).toEqual({ count: 1, total: 500 });
    expect(data.pulled.costs.vendor_bills).toEqual({ count: 1, total: 125.5 });
    expect(data.pulled.closeout).toMatchObject({
      punch_done: true,
      punch_note: "Tile edge",
      final_draw_invoice_number: "1184",
      warranty_start_on: "2026-11-01",
      photo_document_count: 1,
      closeout_document_count: 1,
    });
    expect(data.pulled.daily_logs).toEqual({
      count: 1,
      first_on: "2026-08-12",
      last_on: "2026-08-12",
    });
    const packed = JSON.stringify(data);
    expect(packed).not.toContain("DO_NOT_LEAK_SCOPE_BODY");
    expect(packed).not.toContain("DO_NOT_LEAK_LOG");
  });

  it("saves a draft, freezes the snapshot, and finalizes only when the narrative is filled", async () => {
    await enterCloseout();
    const hidden = await pm().get(summaryUrl());
    expect(hidden.body.data.available).toBe(true);

    const draft = await pm().put(summaryUrl()).send(reportBody());
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    expect(draft.body.data.finalized).toBe(false);
    expect(draft.body.data.summary.narrative.lessons_learned).toBe("");
    expect(draft.body.data.summary.narrative.critical_thinking).toBe("");
    expect(draft.body.data.summary.pulled_snapshot.cover.name).toBe(
      "Whitfield Primary Bath",
    );
    expect(draft.body.data.can_edit).toBe(true);
    const frozen = draft.body.data.summary.pulled_snapshot.costs.contract_value;

    await h.db.withTenant(t.id, (db) =>
      db.query(
        `UPDATE projects.projects SET contract_value = 50000 WHERE id = $1`,
        [projectId],
      ),
    );
    const again = await pm().get(summaryUrl());
    expect(again.body.data.pulled.costs.contract_value).toBe(50000);
    expect(again.body.data.summary.pulled_snapshot.costs.contract_value).toBe(
      frozen,
    );
    expect(frozen).not.toBe(50000);

    const rejected = await pm()
      .post(summaryUrl("/finalize"))
      .send(reportBody());
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(rejected.body)).toContain("lessons_learned");
    expect(JSON.stringify(rejected.body)).toContain("key_takeaways");

    const finalized = await pm().post(summaryUrl("/finalize")).send(finished());
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
    expect(finalized.body.data.finalized).toBe(true);
    expect(finalized.body.data.can_edit).toBe(false);
    expect(finalized.body.data.summary.narrative.lessons_learned).toBe(
      "Order tile earlier.",
    );
    expect(
      finalized.body.data.summary.narrative.learning_outcomes_summary,
    ).toBe("");
    expect(finalized.body.data.summary.narrative.critical_thinking).toBe("");
    expect(finalized.body.data.summary.learning_outcomes).toEqual([]);

    const locked = await owner().put(summaryUrl()).send(finished());
    expect(locked.status).toBe(409);

    const checklist = await pm().get(
      `/api/v1/projects/projects/${projectId}/closeout`,
    );
    expect(checklist.status).toBe(200);
    const savedChecklist = await pm()
      .put(`/api/v1/projects/projects/${projectId}/closeout`)
      .send({
        punch_done: true,
        punch_note: "Still on the card",
      });
    expect(savedChecklist.status, JSON.stringify(savedChecklist.body)).toBe(
      200,
    );
    expect(savedChecklist.body.data.punch_done_at).toBeTruthy();
    const still = await pm().get(summaryUrl());
    expect(still.body.data.summary.narrative.lessons_learned).toBe(
      "Order tile earlier.",
    );
    expect(still.body.data.finalized).toBe(true);
  });

  it("gates the PDF and the cost figures to margin access", async () => {
    await enterCloseout();
    const saved = await pm()
      .put(summaryUrl())
      .send(
        reportBody({
          narrative: { cost_commentary: "Margin held at the budget." },
        }),
      );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const officeView = await office().get(summaryUrl());
    expect(officeView.status).toBe(200);
    expect(officeView.body.data.can_view_costs).toBe(false);
    expect(officeView.body.data.can_edit).toBe(false);
    expect(officeView.body.data.pulled.costs).toBeNull();
    expect(officeView.body.data.summary.pulled_snapshot.costs).toBeNull();
    expect(officeView.body.data.summary.narrative.cost_commentary).toBe("");
    expect(officeView.body.data.summary.narrative.scope).toBe(
      "Bath remodel narrative",
    );

    expect((await office().put(summaryUrl()).send(reportBody())).status).toBe(
      403,
    );
    expect(
      (await bookkeeper().put(summaryUrl()).send(reportBody())).status,
    ).toBe(403);

    const officePdf = await office().get(summaryUrl(".pdf"));
    expect(officePdf.status).toBe(403);
    const officeHtml = await office().get(summaryUrl(".html"));
    expect(officeHtml.status).toBe(403);

    const pdf = await pdfGet(pm(), summaryUrl(".pdf"));
    expect(pdf.status, pdf.text?.slice?.(0, 200)).toBe(200);
    expect(pdf.headers["content-type"]).toMatch(/application\/pdf/);
    expect(String(pdf.headers["content-disposition"])).toContain("attachment;");
    expect(String(pdf.headers["content-disposition"])).toContain(".pdf");
    const bytes = Buffer.isBuffer(pdf.body) ? pdf.body : Buffer.from(pdf.body);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.includes(Buffer.from("Whitfield Primary Bath"))).toBe(true);

    const bookPdf = await pdfGet(bookkeeper(), summaryUrl(".pdf"));
    expect(bookPdf.status).toBe(200);

    const html = await bookkeeper().get(summaryUrl(".html"));
    expect(html.status).toBe(200);
    expect(html.text).toContain("Whitfield Primary Bath");
    expect(html.text).toContain("FINAL PROJECT REPORT");
    expect(html.text).toContain(
      "Internal closeout report · not for the customer",
    );
    expect(html.text).toContain("$41,800.00");
    expect(html.text).not.toContain("$50,000.00");
    expect(html.headers["content-type"]).toMatch(/text\/html/);
  });

  it("does not write to ServiceTitan or send mail, and leaves the risk register alone", async () => {
    await enterCloseout();
    const risk = await pm()
      .post(`/api/v1/projects/projects/${projectId}/controls`)
      .send({
        kind: "risk",
        data: {
          title: "Tile delay",
          description: "Supplier lead time",
          likelihood: 3,
          impact: 4,
          response: "Order early",
          review_on: "2026-08-15",
          roam: "mitigated",
        },
      });
    const before = await h.db.withTenant(t.id, (db) =>
      db.query<{ data: unknown }>(
        `SELECT data FROM projects.project_controls WHERE id = $1`,
        [risk.body.data.id],
      ),
    );
    const counts = async () =>
      h.db.withTenant(t.id, async (db) => {
        const publications = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM projects.record_publications`,
        );
        const links = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM projects.document_links`,
        );
        const connections = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM projects.st_project_connections`,
        );
        return {
          publications: publications.rows[0]!.n,
          links: links.rows[0]!.n,
          connections: connections.rows[0]!.n,
        };
      });
    const prior = await counts();
    const saved = await pm()
      .put(summaryUrl())
      .send(
        reportBody({
          risks: [
            {
              description: "A different wording on the report only",
              impact: 2,
              probability: 2,
              mitigation: "Watch it",
              roam: "accepted",
            },
          ],
        }),
      );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const after = await h.db.withTenant(t.id, (db) =>
      db.query<{ data: unknown }>(
        `SELECT data FROM projects.project_controls WHERE id = $1`,
        [risk.body.data.id],
      ),
    );
    expect(after.rows[0]?.data).toEqual(before.rows[0]?.data);
    expect(await counts()).toEqual(prior);
    const sources = [
      "src/routes/closeoutSummary.ts",
      "src/domain/closeoutSummary.ts",
      "src/domain/closeoutSummaryExport.ts",
    ].map((file) => readFileSync(path.join(repoRoot, file), "utf8"));
    for (const source of sources) {
      expect(source).not.toMatch(
        /from ["'][^"']*(serviceTitan|bidMail|nodemailer|mailer)/,
      );
    }
  });

  it("drafts and prints from any stage, with a banner for what is still open", async () => {
    const early = await pm().get(summaryUrl());
    expect(early.status).toBe(200);
    expect(early.body.data.available).toBe(true);
    expect(early.body.data.stage).toBe("handoff");
    expect(early.body.data.draft_banner).toBe(true);
    expect(early.body.data.warnings).toEqual([
      "The project is not in closeout or complete.",
      "Punch list is still open.",
      "Final photos are not filed.",
      "Final draw invoice is not recorded.",
      "Warranty start is not set.",
      "Review request is not recorded.",
      "Actual end date is not set.",
      "Lessons learned is empty.",
      "Achievements and obstacles is empty.",
      "Root causes is empty.",
      "Key takeaways is empty.",
      "Action items is empty.",
      "Next steps is empty.",
    ]);

    const saved = await pm().put(summaryUrl()).send(reportBody());
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.warnings).toContain(
      "The project is not in closeout or complete.",
    );
    expect(saved.body.data.warnings).toContain("Lessons learned is empty.");
    expect(saved.body.data.can_edit).toBe(true);

    const blocked = await pm().post(summaryUrl("/finalize")).send(reportBody());
    expect(blocked.status).toBe(400);

    const pdf = await pdfGet(pm(), summaryUrl(".pdf"));
    expect(pdf.status).toBe(200);
    const bytes = Buffer.isBuffer(pdf.body) ? pdf.body : Buffer.from(pdf.body);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.includes(Buffer.from("Draft, not final"))).toBe(true);
    expect(
      bytes.includes(
        Buffer.from("The project is not in closeout or complete."),
      ),
    ).toBe(true);
    const html = await pm().get(summaryUrl(".html"));
    expect(html.status).toBe(200);
    expect(html.text.indexOf("Draft, not final")).toBeLessThan(
      html.text.indexOf("FINAL PROJECT REPORT"),
    );
    expect(html.text).toContain("Punch list is still open.");
  });
});

function pdfGet(agent: ReturnType<Harness["as"]>, url: string) {
  return agent
    .get(url)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => callback(null, Buffer.concat(chunks)));
    });
}
