import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import { annotateDrawList, storeProjectAr } from "../src/domain/arMatch.js";
import { tickGate } from "./support/tickGate.js";
import {
  SCHEMA_FILES,
  createTenant,
  estimatePayload,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const sources: SourceConnections = {};
let h: Harness;
let t: TenantFixture;
let projectId: string;
let systemId: string;
let n = 0;

beforeAll(async () => {
  h = await startHarness(undefined, sources);
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  t = await createTenant(h, { slug: `ar-${n++}` });
  const imported = await owner().post("/api/v1/projects/estimate-imports").send(estimatePayload());
  const created = await owner()
    .post("/api/v1/projects/projects")
    .send(
      projectBody({
        estimate_import_id: imported.body.data.id,
        source_kind: "journeyman_estimate",
        contract_value: 41800,
      }),
    );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  projectId = created.body.data.id;
  systemId = (
    await h.db.withTenant(t.id, (db) =>
      db.query<{ id: string }>(
        `INSERT INTO projects.external_systems (tenant_id, adapter_key, display_name, is_revenue_system_of_record)
         VALUES ($1, 'servicetitan', 'ServiceTitan', true)
         ON CONFLICT (tenant_id, adapter_key) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [t.id],
      ),
    )
  ).rows[0]!.id;
  await h.db.withTenant(t.id, (db) =>
    db.query(
      `INSERT INTO projects.project_job_links
         (tenant_id, project_id, external_system_id, external_job_id, title, source_active)
       VALUES ($1,$2,$3,'900184','Field job', true)`,
      [t.id, projectId, systemId],
    ),
  );
});

const owner = () => h.as(t.staff.owner!.token);

describe("draw matching", () => {
  it("matches ignoring case, suggests one unused invoice, and does not pick among two", () => {
    const invoices = [
      view("1", " st-100 "),
      view("2", "ST-200"),
      view("3", "ST-300"),
    ];
    const one = annotateDrawList(
      [
        { id: "a", external_invoice_number: "ST-100", external_invoice_verified_at: "2026-10-25T00:00:00.000Z" },
        { id: "b", external_invoice_number: null },
      ],
      invoices.slice(0, 2),
    );
    expect(one.draws[0]?.match.state).toBe("matched");
    expect(one.draws[0]?.match.invoice_number).toBe(" st-100 ");
    expect(one.draws[0]?.match.verified_at).toBe("2026-10-25T00:00:00.000Z");
    expect(one.draws[1]?.match.state).toBe("suggested");
    expect(one.draws[1]?.suggestion?.invoice_number).toBe("ST-200");
    expect(one.draws[1]?.external_invoice_number).toBeNull();

    const two = annotateDrawList([{ id: "b", external_invoice_number: "  " }], invoices.slice(1));
    expect(two.draws[0]?.match.state).toBe("none");
    expect(two.unmatched_invoices.map((row) => row.invoice_number)).toEqual(["ST-200", "ST-300"]);
  });

  it("marks a zero balance paid and walks it back, without filling a blank number", async () => {
    const scheduled = await owner().post(`/api/v1/projects/projects/${projectId}/draws`).send({
      draws: [
        { label: "Deposit", trigger_milestone: "Start", amount: 1000 },
        { label: "Progress", trigger_milestone: "Tile", amount: 2000 },
        { label: "Final", trigger_milestone: "Done", amount: 500 },
      ],
    });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201);
    const draws = await owner().get(`/api/v1/projects/projects/${projectId}/draws`);
    const [deposit, progress, final] = draws.body.data.draws as Array<{ id: string }>;
    const numbered = await owner()
      .patch(`/api/v1/projects/draws/${deposit!.id}/external-invoice`)
      .send({ external_invoice_number: "st-100" });
    expect(numbered.body.data.status).toBe("invoiced");
    await h.db.withTenant(t.id, async (db) => {
      await db.query(`UPDATE projects.draws SET external_invoice_number = 'KEEP' WHERE id = $1`, [progress!.id]);
      await db.query(`UPDATE projects.draws SET status = 'scheduled' WHERE id = $1`, [progress!.id]);
    });

    await save({
      invoices: [
        invoice("inv-1", "ST-100", 0),
        invoice("inv-2", "KEEP", 0),
        invoice("inv-3", "ST-4401", 400),
      ],
    });
    const paid = await owner().get(`/api/v1/projects/projects/${projectId}/draws`);
    const rows = paid.body.data.draws as Array<{
      id: string;
      status: string;
      paid_on: string | null;
      external_invoice_number: string | null;
      match: { state: string };
    }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(deposit!.id)?.status).toBe("paid");
    expect(byId.get(deposit!.id)?.paid_on).toBe("2026-10-12");
    expect(byId.get(deposit!.id)?.match.state).toBe("matched");
    expect(byId.get(progress!.id)?.status).toBe("scheduled");
    expect(byId.get(final!.id)?.external_invoice_number).toBeNull();
    expect(byId.get(final!.id)?.match.state).toBe("suggested");
    expect(paid.body.data.unmatched_invoices).toHaveLength(1);

    await save({
      invoices: [invoice("inv-1", "ST-100", 25), invoice("inv-2", "KEEP", 0)],
    });
    const walked = await owner().get(`/api/v1/projects/projects/${projectId}/draws`);
    const depositAfter = (walked.body.data.draws as Array<{ id: string; status: string; paid_on: string | null }>).find(
      (row) => row.id === deposit!.id,
    );
    expect(depositAfter?.status).toBe("invoiced");
    expect(depositAfter?.paid_on).toBeNull();
    const discovered = await h.db.withTenant(t.id, (db) =>
      db.query<{ n: string }>(`SELECT count(*)::text AS n FROM projects.external_invoices`),
    );
    expect(discovered.rows[0]?.n).toBe("0");
    expect(SCHEMA_FILES.some((file) => file.endsWith("038_st_ar_observations.sql"))).toBe(true);
  });

  it("keeps the previous observations when ServiceTitan refuses the read", async () => {
    await save({ invoices: [invoice("inv-1", "ST-100", 10)] });
    sources.serviceTitan = {
      tenantId: t.id,
      externalSystemId: systemId,
      key: "st:test",
      client: {
        readJob: async () => {
          throw new Error("unused");
        },
        readInvoices: async () => ({ forbidden: true, invoices: [] }),
        readPayments: async () => ({ forbidden: true, payments: [] }),
        readEstimates: async () => ({ forbidden: true, estimates: [] }),
      },
    };
    const refused = await owner().post(`/api/v1/projects/projects/${projectId}/servicetitan/ar-refresh`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(200);
    expect(refused.body.data.refreshed).toBe(false);
    expect(refused.body.data.message).toMatch(/did not allow this read/i);
    const kept = await h.db.withTenant(t.id, (db) =>
      db.query<{ n: string }>(`SELECT count(*)::text AS n FROM projects.st_invoice_observations`),
    );
    expect(kept.rows[0]?.n).toBe("1");
  });

  it("does not let a sold estimate change the budget until Approve", async () => {
    const budget = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
    const tile = (budget.body.data.lines as Array<{ code: string; cost_code_id: string; budget_amount: number }>).find(
      (line) => line.code === "1110",
    )!;
    const before = tile.budget_amount;
    const raised = await owner().post(`/api/v1/projects/projects/${projectId}/change-orders`).send({
      description: "Customer upgraded the tile",
      customer_amount: 2400,
      lines: [{ cost_code_id: tile.cost_code_id, cost_type: "M", amount: 1500 }],
    });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    await owner().post(`/api/v1/projects/change-orders/${raised.body.data.id}/entered`).send({
      st_estimate_number: "est-9",
    });
    await save({
      estimates: [
        {
          externalEstimateId: "est-9",
          name: "Tile upgrade",
          externalJobId: "900184",
          status: "Sold",
          soldOn: "2026-10-18",
          customerAmount: 2400,
        },
      ],
    });
    const listed = await owner().get(`/api/v1/projects/projects/${projectId}/change-orders`);
    expect(listed.body.data.pending_estimate_revisions).toBe(2400);
    expect(listed.body.data.unmatched_sold_estimates).toHaveLength(1);
    expect(listed.body.data.change_orders[0].st_estimate.customer_amount).toBe(2400);
    const statement = await owner().get(`/api/v1/projects/projects/${projectId}/statement`);
    expect(statement.body.data.revised_contract).toBe(41800);
    expect(statement.body.data.pending_estimate_revisions).toBe(2400);
    const frozen = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
    const still = (frozen.body.data.lines as Array<{ code: string; budget_amount: number }>).find(
      (line) => line.code === "1110",
    );
    expect(still?.budget_amount).toBe(before);

    const early = await owner().post(`/api/v1/projects/change-orders/${raised.body.data.id}/approve`).send({});
    expect(early.status).toBe(409);
    await owner().post(`/api/v1/projects/projects/${projectId}/gates/0/approve`);
    await tickGate(owner(), projectId, 1);
    await owner().post(`/api/v1/projects/projects/${projectId}/gates/1/approve`);
    await owner().post(`/api/v1/projects/change-orders/${raised.body.data.id}/send`);
    const approved = await owner().post(`/api/v1/projects/change-orders/${raised.body.data.id}/approve`).send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const after = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
    const moved = (after.body.data.lines as Array<{ code: string; budget_amount: number }>).find(
      (line) => line.code === "1110",
    );
    expect(moved?.budget_amount).toBe(before + 1500);
    const settled = await owner().get(`/api/v1/projects/projects/${projectId}/statement`);
    expect(settled.body.data.revised_contract).toBe(44200);
    expect(settled.body.data.pending_estimate_revisions).toBe(0);
  });
});

function view(id: string, number: string) {
  return {
    external_invoice_id: id,
    invoice_number: number,
    external_job_id: "900184",
    total: 100,
    balance: 100,
    paid_on: null,
    invoiced_on: "2026-10-01",
  };
}

function invoice(id: string, number: string, balance: number) {
  return {
    externalInvoiceId: id,
    invoiceNumber: number,
    externalJobId: "900184",
    total: 1000,
    balance,
    invoicedOn: "2026-10-01",
    paidOn: balance === 0 ? "2026-10-12" : null,
  };
}

async function save(read: {
  invoices?: ReturnType<typeof invoice>[];
  estimates?: Array<{
    externalEstimateId: string;
    name: string;
    externalJobId: string;
    status: string;
    soldOn: string;
    customerAmount: number;
  }>;
}) {
  await h.db.withTenant(t.id, (db) =>
    storeProjectAr(db, {
      tenantId: t.id,
      projectId,
      externalSystemId: systemId,
      jobIds: ["900184"],
      read: {
        forbidden: false,
        invoices: read.invoices ?? [],
        payments: [],
        estimates: read.estimates ?? [],
      },
    }),
  );
}
