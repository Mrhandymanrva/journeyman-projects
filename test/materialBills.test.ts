import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { MemoryStaffSessions } from '../src/http/memoryStaffSessions.js';
import {
  AccountingFailure,
  type AccountingGateway,
} from '../src/adapters/quickbooks.js';
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from './support/harness.js';

let h: Harness;
let t: TenantFixture;
const calls: Array<Record<string, unknown>> = [];
let purchaseRejects = false;
let includeBill = false;
const gateway: AccountingGateway = {
  tenantId: '',
  async call(input) {
    calls.push(input);
    if (purchaseRejects || input.action === 'unknown') {
      throw new AccountingFailure(`unknown action ${String(input.action)}`);
    }
    if (input.action === 'purchase') {
      return {
        realm: '123',
        environment: 'sandbox',
        result: { Purchase: { Id: String(input.id), TotalAmt: 26080.88, Balance: 12 } },
      };
    }
    if (input.action === 'payables') {
      return {
        realm: '123',
        environment: 'sandbox',
        result: {
          QueryResponse: {
            Purchase: [{ Id: '9001', TotalAmt: 26080.88, DocNumber: 'CARD', TxnDate: '2026-09-01' }],
            ...(includeBill
              ? { Bill: [{ Id: '9002', TotalAmt: 26080.88, DocNumber: 'HAND', TxnDate: '2026-09-02', Balance: 0 }] }
              : {}),
          },
        },
      };
    }
    if (input.action === 'bill') {
      return {
        realm: '123',
        environment: 'sandbox',
        result: { Bill: { Id: String(input.id), TotalAmt: 26080.88, Balance: 0 } },
      };
    }
    throw new AccountingFailure(`unexpected action ${String(input.action)}`);
  },
};

beforeAll(async () => {
  h = await startHarness(undefined, undefined, undefined, gateway);
  t = await createTenant(h, { slug: 'material-bills' });
  gateway.tenantId = t.id;
});
afterAll(async () => {
  await h?.close();
});

const owner = () => h.as(t.staff.owner!.token);
const TOKEN = 'portfolio-feed-token-for-material-01';

function portfolio() {
  return supertest(
    createApp({
      database: h.db,
      staffSessions: new MemoryStaffSessions(),
      serveConsole: false,
      portfolio: { tenantId: t.id, token: TOKEN },
      accounting: gateway,
    }),
  );
}

