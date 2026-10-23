import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MemoryStaffSessions } from '../src/http/memoryStaffSessions.js';
import { AccountingFailure, type AccountingGateway } from '../src/adapters/quickbooks.js';
import {
  payablesAmountBand,
  payablesAnchor,
  payablesWindow,
} from '../src/domain/payablesWindow.js';
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from './support/harness.js';

const INVOICE = '2026-09-18';
const AMOUNT = 26080.88;

describe('payables date window', () => {
  it('opens ten days before the invoice and stops at today or sixty days', () => {
    expect(payablesWindow(INVOICE, '2026-10-23')).toEqual({ from: '2026-09-08', to: '2026-10-23' });
    expect(payablesWindow('2026-01-01', '2026-06-01')).toEqual({ from: '2025-12-22', to: '2026-02-20' });
    expect(payablesWindow('2026-12-01', '2026-10-23')).toEqual({ from: '2026-11-21', to: '2026-11-21' });
  });

  it('uses the received date when the invoice date is missing and bands the amount', () => {
    expect(payablesAnchor(null, '2026-09-20T15:04:00.000Z')).toBe('2026-09-20');
    expect(payablesAnchor(INVOICE, '2026-09-01')).toBe(INVOICE);
    expect(payablesAmountBand(AMOUNT)).toEqual({ minAmount: 22168.75, maxAmount: 32601.1 });
  });
});

