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
        result: { QueryResponse: { Purchase: [{ Id: '9001', TotalAmt: 26080.88, DocNumber: 'CARD', TxnDate: '2026-09-01' }] } },
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
});
