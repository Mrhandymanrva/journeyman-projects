import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AccountingFailure,
  type AccountingGateway,
} from "../src/adapters/quickbooks.js";
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

/**
 * The project manager records a material order, leaves it awaiting the card
 * charge, and later links a QuickBooks charge by hand. Suggestions may appear
 * in between. They must not link the charge or write to QuickBooks.
 */
describe("PM enter material order then card match", () => {
  let h: Harness;
  let t: TenantFixture;
  const calls: Array<Record<string, unknown>> = [];
  let purchases: Array<Record<string, unknown>> = [];
  const gateway: AccountingGateway = {
    tenantId: "",
    async call(input) {
      calls.push(input);
      if (input.action === "createBill" || input.action === "createVendor") {
        throw new AccountingFailure(`must not ${String(input.action)}`);
      }
      if (input.action === "payables") {
        return {
          realm: "123",
          environment: "sandbox",
          result: { QueryResponse: { Purchase: purchases } },
        };
      }
      if (input.action === "purchase") {
        return {
          realm: "123",
          environment: "sandbox",
          result: {
            Purchase: { Id: String(input.id), TotalAmt: 102.5, Balance: 0 },
          },
        };
      }
      throw new AccountingFailure(`unexpected ${String(input.action)}`);
    },
  };

  beforeAll(async () => {
    h = await startHarness(undefined, undefined, undefined, gateway);
    t = await createTenant(h, { slug: "material-order-regression" });
    gateway.tenantId = t.id;
  });
  afterAll(async () => {
    await h?.close();
  });

  const pm = () => h.as(t.staff.pm!.token);
  const owner = () => h.as(t.staff.owner!.token);

  async function enterOrder(amount: number, orderNumber: string) {
    const project = await owner()
      .post("/api/v1/projects/projects")
      .send(projectBody({ project_number: `REG-${orderNumber}` }));
    expect(project.status, JSON.stringify(project.body)).toBe(201);
    const codes = await owner().get("/api/v1/projects/cost-codes");
    const code = codes.body.data[0] as { id: string; code: string };
    await h.db.withTenant(t.id, (c) =>
      c.query(
        `INSERT INTO projects.budget_lines (tenant_id, project_id, cost_code_id, cost_type, budget_amount)
         VALUES ($1, $2, $3, 'M', 500)`,
        [t.id, project.body.data.id, code.id],
      ),
    );
    calls.length = 0;
    const created = await pm()
      .post(`/api/v1/projects/projects/${project.body.data.id}/material-bills`)
      .send({
        supplier_name: "Home Depot",
        cost_code_id: code.id,
        amount,
        order_number: orderNumber,
        invoice_date: "2026-10-01",
        description: "Cabinet pulls",
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      status: "received",
      po_kind: "material",
      vendor_invoice_number: orderNumber,
      vendor: "Home Depot",
      amount,
      card_charge_state: "awaiting_card_charge",
      cost_code_id: code.id,
    });
    expect(calls).toEqual([]);
    return {
      projectId: project.body.data.id as string,
      bill: created.body.data as { id: string; po_id: string },
    };
  }

  it("suggests a likely charge and still waits for the person to link it", async () => {
    purchases = [
      {
        Id: "wild",
        TotalAmt: 900,
        DocNumber: "WILD",
        TxnDate: "2025-01-01",
        EntityRef: { name: "Unrelated" },
      },
      {
        Id: "near",
        TotalAmt: 110,
        DocNumber: "NEAR",
        TxnDate: "2026-10-03",
        EntityRef: { name: "Home Depot" },
      },
      {
        Id: "exact",
        TotalAmt: 100,
        DocNumber: "EXACT",
        TxnDate: "2026-09-20",
        EntityRef: { name: "Home Depot" },
      },
    ];
    const { projectId, bill } = await enterOrder(100, "HD-REG-1");
    calls.length = 0;

    const candidates = await pm().get(
      `/api/v1/projects/purchase-orders/${bill.po_id}/qbo-candidates?bill_id=${bill.id}`,
    );
    expect(candidates.status, JSON.stringify(candidates.body)).toBe(200);
    expect(
      candidates.body.data.suggestions.map((txn: { id: string }) => txn.id),
    ).toEqual(["exact", "near"]);
    expect(
      candidates.body.data.transactions.map(
        (txn: { id: string; suggested: boolean }) => [txn.id, txn.suggested],
      ),
    ).toEqual([
      ["exact", true],
      ["near", true],
      ["wild", false],
    ]);
    expect(calls.map((call) => call.action)).toEqual(["payables"]);

    const still = await pm().get(
      `/api/v1/projects/projects/${projectId}/vendor-bills`,
    );
    expect(still.body.data.bills[0]).toMatchObject({
      id: bill.id,
      status: "received",
      card_charge_state: "awaiting_card_charge",
    });
    expect(Number(still.body.data.bills[0].amount)).toBe(100);
    const queued = await h.db.withTenant(t.id, (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.accounting_queue WHERE record_id = $1`,
        [bill.id],
      ),
    );
    expect(queued.rows[0]?.n).toBe("0");

    const linked = await pm()
      .post(`/api/v1/projects/bills/${bill.id}/link-qbo`)
      .send({
        qbo_txn_type: "Purchase",
        qbo_id: "exact",
      });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.data).toMatchObject({
      status: "paid",
      source: "qbo_link",
      qbo_id: "exact",
      qbo_txn_type: "Purchase",
      amount: 100,
    });
    expect(
      calls.some(
        (call) =>
          call.action === "createBill" || call.action === "createVendor",
      ),
    ).toBe(false);
    const matched = await pm().get(
      `/api/v1/projects/projects/${projectId}/vendor-bills`,
    );
    expect(matched.body.data.bills[0].card_charge_state).toBe("matched");
    const cost = await pm().get(
      `/api/v1/projects/projects/${projectId}/cost-position`,
    );
    const row = (
      cost.body.data as Array<{ cost_code: string; actual_cost: number }>
    ).find((line) => line.actual_cost === 100);
    expect(row?.actual_cost).toBe(100);
  });

  it("returns no suggestions when the charges are not likely matches", async () => {
    purchases = [
      {
        Id: "wild",
        TotalAmt: 900,
        DocNumber: "WILD",
        TxnDate: "2025-01-01",
        EntityRef: { name: "Unrelated" },
      },
    ];
    const { projectId, bill } = await enterOrder(100, "HD-REG-2");
    calls.length = 0;
    const candidates = await pm().get(
      `/api/v1/projects/purchase-orders/${bill.po_id}/qbo-candidates?bill_id=${bill.id}`,
    );
    expect(candidates.status, JSON.stringify(candidates.body)).toBe(200);
    expect(candidates.body.data.suggestions).toEqual([]);
    expect(candidates.body.data.transactions[0]).toMatchObject({
      id: "wild",
      suggested: false,
    });
    const still = await pm().get(
      `/api/v1/projects/projects/${projectId}/vendor-bills`,
    );
    expect(still.body.data.bills[0].card_charge_state).toBe(
      "awaiting_card_charge",
    );
    expect(calls.map((call) => call.action)).toEqual(["payables"]);
    expect(
      calls.some(
        (call) =>
          call.action === "createBill" || call.action === "createVendor",
      ),
    ).toBe(false);
  });
});
