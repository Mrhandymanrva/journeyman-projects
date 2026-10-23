import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from './support/harness.js';
import { runAccounting, type AccountingGateway } from '../src/adapters/quickbooks.js';

let h: Harness;
let t: TenantFixture;
let n = 0;
const calls: Array<Record<string, unknown>> = [];
const gateway: AccountingGateway = {
  tenantId: '',
  async call(input) {
    calls.push(input);
    if (input.action === 'bills') return { realm: '123', environment: 'sandbox', result: { QueryResponse: { Bill: [] } } };
    if (input.action === 'createBill') {
      return { realm: '123', environment: 'sandbox', result: { Bill: { Id: '9', TotalAmt: 100, Balance: 100 } } };
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
  t = await createTenant(h, { slug: `gate-${n++}` });
  gateway.tenantId = t.id;
  calls.length = 0;
});

const owner = () => h.as(t.staff.owner!.token);

async function projectAndCode() {
  const project = await owner().post('/api/v1/projects/projects').send(projectBody());
  const codes = await owner().get('/api/v1/projects/cost-codes');
  return { projectId: project.body.data.id as string, costCodeId: codes.body.data[0].id as string };
}

async function vendorWithDocs(expiresOn: string) {
  const created = await owner().post('/api/v1/projects/vendors').send({
    legal_name: `Gate Co ${n}`,
    email: `gate-${n}@v.test`,
  });
  const vendorId = created.body.data.id as string;
  const kinds = await owner().get('/api/v1/projects/compliance-requirements');
  let agreementId = '';
  for (const req of kinds.body.data as Array<{ kind: string; required: boolean }>) {
    if (!req.required) continue;
    const doc = await owner().post(`/api/v1/projects/vendors/${vendorId}/documents`).send({
      kind: req.kind,
      expires_on: expiresOn,
      file_key: `k/${req.kind}`,
    });
    if (req.kind === 'master_agreement') agreementId = doc.body.data.id;
  }
  return { vendorId, agreementId };
}

describe('compliance gates', () => {
  it('blocks issue and approval when insurance is expired, and still blocks scheduling', async () => {
    const { projectId, costCodeId } = await projectAndCode();
    const { vendorId, agreementId } = await vendorWithDocs('2020-01-01');
    const issued = await owner().post(`/api/v1/projects/projects/${projectId}/purchase-orders`).send({
      po_number: 'PO-EXPIRED',
      vendor_id: vendorId,
      cost_code_id: costCodeId,
      cost_type: 'S',
      amount: 1000,
      scope_text: 'Work',
      issue: true,
      agreement_document_id: agreementId,
      agreement_signed_at: '2026-10-01T00:00:00.000Z',
    });
    expect(issued.status).toBe(409);
    expect(issued.body.error.code).toBe('compliance_blocked');
    expect(issued.body.error.details.documents).toContain('gl_insurance');

    await expect(
      h.db.withTenant(t.id, (c) =>
        c.query(
          `INSERT INTO projects.schedule_items
             (tenant_id, project_id, title, vendor_id, window_start, window_end, status)
           VALUES ($1,$2,'Tile',$3,CURRENT_DATE,CURRENT_DATE + 1,'confirmed')`,
          [t.id, projectId, vendorId],
        ),
      ),
    ).rejects.toThrow(/cannot be scheduled/);
  });

  it('issues a material purchase with no vendor and no certificate of insurance', async () => {
    const { projectId, costCodeId } = await projectAndCode();
    const res = await owner().post(`/api/v1/projects/projects/${projectId}/purchase-orders`).send({
      po_number: 'PO-MAT',
      supplier_name: 'Ferguson',
      cost_code_id: costCodeId,
      cost_type: 'M',
      amount: 80,
      scope_text: 'Fittings',
      issue: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.kind).toBe('material');
  });

  it('requires a signed agreement before a subcontract can be issued', async () => {
    const { projectId, costCodeId } = await projectAndCode();
    const { vendorId } = await vendorWithDocs('2027-12-31');
    const res = await owner().post(`/api/v1/projects/projects/${projectId}/purchase-orders`).send({
      po_number: 'PO-NO-AGR',
      vendor_id: vendorId,
      cost_code_id: costCodeId,
      cost_type: 'S',
      amount: 1000,
      scope_text: 'Work',
      issue: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(res.body.error.message).toMatch(/signed agreement/i);
  });

  it('blocks approval when the certificate was expired on the invoice date', async () => {
    const { projectId, costCodeId } = await projectAndCode();
    const { vendorId, agreementId } = await vendorWithDocs('2027-12-31');
    const po = await owner().post(`/api/v1/projects/projects/${projectId}/purchase-orders`).send({
      po_number: 'PO-DATE',
      vendor_id: vendorId,
      cost_code_id: costCodeId,
      cost_type: 'S',
      amount: 1000,
      scope_text: 'Work',
      issue: true,
      agreement_document_id: agreementId,
      agreement_signed_at: '2026-10-01T00:00:00.000Z',
    });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    const bill = await owner().post(`/api/v1/projects/purchase-orders/${po.body.data.id}/bills`).send({
      vendor_invoice_number: 'LATE',
      amount: 100,
      invoice_date: '2028-06-01',
      due_date: '2028-07-01',
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    const approved = await owner().post(`/api/v1/projects/bills/${bill.body.data.id}/approve`);
    expect(approved.status).toBe(409);
    expect(approved.body.error.code).toBe('compliance_blocked');
    expect(approved.body.error.message).toMatch(/invoice date/i);
  });

  it('blocks the QuickBooks push when the W-9 has not been reviewed, including in the worker', async () => {
    const { projectId, costCodeId } = await projectAndCode();
    const { vendorId, agreementId } = await vendorWithDocs('2027-12-31');
    const po = await owner().post(`/api/v1/projects/projects/${projectId}/purchase-orders`).send({
      po_number: 'PO-W9',
      vendor_id: vendorId,
      cost_code_id: costCodeId,
      cost_type: 'S',
      amount: 1000,
      scope_text: 'Work',
      issue: true,
      agreement_document_id: agreementId,
      agreement_signed_at: '2026-10-01T00:00:00.000Z',
    });
    const bill = await owner().post(`/api/v1/projects/purchase-orders/${po.body.data.id}/bills`).send({
      vendor_invoice_number: 'W9',
      amount: 100,
      invoice_date: '2026-10-01',
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    const blocked = await owner().post(`/api/v1/projects/bills/${bill.body.data.id}/approve`).send({
      qbo_account_id: '71',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/W-9/i);

    await h.db.withTenant(t.id, async (c) => {
      await c.query(
        `UPDATE projects.vendors
            SET qbo_id = '31', qbo_w9_id = '41', qbo_tax_reviewed_at = now()
          WHERE id = $1`,
        [vendorId],
      );
      await c.query(
        `INSERT INTO projects.accounting_config (tenant_id, realm, environment, accounts)
         VALUES ($1, '123', 'sandbox', $2::jsonb)`,
        [t.id, JSON.stringify([{ id: '71', name: 'Subcontractors' }])],
      );
      await c.query(
        `INSERT INTO projects.accounting_queue (tenant_id, kind, record_id, payload, realm, state)
         VALUES ($1, 'vendor', $2, '{}'::jsonb, '123', 'synced')`,
        [t.id, vendorId],
      );
    });
    expect(
      (await owner().post(`/api/v1/projects/bills/${bill.body.data.id}/approve`).send({ qbo_account_id: '71' })).status,
    ).toBe(200);
    await h.db.withTenant(t.id, (c) =>
      c.query(
        `UPDATE projects.vendor_documents SET expires_on = '2020-01-01'
          WHERE vendor_id = $1 AND kind = 'gl_insurance'`,
        [vendorId],
      ),
    );
    calls.length = 0;
    await runAccounting(h.db, gateway);
    expect(calls.some((call) => call.action === 'createBill')).toBe(false);
    const state = await h.db.withTenant(t.id, (c) =>
      c.query<{ state: string; message: string }>(
        `SELECT state, message FROM projects.accounting_queue WHERE kind = 'bill' AND record_id = $1`,
        [bill.body.data.id],
      ),
    );
    expect(state.rows[0]!.state).toBe('failed');
    expect(state.rows[0]!.message).toMatch(/QuickBooks push|blocked/i);
  });
});
