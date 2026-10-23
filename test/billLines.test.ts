import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from './support/harness.js';
import {
  AccountingFailure,
  refreshAccountingBalances,
  runAccounting,
  type AccountingGateway,
} from '../src/adapters/quickbooks.js';

let h: Harness;
let t: TenantFixture;
let n = 0;
const calls: Array<Record<string, any>> = [];
let rejectMulti = false;
let balance = 0;
let lastTotal = 0;

const gateway: AccountingGateway = {
  tenantId: '',
  async call(input) {
    calls.push(input);
    if (input.action === 'bills') return { realm: '123', environment: 'sandbox', result: { QueryResponse: { Bill: [] } } };
    if (input.action === 'createBill') {
      const lines = (input.payload as { Line: Array<{ Amount: number }> }).Line;
      if (rejectMulti && lines.length > 1) {
        throw new AccountingFailure('Invalid schema: expected line length 1', false);
      }
      lastTotal = lines.reduce((sum, line) => sum + Number(line.Amount), 0);
      return {
        realm: '123',
        environment: 'sandbox',
        result: { Bill: { Id: '51', TotalAmt: lastTotal, Balance: lastTotal } },
      };
    }
    if (input.action === 'bill') {
      return {
        realm: '123',
        environment: 'sandbox',
        result: { Bill: { Id: '51', TotalAmt: lastTotal, Balance: balance } },
      };
    }
    return { realm: '123', environment: 'sandbox', result: {} };
  },
};

beforeAll(async () => {
  h = await startHarness(undefined, undefined, undefined, gateway);
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  t = await createTenant(h, { slug: `lines-${n++}` });
  gateway.tenantId = t.id;
  calls.length = 0;
  rejectMulti = false;
  balance = 0;
});

const owner = () => h.as(t.staff.owner!.token);

async function vendorAndProject() {
  const vendor = await owner().post('/api/v1/projects/vendors').send({
    legal_name: `Line Co ${n}`,
    email: `lines-${n}@v.test`,
  });
  expect(vendor.status).toBe(201);
  const vendorId = vendor.body.data.id as string;
  const kinds = await owner().get('/api/v1/projects/compliance-requirements');
  let agreementId = '';
  for (const req of kinds.body.data as Array<{ kind: string; required: boolean }>) {
    if (!req.required) continue;
    const doc = await owner().post(`/api/v1/projects/vendors/${vendorId}/documents`).send({
      kind: req.kind,
      expires_on: '2027-12-31',
      file_key: `k/${req.kind}`,
    });
    if (req.kind === 'master_agreement') agreementId = doc.body.data.id;
  }
  const project = await owner().post('/api/v1/projects/projects').send(projectBody());
  expect(project.status).toBe(201);
  const codes = await owner().get('/api/v1/projects/cost-codes');
  return {
    vendorId,
    projectId: project.body.data.id as string,
    costCodeId: codes.body.data[0].id as string,
    secondCodeId: codes.body.data[1].id as string,
    agreementId,
  };
}

async function issuedPo(amount: number, costType = 'S') {
  const ctx = await vendorAndProject();
  const po = await owner().post(`/api/v1/projects/projects/${ctx.projectId}/purchase-orders`).send({
    po_number: `PO-${n}`,
    vendor_id: ctx.vendorId,
    cost_code_id: ctx.costCodeId,
    cost_type: costType,
    amount,
    scope_text: 'Set tile',
    issue: true,
    agreement_document_id: ctx.agreementId,
    agreement_signed_at: '2026-10-01T00:00:00.000Z',
  });
  expect(po.status, JSON.stringify(po.body)).toBe(201);
  const lines = await owner().get(`/api/v1/projects/purchase-orders/${po.body.data.id}/lines`);
  return { ...ctx, poId: po.body.data.id as string, lineId: lines.body.data[0].id as string };
}

async function readyForQuickBooks(vendorId: string) {
  await h.db.withTenant(t.id, (c) =>
    c.query(
      `UPDATE projects.vendors
          SET qbo_id = '31', qbo_w9_id = '41', qbo_tax_reviewed_at = now()
        WHERE id = $1`,
      [vendorId],
    ),
  );
  await h.db.withTenant(t.id, (c) =>
    c.query(
      `INSERT INTO projects.accounting_config (tenant_id, realm, environment, accounts, customers)
       VALUES ($1, '123', 'sandbox', $2::jsonb, '[]')`,
      [t.id, JSON.stringify([{ id: '71', name: 'Subcontractors' }])],
    ),
  );
  await h.db.withTenant(t.id, (c) =>
    c.query(
      `INSERT INTO projects.accounting_queue (tenant_id, kind, record_id, payload, realm, state)
       VALUES ($1, 'vendor', $2, '{}'::jsonb, '123', 'synced')`,
      [t.id, vendorId],
    ),
  );
}