async function summary() {
  const res = await portfolio().get('/api/v1/portfolio/summary').set('Authorization', `Bearer ${TOKEN}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.purchasing;
}

describe('material bills', () => {
  it('keeps a supplier bill out of the subcontract queue and links the QuickBooks purchase', async () => {
    const project = await owner().post('/api/v1/projects/projects').send(projectBody());
    const codes = await owner().get('/api/v1/projects/cost-codes');
    const po = await owner().post(`/api/v1/projects/projects/${project.body.data.id}/purchase-orders`).send({
      po_number: 'PO-26080',
      supplier_name: 'Cabinets To Go',
      cost_code_id: codes.body.data[0].id,
      cost_type: 'M',
      amount: 0,
      scope_text: 'Cabinets',
      issue: true,
    });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    expect(po.body.data.kind).toBe('material');

    const bill = await owner().post(`/api/v1/projects/purchase-orders/${po.body.data.id}/bills`).send({
      vendor_invoice_number: 'CTG-26080',
      amount: 26080.88,
      invoice_date: '2026-09-18',
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    expect(bill.body.data.warning.code).toBe('exceeds_purchase_order');
    expect(bill.body.data.warning.over_by).toBe(26080.88);

    let purchasing = await summary();
    expect(purchasing.bills_awaiting_approval).toEqual({ count: 0, amount: 0 });
    expect(purchasing.material_bills_unmatched).toEqual({ count: 1, amount: 26080.88 });

    purchaseRejects = true;
    const rejected = await owner().post(`/api/v1/projects/bills/${bill.body.data.id}/link-qbo`).send({
      qbo_txn_type: 'Purchase',
      qbo_id: '9001',
    });
    purchaseRejects = false;
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
    expect(rejected.body.error.message).toMatch(/bridge rejected the read-only 'purchase'/i);
    const still = await owner().get(`/api/v1/projects/purchase-orders/${po.body.data.id}/bills`);
    expect(still.body.data[0].status).toBe('received');

    const candidates = await owner().get(`/api/v1/projects/purchase-orders/${po.body.data.id}/qbo-candidates`);
    expect(candidates.status, JSON.stringify(candidates.body)).toBe(200);
    expect(candidates.body.data.transactions[0].id).toBe('9001');

    const linked = await owner().post(`/api/v1/projects/bills/${bill.body.data.id}/link-qbo`).send({
      qbo_txn_type: 'Purchase',
      qbo_id: '9001',
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.data.status).toBe('paid');
    expect(linked.body.data.source).toBe('qbo_link');
    expect(linked.body.data.qbo_txn_type).toBe('Purchase');

    purchasing = await summary();
    expect(purchasing.material_bills_unmatched).toEqual({ count: 0, amount: 0 });
    expect(purchasing.bills_awaiting_approval).toEqual({ count: 0, amount: 0 });
  });

  it('rejects a bill against a zero-dollar subcontract unless overridden', async () => {
    const project = await owner().post('/api/v1/projects/projects').send(projectBody());
    const codes = await owner().get('/api/v1/projects/cost-codes');
    const vendor = await owner().post('/api/v1/projects/vendors').send({
      legal_name: 'Zero Sub',
      email: 'zero-sub@v.test',
    });
    const kinds = await owner().get('/api/v1/projects/compliance-requirements');
    let agreementId = '';
    for (const req of kinds.body.data as Array<{ kind: string; required: boolean }>) {
      if (!req.required) continue;
      const doc = await owner().post(`/api/v1/projects/vendors/${vendor.body.data.id}/documents`).send({
        kind: req.kind,
        expires_on: '2027-12-31',
        file_key: `k/${req.kind}`,
      });
      if (req.kind === 'master_agreement') agreementId = doc.body.data.id;
    }
    const po = await owner().post(`/api/v1/projects/projects/${project.body.data.id}/purchase-orders`).send({
      po_number: 'PO-ZERO',
      vendor_id: vendor.body.data.id,
      cost_code_id: codes.body.data[0].id,
      cost_type: 'S',
      amount: 0,
      scope_text: 'No commitment yet',
      issue: true,
      agreement_document_id: agreementId,
      agreement_signed_at: '2026-10-01T00:00:00.000Z',
    });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    const blocked = await owner().post(`/api/v1/projects/purchase-orders/${po.body.data.id}/bills`).send({
      vendor_invoice_number: 'Z-1',
      amount: 100,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.code).toBe('zero_purchase_order');
    const allowed = await owner().post(`/api/v1/projects/purchase-orders/${po.body.data.id}/bills`).send({
      vendor_invoice_number: 'Z-2',
      amount: 100,
      override_zero_po: true,
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
  });

  it('lets a bookkeeper reclassify the Cabinets To Go bill onto Blanton and link it without queueing createBill', async () => {
    const prior = t;
    try {
      t = await createTenant(h, { slug: 'cabinets-blanton' });
      gateway.tenantId = t.id;
      calls.length = 0;
      includeBill = true;
      const bookkeeper = () => h.as(t.staff.bookkeeper!.token);
      const wrong = await owner().post('/api/v1/projects/projects').send(
        projectBody({ name: 'Holding project', project_number: 'HOLD-1' }),
      );
      const blanton = await owner().post('/api/v1/projects/projects').send(
        projectBody({ name: 'Blanton - Kitchen Remodel', project_number: 'BLANTON-KITCHEN' }),
      );
      expect(wrong.status).toBe(201);
      expect(blanton.status).toBe(201);
      const codes = await owner().get('/api/v1/projects/cost-codes');
      const vendor = await owner().post('/api/v1/projects/vendors').send({
        legal_name: 'Cabinets To Go',
        email: 'cabinets@v.test',
      });
      const kinds = await owner().get('/api/v1/projects/compliance-requirements');
      let agreementId = '';
      for (const req of kinds.body.data as Array<{ kind: string; required: boolean }>) {
        if (!req.required) continue;
        const doc = await owner().post(`/api/v1/projects/vendors/${vendor.body.data.id}/documents`).send({
          kind: req.kind,
          expires_on: '2027-12-31',
          file_key: `k/${req.kind}`,
        });
        if (req.kind === 'master_agreement') agreementId = doc.body.data.id;
      }
      const po = await owner().post(`/api/v1/projects/projects/${wrong.body.data.id}/purchase-orders`).send({
        po_number: '321930857',
        vendor_id: vendor.body.data.id,
        cost_code_id: codes.body.data[0].id,
        cost_type: 'S',
        amount: 26080.88,
        scope_text: 'Cabinets',
        issue: true,
        agreement_document_id: agreementId,
        agreement_signed_at: '2026-09-01T00:00:00.000Z',
      });
      expect(po.status, JSON.stringify(po.body)).toBe(201);
      expect(po.body.data.kind).toBe('subcontract');
      const budget = await h.db.withTenant(t.id, (c) =>
        c.query<{ id: string }>(
          `INSERT INTO projects.budget_lines (tenant_id, project_id, cost_code_id, cost_type, budget_amount)
           VALUES ($1, $2, $3, 'S', 1000) RETURNING id`,
          [t.id, wrong.body.data.id, codes.body.data[0].id],
        ),
      );
      await h.db.withTenant(t.id, (c) =>
        c.query(`UPDATE projects.po_lines SET budget_line_id = $2 WHERE po_id = $1`, [
          po.body.data.id,
          budget.rows[0]!.id,
        ]),
      );
      const bill = await owner().post(`/api/v1/projects/purchase-orders/${po.body.data.id}/bills`).send({
        vendor_invoice_number: 'CTG-26080',
        amount: 26080.88,
        invoice_date: '2026-09-18',
      });
      expect(bill.status, JSON.stringify(bill.body)).toBe(201);

      let purchasing = await summary();
      expect(purchasing.bills_awaiting_approval).toEqual({ count: 1, amount: 26080.88 });

      expect(
        (await bookkeeper().patch(`/api/v1/projects/purchase-orders/${po.body.data.id}`).send({ amount: 1 })).status,
      ).toBe(403);
      expect(
        (await h.as(t.staff.estimator!.token).patch(`/api/v1/projects/purchase-orders/${po.body.data.id}`).send({
          kind: 'material',
        })).status,
      ).toBe(403);

      const material = await bookkeeper().patch(`/api/v1/projects/purchase-orders/${po.body.data.id}`).send({
        kind: 'material',
      });
      expect(material.status, JSON.stringify(material.body)).toBe(200);
      expect(material.body.data.kind).toBe('material');
      purchasing = await summary();
      expect(purchasing.bills_awaiting_approval).toEqual({ count: 0, amount: 0 });
      expect(purchasing.material_bills_unmatched).toEqual({ count: 1, amount: 26080.88 });

      const moved = await bookkeeper().patch(`/api/v1/projects/purchase-orders/${po.body.data.id}`).send({
        project_id: blanton.body.data.id,
      });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body.data.project_id).toBe(blanton.body.data.id);
      const line = await h.db.withTenant(t.id, (c) =>
        c.query<{ budget_line_id: string | null }>(
          `SELECT budget_line_id FROM projects.po_lines WHERE po_id = $1`,
          [po.body.data.id],
        ),
      );
      expect(line.rows[0]!.budget_line_id).toBeNull();
      const onWrong = await bookkeeper().get(`/api/v1/projects/projects/${wrong.body.data.id}/vendor-bills`);
      const onBlanton = await bookkeeper().get(`/api/v1/projects/projects/${blanton.body.data.id}/vendor-bills`);
      expect(onWrong.body.data.bills).toEqual([]);
      expect(onBlanton.body.data.bills[0].id).toBe(bill.body.data.id);
      expect(onBlanton.body.data.bills[0].po_kind).toBe('material');

      const candidates = await bookkeeper().get(`/api/v1/projects/purchase-orders/${po.body.data.id}/qbo-candidates`);
      expect(candidates.status, JSON.stringify(candidates.body)).toBe(200);
      expect(candidates.body.data.transactions.map((txn: { txn_type: string; id: string }) => [txn.txn_type, txn.id])).toEqual([
        ['Bill', '9002'],
        ['Purchase', '9001'],
      ]);
      calls.length = 0;
      const linked = await bookkeeper().post(`/api/v1/projects/bills/${bill.body.data.id}/link-qbo`).send({
        qbo_txn_type: 'Purchase',
        qbo_id: '9001',
      });
      expect(linked.status, JSON.stringify(linked.body)).toBe(200);
      expect(linked.body.data).toMatchObject({ status: 'paid', source: 'qbo_link', qbo_txn_type: 'Purchase', qbo_id: '9001' });
      expect(calls.map((call) => call.action)).toEqual(['purchase']);
      expect(calls.some((call) => call.action === 'createBill')).toBe(false);

      const queued = await h.db.withTenant(t.id, (c) =>
        c.query(`SELECT id FROM projects.accounting_queue WHERE record_id = $1`, [bill.body.data.id]),
      );
      expect(queued.rows).toEqual([]);
      purchasing = await summary();
      expect(purchasing.bills_awaiting_approval).toEqual({ count: 0, amount: 0 });
      expect(purchasing.material_bills_unmatched).toEqual({ count: 0, amount: 0 });

      const approved = await bookkeeper().post(`/api/v1/projects/bills/${bill.body.data.id}/approve`).send({
        qbo_account_id: '71',
      });
      expect(approved.status).toBe(409);
      expect(approved.body.error.message).toMatch(/will not be sent again/i);
      const queuedAfter = await h.db.withTenant(t.id, (c) =>
        c.query(`SELECT id FROM projects.accounting_queue WHERE record_id = $1`, [bill.body.data.id]),
      );
      expect(queuedAfter.rows).toEqual([]);
      expect(calls.some((call) => call.action === 'createBill')).toBe(false);
    } finally {
      includeBill = false;
      t = prior;
      gateway.tenantId = t.id;
    }
  });
});