describe('payables lookup against the bridge', () => {
  let h: Harness;
  let t: TenantFixture;
  const calls: Array<Record<string, unknown>> = [];
  let rejectPayables = false;
  const gateway: AccountingGateway = {
    tenantId: '',
    async call(input) {
      calls.push(input);
      if (input.action === 'createBill' || input.action === 'createVendor') {
        throw new AccountingFailure(`must not ${String(input.action)}`);
      }
      if (input.action === 'payables') {
        if (rejectPayables) throw new AccountingFailure('Invalid accounting request');
        return {
          realm: '9341455000001',
          environment: 'sandbox',
          result: {
            truncated: true,
            bills: {
              QueryResponse: {
                Bill: [
                  {
                    Id: 'b1',
                    TotalAmt: 27000,
                    DocNumber: 'BILL',
                    TxnDate: '2026-09-20',
                    VendorRef: { name: 'Cabinets To Go' },
                    Balance: 10,
                  },
                ],
              },
            },
            purchases: {
              QueryResponse: {
                Purchase: [
                  {
                    Id: 'p-far',
                    TotalAmt: 100,
                    DocNumber: 'FAR',
                    TxnDate: '2026-01-01',
                    EntityRef: { name: 'Other Store' },
                  },
                  {
                    Id: 'p-close',
                    TotalAmt: 26100,
                    DocNumber: 'CARD',
                    TxnDate: '2026-09-19',
                    EntityRef: { name: 'Cabinets To Go' },
                  },
                ],
              },
            },
          },
        };
      }
      if (input.action === 'purchase') {
        return {
          realm: '9341455000001',
          environment: 'sandbox',
          result: { Purchase: { Id: String(input.id), TotalAmt: 26100, Balance: 0 } },
        };
      }
      throw new AccountingFailure(`unexpected ${String(input.action)}`);
    },
  };

  beforeAll(async () => {
    h = await startHarness(undefined, undefined, undefined, gateway);
    t = await createTenant(h, { slug: 'payables-lookup' });
    gateway.tenantId = t.id;
    await h.db.withTenant(t.id, (c) =>
      c.query(
        `INSERT INTO projects.accounting_config (tenant_id, realm, environment)
         VALUES ($1, '9341455000001', 'sandbox')`,
        [t.id],
      ),
    );
  });
  afterAll(async () => {
    await h?.close();
  });

  const pm = () => h.as(t.staff.pm!.token);
  const owner = () => h.as(t.staff.owner!.token);

  async function costCode() {
    const codes = await owner().get('/api/v1/projects/cost-codes');
    expect(codes.status).toBe(200);
    return codes.body.data[0] as { id: string };
  }

  async function materialBill(body: Record<string, unknown>) {
    const project = await owner().post('/api/v1/projects/projects').send(
      projectBody({ project_number: `PAY-${Math.random().toString(16).slice(2, 8)}` }),
    );
    expect(project.status, JSON.stringify(project.body)).toBe(201);
    const code = await costCode();
    const created = await pm().post(`/api/v1/projects/projects/${project.body.data.id}/material-bills`).send({
      cost_code_id: code.id,
      amount: AMOUNT,
      invoice_date: INVOICE,
      order_number: `ORD-${Math.random().toString(16).slice(2, 8)}`,
      ...body,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.data as { id: string; po_id: string; amount: number };
  }

  it('asks for a date and amount window without a vendor id, parses the nested lists, and never creates a bill', async () => {
    const bill = await materialBill({ supplier_name: 'Cabinets To Go', order_number: 'SO92493149' });
    calls.length = 0;
    const window = payablesWindow(INVOICE);
    const band = payablesAmountBand(AMOUNT);

    const candidates = await pm().get(
      `/api/v1/projects/purchase-orders/${bill.po_id}/qbo-candidates?bill_id=${bill.id}`,
    );
    expect(candidates.status, JSON.stringify(candidates.body)).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      action: 'payables',
      from: window.from,
      to: window.to,
      minAmount: band.minAmount,
      maxAmount: band.maxAmount,
      expectedRealm: '9341455000001',
    });
    expect(calls[0]).not.toHaveProperty('vendorId');
    expect(calls[0]).not.toHaveProperty('date');
    expect(candidates.body.data.truncated).toBe(true);
    expect(candidates.body.data.transactions.map((txn: { id: string }) => txn.id)).toEqual([
      'p-close',
      'b1',
      'p-far',
    ]);
    expect(candidates.body.data.transactions[0]).toMatchObject({
      id: 'p-close',
      txn_type: 'Purchase',
      vendor_name: 'Cabinets To Go',
      variance: 19.12,
      suggested: true,
    });
    expect(candidates.body.data.transactions[1]).toMatchObject({
      vendor_name: 'Cabinets To Go',
      txn_type: 'Bill',
    });
    expect(candidates.body.data.transactions[2]).toMatchObject({
      vendor_name: 'Other Store',
      suggested: false,
    });

    const linked = await pm().post(`/api/v1/projects/bills/${bill.id}/link-qbo`).send({
      qbo_txn_type: 'Purchase',
      qbo_id: 'p-close',
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.data).toMatchObject({
      status: 'paid',
      source: 'qbo_link',
      qbo_id: 'p-close',
      qbo_txn_type: 'Purchase',
      variance: 19.12,
    });
    expect(Number(linked.body.data.amount)).toBe(AMOUNT);
    const purchase = calls.find((call) => call.action === 'purchase');
    expect(purchase).toEqual({
      action: 'purchase',
      id: 'p-close',
      expectedRealm: '9341455000001',
    });
    expect(calls.some((call) => call.action === 'createBill' || call.action === 'createVendor')).toBe(false);
    const queued = await h.db.withTenant(t.id, (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.accounting_queue WHERE record_id = $1`,
        [bill.id],
      ),
    );
    expect(queued.rows[0]?.n).toBe('0');
  });

  it('sends a numeric vendor id only when the vendor has one', async () => {
    const vendor = await owner().post('/api/v1/projects/vendors').send({
      legal_name: 'Cabinets To Go',
      email: 'cabinets@v.test',
    });
    expect(vendor.status).toBe(201);
    await h.db.withTenant(t.id, (c) =>
      c.query(`UPDATE projects.vendors SET qbo_id = '4242' WHERE id = $1`, [vendor.body.data.id]),
    );
    const bill = await materialBill({
      vendor_id: vendor.body.data.id,
      supplier_name: 'Cabinets To Go',
    });
    calls.length = 0;
    const found = await pm().get(`/api/v1/projects/purchase-orders/${bill.po_id}/qbo-candidates?bill_id=${bill.id}`);
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(calls[0]?.vendorId).toBe(4242);
    expect(calls[0]?.from).toBe(payablesWindow(INVOICE).from);
    expect(calls[0]?.action).toBe('payables');

    await h.db.withTenant(t.id, (c) =>
      c.query(`UPDATE projects.vendors SET qbo_id = 'not-a-number' WHERE id = $1`, [vendor.body.data.id]),
    );
    const again = await pm().get(`/api/v1/projects/purchase-orders/${bill.po_id}/qbo-candidates?bill_id=${bill.id}`);
    expect(again.status).toBe(200);
    expect(calls.at(-1)).not.toHaveProperty('vendorId');
  });

  it('tells staff to deploy the matching purchase_orders bridge when the old schema rejects the lookup', async () => {
    const bill = await materialBill({ supplier_name: 'Cabinets To Go' });
    rejectPayables = true;
    calls.length = 0;
    const rejected = await pm().get(
      `/api/v1/projects/purchase-orders/${bill.po_id}/qbo-candidates?bill_id=${bill.id}`,
    );
    rejectPayables = false;
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
    expect(rejected.body.error.message).toMatch(/Invalid accounting request/);
    expect(rejected.body.error.message).toMatch(/purchase_orders bridge needs the matching update deployed/);
    expect(rejected.body.error.message).toMatch(/Nothing was linked or queued/);
    expect(calls.some((call) => call.action === 'createBill' || call.action === 'createVendor')).toBe(false);
    const queued = await h.db.withTenant(t.id, (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.accounting_queue WHERE record_id = $1`,
        [bill.id],
      ),
    );
    expect(queued.rows[0]?.n).toBe('0');
  });

  it('does not call QuickBooks for a bill that is not the received material bill on that order', async () => {
    const bill = await materialBill({ supplier_name: 'Cabinets To Go' });
    const other = await materialBill({ supplier_name: 'Other' });
    calls.length = 0;
    const missing = await pm().get(
      `/api/v1/projects/purchase-orders/${bill.po_id}/qbo-candidates?bill_id=${other.id}`,
    );
    expect(missing.status).toBe(409);
    expect(missing.body.error.message).toMatch(/not on this purchase order/);
    expect(calls).toHaveLength(0);
  });
});