describe('bills against purchase order lines', () => {
  it('turns 10 percent of 3333.33 into a full gross of 333.33', async () => {
    const { poId, lineId } = await issuedPo(3333.33);
    const bill = await owner().post(`/api/v1/projects/purchase-orders/${poId}/bills`).send({
      vendor_invoice_number: 'PCT-10',
      lines: [{ po_line_id: lineId, pct_complete_to_date: 10 }],
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    expect(bill.body.data.lines[0]).toMatchObject({
      gross_amount: 333.33,
    });
    expect(bill.body.data.amount).toBe(333.33);
    expect(bill.body.data.retention_held).toBe(0);
    expect(bill.body.data.net_amount).toBeUndefined();
  });

  it('pushes 50 percent of 10000 as the full 5000', async () => {
    const { poId, lineId, vendorId, projectId } = await issuedPo(10000);
    const bill = await owner().post(`/api/v1/projects/purchase-orders/${poId}/bills`).send({
      vendor_invoice_number: 'HALF',
      invoice_date: '2026-10-01',
      due_date: '2026-11-01',
      lines: [{ po_line_id: lineId, pct_complete_to_date: 50 }],
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    expect(bill.body.data.amount).toBe(5000);
    expect(bill.body.data.retention_held).toBe(0);

    await readyForQuickBooks(vendorId);
    const approved = await owner().post(`/api/v1/projects/bills/${bill.body.data.id}/approve`).send({
      qbo_account_id: '71',
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    calls.length = 0;
    await runAccounting(h.db, gateway);
    const payload = calls.find((call) => call.action === 'createBill')!.payload;
    expect(payload.Line).toHaveLength(1);
    expect(payload.Line[0].Amount).toBe(5000);
    expect(payload.PrivateNote).toContain(`Journeyman PM bill ${bill.body.data.id}`);
    expect(payload.PrivateNote).not.toMatch(/retainage/i);

    balance = 0;
    await h.db.withTenant(t.id, (c) =>
      c.query(`UPDATE projects.vendor_bills SET qbo_checked_at = NULL WHERE id = $1`, [bill.body.data.id]),
    );
    await refreshAccountingBalances(h.db, gateway);
    const listed = await owner().get(`/api/v1/projects/projects/${projectId}/vendor-bills`);
    const row = listed.body.data.bills.find((item: { id: string }) => item.id === bill.body.data.id);
    expect(row.status).toBe('paid');
    expect(row.qbo_message).toBeNull();
  });

  it('rejects billing past the subcontract line', async () => {
    const { poId, lineId } = await issuedPo(1000);
    const res = await owner().post(`/api/v1/projects/purchase-orders/${poId}/bills`).send({
      vendor_invoice_number: 'OVER',
      lines: [{ po_line_id: lineId, gross_amount: 1000.01 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.code).toBe('exceeds_po_line');
  });

  it('explains a bridge that rejects a multi-line bill and does not mark it sent', async () => {
    const ctx = await vendorAndProject();
    const draft = await owner().post(`/api/v1/projects/projects/${ctx.projectId}/purchase-orders`).send({
      po_number: `PO-MULTI-${n}`,
      vendor_id: ctx.vendorId,
      cost_code_id: ctx.costCodeId,
      cost_type: 'S',
      amount: 100,
      scope_text: 'Two trades',
      agreement_document_id: ctx.agreementId,
      agreement_signed_at: '2026-10-01T00:00:00.000Z',
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const added = await owner().post(`/api/v1/projects/purchase-orders/${draft.body.data.id}/lines`).send({
      cost_code_id: ctx.secondCodeId,
      cost_type: 'M',
      description: 'Material',
      original_amount: 40,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const issued = await owner().patch(`/api/v1/projects/purchase-orders/${draft.body.data.id}`).send({
      status: 'issued',
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const lines = await owner().get(`/api/v1/projects/purchase-orders/${draft.body.data.id}/lines`);
    const bill = await owner().post(`/api/v1/projects/purchase-orders/${draft.body.data.id}/bills`).send({
      vendor_invoice_number: 'MULTI',
      lines: (lines.body.data as Array<{ id: string; current_amount: number }>).map((line) => ({
        po_line_id: line.id,
        gross_amount: line.current_amount,
      })),
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    await readyForQuickBooks(ctx.vendorId);
    expect(
      (await owner().post(`/api/v1/projects/bills/${bill.body.data.id}/approve`).send({ qbo_account_id: '71' })).status,
    ).toBe(200);
    rejectMulti = true;
    calls.length = 0;
    await runAccounting(h.db, gateway);
    const state = await h.db.withTenant(t.id, (c) =>
      c.query<{ state: string; message: string }>(
        `SELECT state, message FROM projects.accounting_queue WHERE kind = 'bill' AND record_id = $1`,
        [bill.body.data.id],
      ),
    );
    expect(state.rows[0]!.state).toBe('failed');
    expect(state.rows[0]!.message).toMatch(/rejected a bill with 2 lines/i);
    expect(calls.some((call) => call.action === 'createBill')).toBe(true);
  });
});
