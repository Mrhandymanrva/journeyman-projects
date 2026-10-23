import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { MemoryStaffSessions } from '../src/http/memoryStaffSessions.js';
import { AccountingFailure, type AccountingGateway } from '../src/adapters/quickbooks.js';
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from './support/harness.js';

const ORDER = 86.42;

describe('material card charge without a QuickBooks connector', () => {
  let h: Harness;
  let t: TenantFixture;
  const token = 'portfolio-feed-token-for-card-charge';

  beforeAll(async () => {
    h = await startHarness();
    t = await createTenant(h, { slug: 'card-charge-off' });
  });
  afterAll(async () => {
    await h?.close();
  });

  const pm = () => h.as(t.staff.pm!.token);
  const owner = () => h.as(t.staff.owner!.token);

  async function costCode() {
    const codes = await owner().get('/api/v1/projects/cost-codes');
    expect(codes.status).toBe(200);
    return codes.body.data[0] as { id: string; code: string };
  }

  async function budget(projectId: string, costCodeId: string) {
    await h.db.withTenant(t.id, (c) =>
      c.query(
        `INSERT INTO projects.budget_lines (tenant_id, project_id, cost_code_id, cost_type, budget_amount)
         VALUES ($1, $2, $3, 'M', 500)`,
        [t.id, projectId, costCodeId],
      ),
    );
  }

  function portfolio() {
    return supertest(
      createApp({
        database: h.db,
        staffSessions: new MemoryStaffSessions(),
        serveConsole: false,
        portfolio: { tenantId: t.id, token },
      }),
    );
  }

  it('lets a project manager record a material order that counts as cost and waits for the card charge', async () => {
    const session = await pm().get('/api/v1/projects/session');
    expect(session.status).toBe(200);
    expect(session.body.data.capabilities).toContain('issue_purchase_order');
    expect(session.body.data.capabilities).toContain('link_material_purchase');
    expect(session.body.data.capabilities).not.toContain('approve_vendor_bill');

    const project = await owner().post('/api/v1/projects/projects').send(
      projectBody({ name: 'Blanton - Kitchen Remodel', project_number: 'CARD-1' }),
    );
    expect(project.status, JSON.stringify(project.body)).toBe(201);
    const code = await costCode();
    await budget(project.body.data.id, code.id);
    const vendor = await owner().post('/api/v1/projects/vendors').send({
      legal_name: 'Home Depot',
      email: 'depot@v.test',
    });
    expect(vendor.status).toBe(201);

    for (const role of ['estimator', 'office', 'bookkeeper'] as const) {
      const denied = await h.as(t.staff[role]!.token).post(
        `/api/v1/projects/projects/${project.body.data.id}/material-bills`,
      ).send({
        supplier_name: 'Home Depot',
        cost_code_id: code.id,
        amount: ORDER,
        order_number: `NO-${role}`,
      });
      expect(denied.status, role).toBe(403);
    }

    const created = await pm().post(`/api/v1/projects/projects/${project.body.data.id}/material-bills`).send({
      vendor_id: vendor.body.data.id,
      cost_code_id: code.id,
      amount: ORDER,
      order_number: 'HD-1001',
      invoice_date: '2026-10-01',
      description: 'Cabinet pulls',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      status: 'received',
      po_kind: 'material',
      vendor_invoice_number: 'HD-1001',
      vendor: 'Home Depot',
      amount: ORDER,
      card_charge_state: 'awaiting_card_charge',
      cost_code_id: code.id,
    });

    const listed = await pm().get(`/api/v1/projects/projects/${project.body.data.id}/vendor-bills`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.bills[0]).toMatchObject({
      status: 'received',
      po_kind: 'material',
      card_charge_state: 'awaiting_card_charge',
      vendor_invoice_number: 'HD-1001',
    });

    const cost = await pm().get(`/api/v1/projects/projects/${project.body.data.id}/cost-position`);
    const row = (cost.body.data as Array<{ cost_code: string; actual_cost: number; committed_open: number; total_committed: number }>).find(
      (line) => line.cost_code === code.code,
    );
    expect(row?.actual_cost).toBe(ORDER);
    expect(row?.committed_open).toBe(0);
    expect(row?.total_committed).toBe(ORDER);

    const summary = await portfolio().get('/api/v1/portfolio/summary').set('Authorization', `Bearer ${token}`);
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body.data.purchasing.bills_awaiting_approval).toEqual({ count: 0, amount: 0 });
    expect(summary.body.data.purchasing.material_bills_unmatched).toEqual({ count: 1, amount: ORDER });

    const queued = await h.db.withTenant(t.id, (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.accounting_queue WHERE record_id = $1`,
        [created.body.data.id],
      ),
    );
    expect(queued.rows[0]?.n).toBe('0');

    expect((await pm().post(`/api/v1/projects/bills/${created.body.data.id}/approve`).send({})).status).toBe(403);
    const approved = await h.as(t.staff.bookkeeper!.token).post(`/api/v1/projects/bills/${created.body.data.id}/approve`).send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(409);
    expect(approved.body.error.message).toMatch(/not approved/i);
    expect(approved.body.error.message).toMatch(/not sent to QuickBooks/i);

    const lookup = await pm().get(`/api/v1/projects/purchase-orders/${created.body.data.po_id}/qbo-candidates`);
    expect(lookup.status, JSON.stringify(lookup.body)).toBe(409);
    expect(lookup.body.error.message).toMatch(/PM_QBO_TENANT_ID/);
    expect(lookup.body.error.message).toMatch(/PM_ACCOUNTING_KEY/);
    expect(lookup.body.error.message).toMatch(/PO_APP_ORIGIN/);
    expect(lookup.body.error.message).toMatch(/PO_APP_USER/);
    expect(lookup.body.error.message).toMatch(/PO_APP_PASSWORD/);
    const still = await pm().get(`/api/v1/projects/projects/${project.body.data.id}/vendor-bills`);
    expect(still.body.data.bills[0].card_charge_state).toBe('awaiting_card_charge');
    expect(still.body.data.bills[0].status).toBe('received');

    const other = await owner().post('/api/v1/projects/projects').send(
      projectBody({ name: 'Other kitchen', project_number: 'CARD-2' }),
    );
    const moved = await pm().patch(`/api/v1/projects/purchase-orders/${created.body.data.po_id}`).send({
      project_id: other.body.data.id,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.data.project_id).toBe(other.body.data.id);
    expect(
      (await h.as(t.staff.estimator!.token).get(`/api/v1/projects/purchase-orders/${created.body.data.po_id}/qbo-candidates`)).status,
    ).toBe(403);
    expect(
      (await h.as(t.staff.estimator!.token).post(`/api/v1/projects/bills/${created.body.data.id}/link-qbo`).send({
        qbo_txn_type: 'Purchase',
        qbo_id: '1',
      })).status,
    ).toBe(403);
  });
});

describe('material card charge link', () => {
  let h: Harness;
  let t: TenantFixture;
  const calls: Array<Record<string, unknown>> = [];
  const gateway: AccountingGateway = {
    tenantId: '',
    async call(input) {
      calls.push(input);
      if (input.action === 'createBill' || input.action === 'createVendor') {
        throw new AccountingFailure(`must not ${String(input.action)}`);
      }
      if (input.action === 'payables') {
        return {
          realm: '123',
          environment: 'sandbox',
          result: {
            QueryResponse: {
              Purchase: [
                { Id: 'far', TotalAmt: 500, DocNumber: 'FAR', TxnDate: '2026-01-01', EntityRef: { name: 'Other Store' } },
                { Id: 'card', TotalAmt: 102.5, DocNumber: 'CARD', TxnDate: '2026-10-02', EntityRef: { name: 'Home Depot' } },
              ],
            },
          },
        };
      }
      if (input.action === 'purchase') {
        const id = String(input.id);
        return {
          realm: '123',
          environment: 'sandbox',
          result: { Purchase: { Id: id, TotalAmt: id === 'card' ? 102.5 : 500, Balance: 0 } },
        };
      }
      throw new AccountingFailure(`unexpected ${String(input.action)}`);
    },
  };

  beforeAll(async () => {
    h = await startHarness(undefined, undefined, undefined, gateway);
    t = await createTenant(h, { slug: 'card-charge-link' });
    gateway.tenantId = t.id;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('suggests the vendor and amount match, accepts tax variance, and never queues a bill', async () => {
    const pm = () => h.as(t.staff.pm!.token);
    const owner = () => h.as(t.staff.owner!.token);
    const project = await owner().post('/api/v1/projects/projects').send(projectBody({ project_number: 'CARD-LINK' }));
    const codes = await owner().get('/api/v1/projects/cost-codes');
    const code = codes.body.data[0] as { id: string; code: string };
    await h.db.withTenant(t.id, (c) =>
      c.query(
        `INSERT INTO projects.budget_lines (tenant_id, project_id, cost_code_id, cost_type, budget_amount)
         VALUES ($1, $2, $3, 'M', 500)`,
        [t.id, project.body.data.id, code.id],
      ),
    );
    const created = await pm().post(`/api/v1/projects/projects/${project.body.data.id}/material-bills`).send({
      supplier_name: 'Home Depot',
      cost_code_id: code.id,
      amount: 100,
      order_number: 'HD-2002',
      invoice_date: '2026-10-01',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    calls.length = 0;

    const candidates = await pm().get(`/api/v1/projects/purchase-orders/${created.body.data.po_id}/qbo-candidates`);
    expect(candidates.status, JSON.stringify(candidates.body)).toBe(200);
    expect(candidates.body.data.transactions[0]).toMatchObject({
      id: 'card',
      vendor_name: 'Home Depot',
      variance: 2.5,
      suggested: true,
    });
    expect(candidates.body.data.transactions[1].id).toBe('far');
    expect(calls.every((call) => call.action === 'payables')).toBe(true);

    await h.db.withTenant(t.id, (c) =>
      c.query(`UPDATE projects.purchase_orders SET kind = 'subcontract' WHERE id = $1`, [created.body.data.po_id]),
    );
    const subcontract = await pm().post(`/api/v1/projects/bills/${created.body.data.id}/link-qbo`).send({
      qbo_txn_type: 'Purchase',
      qbo_id: 'card',
    });
    expect(subcontract.status).toBe(409);
    expect(subcontract.body.error.message).toMatch(/subcontract bill is approved, not linked/i);
    await h.db.withTenant(t.id, (c) =>
      c.query(`UPDATE projects.purchase_orders SET kind = 'material' WHERE id = $1`, [created.body.data.po_id]),
    );

    const linked = await pm().post(`/api/v1/projects/bills/${created.body.data.id}/link-qbo`).send({
      qbo_txn_type: 'Purchase',
      qbo_id: 'card',
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.data).toMatchObject({
      status: 'paid',
      source: 'qbo_link',
      qbo_id: 'card',
      qbo_txn_type: 'Purchase',
      variance: 2.5,
    });
    expect(Number(linked.body.data.amount)).toBe(100);
    expect(linked.body.data.qbo_message).toMatch(/Variance 2.50/);
    expect(calls.some((call) => call.action === 'createBill' || call.action === 'createVendor')).toBe(false);

    const queued = await h.db.withTenant(t.id, (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.accounting_queue WHERE record_id = $1`,
        [created.body.data.id],
      ),
    );
    expect(queued.rows[0]?.n).toBe('0');

    const cost = await pm().get(`/api/v1/projects/projects/${project.body.data.id}/cost-position`);
    const row = (cost.body.data as Array<{ cost_code: string; actual_cost: number }>).find((line) => line.cost_code === code.code);
    expect(row?.actual_cost).toBe(100);

    const again = await pm().get(`/api/v1/projects/projects/${project.body.data.id}/vendor-bills`);
    expect(again.body.data.bills[0].card_charge_state).toBe('matched');
  });
});
