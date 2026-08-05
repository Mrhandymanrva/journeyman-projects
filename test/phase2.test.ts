import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  estimatePayload,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from './support/harness.js';

let h: Harness;
let t: TenantFixture;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
});

let n = 0;
beforeEach(async () => {
  t = await createTenant(h, { slug: `phase2-${n++}` });
});

const owner = () => h.as(t.staff.owner!.token);

async function projectWithBudget() {
  const imported = await owner()
    .post('/api/v1/projects/estimate-imports')
    .send(estimatePayload());
  const created = await owner()
    .post('/api/v1/projects/projects')
    .send(
      projectBody({
        estimate_import_id: imported.body.data.id,
        source_kind: 'journeyman_estimate',
      }),
    );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const budget = await owner().get(`/api/v1/projects/projects/${created.body.data.id}/budget`);
  return {
    projectId: created.body.data.id as string,
    lines: budget.body.data.lines as Array<Record<string, any>>,
  };
}

/** A vendor with every required document present and unexpired. */
async function compliantVendor(name = 'Acme Tile') {
  const created = await owner()
    .post('/api/v1/projects/vendors')
    .send({
      legal_name: name,
      email: `${name.toLowerCase().replace(/\W+/g, '-')}@v.test`,
      trades: ['tile'],
      license_number: '2705-123456',
      license_authority: 'VA DPOR',
    });
  expect(created.status).toBe(201);
  const vendorId = created.body.data.id as string;

  const kinds = await owner().get('/api/v1/projects/compliance-requirements');
  for (const req of kinds.body.data as Array<{ kind: string; required: boolean }>) {
    if (!req.required) continue;
    await owner()
      .post(`/api/v1/projects/vendors/${vendorId}/documents`)
      .send({ kind: req.kind, expires_on: '2027-12-31', file_key: `k/${req.kind}` });
  }
  return vendorId;
}

describe('budget and the baseline freeze', () => {
  it('lines can be added and edited before the freeze', async () => {
    const { projectId, lines } = await projectWithBudget();
    expect(lines).toHaveLength(3);

    const edited = await owner()
      .patch(`/api/v1/projects/projects/${projectId}/budget/${lines[0]!.id}`)
      .send({ budget_amount: 5500, note: 'Revised after walk' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.budget_amount).toBe(5500);
  });

  it('editing after the freeze gate is 409 baseline_frozen', async () => {
    const { projectId, lines } = await projectWithBudget();
    await owner().post(`/api/v1/projects/projects/${projectId}/gates/0/approve`);
    await owner().post(`/api/v1/projects/projects/${projectId}/gates/1/approve`);

    const edit = await owner()
      .patch(`/api/v1/projects/projects/${projectId}/budget/${lines[0]!.id}`)
      .send({ budget_amount: 9999 });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('baseline_frozen');
    expect(edit.body.error.details.gate_number).toBe(1);
  });

  it('ADDING a line after the freeze is blocked too, not just editing', async () => {
    // The subtle one. A line added after the freeze has a null baseline_amount,
    // and v_cost_position falls back to budget_amount when baseline is null —
    // so an unblocked add silently becomes its own baseline and produces zero
    // variance no matter what is spent against it.
    const { projectId, lines } = await projectWithBudget();
    await owner().post(`/api/v1/projects/projects/${projectId}/gates/0/approve`);
    await owner().post(`/api/v1/projects/projects/${projectId}/gates/1/approve`);

    const add = await owner()
      .post(`/api/v1/projects/projects/${projectId}/budget`)
      .send({ cost_code_id: lines[0]!.cost_code_id, cost_type: 'O', budget_amount: 1200 });
    expect(add.status).toBe(409);
    expect(add.body.error.code).toBe('baseline_frozen');
  });

  it('the freeze is detected from the gate, not from baseline_amount being set', async () => {
    const { projectId } = await projectWithBudget();
    const before = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
    expect(before.body.data.baseline_frozen).toBe(false);

    await owner().post(`/api/v1/projects/projects/${projectId}/gates/0/approve`);
    await owner().post(`/api/v1/projects/projects/${projectId}/gates/1/approve`);

    const after = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
    expect(after.body.data.baseline_frozen).toBe(true);
    expect(after.body.data.frozen_by_gate).toBe(1);
    expect(after.body.data.lines.every((l: any) => l.baseline_amount !== null)).toBe(true);
  });

  it('which gate freezes is tenant configuration', async () => {
    await h.db.withTenant(t.id, async (c) => {
      await c.query(
        `UPDATE projects.gate_templates SET freezes_baseline = (gate_number = 2)
          WHERE tenant_id = $1`,
        [t.id],
      );
    });
    const { projectId, lines } = await projectWithBudget();

    await owner().post(`/api/v1/projects/projects/${projectId}/gates/0/approve`);
    await owner().post(`/api/v1/projects/projects/${projectId}/gates/1/approve`);
    const stillOpen = await owner()
      .patch(`/api/v1/projects/projects/${projectId}/budget/${lines[0]!.id}`)
      .send({ budget_amount: 1 });
    expect(stillOpen.status).toBe(200);

    await h
      .as(t.staff.pm!.token)
      .post(`/api/v1/projects/projects/${projectId}/gates/2/approve`);
    const nowFrozen = await owner()
      .patch(`/api/v1/projects/projects/${projectId}/budget/${lines[0]!.id}`)
      .send({ budget_amount: 2 });
    expect(nowFrozen.status).toBe(409);
    expect(nowFrozen.body.error.details.gate_number).toBe(2);
  });

  it('the cost export is CSV and quotes a description containing a comma', async () => {
    const { projectId } = await projectWithBudget();
    const res = await owner().get(`/api/v1/projects/projects/${projectId}/export/cost`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.split('\r\n')[0]).toBe(
      'cost_code,description,cost_type,baseline,budget_amount,actual_cost,committed_open,total_committed,variance',
    );

    // '180' in the shipped library is "Testing — radon, lead, asbestos".
    await owner()
      .post(`/api/v1/projects/projects/${projectId}/budget`)
      .send({
        cost_code_id: await costCodeIdFor('180'),
        cost_type: 'S',
        budget_amount: 450,
      });
    const withComma = await owner().get(`/api/v1/projects/projects/${projectId}/export/cost`);
    expect(withComma.text).toContain('"Testing — radon, lead, asbestos"');
  });
});

describe('purchase orders', () => {
  it('cannot be issued to a vendor with missing documents', async () => {
    const { projectId, lines } = await projectWithBudget();
    const bare = await owner()
      .post('/api/v1/projects/vendors')
      .send({ legal_name: 'Uninsured Co', email: 'u@v.test' });

    const res = await owner()
      .post(`/api/v1/projects/projects/${projectId}/purchase-orders`)
      .send({
        po_number: 'PO-1',
        vendor_id: bare.body.data.id,
        cost_code_id: lines[0]!.cost_code_id,
        cost_type: 'S',
        amount: 5200,
        scope_text: 'Set tile',
        issue: true,
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('compliance_blocked');
    expect(res.body.error.details.documents).toContain('gl_insurance');
  });

  it('can be drafted for an ineligible vendor, just not issued', async () => {
    const { projectId, lines } = await projectWithBudget();
    const bare = await owner()
      .post('/api/v1/projects/vendors')
      .send({ legal_name: 'Pending Renewal Co', email: 'p@v.test' });

    const draft = await owner()
      .post(`/api/v1/projects/projects/${projectId}/purchase-orders`)
      .send({
        po_number: 'PO-DRAFT',
        vendor_id: bare.body.data.id,
        cost_code_id: lines[0]!.cost_code_id,
        cost_type: 'S',
        amount: 100,
        scope_text: 'x',
      });
    expect(draft.status).toBe(201);
    expect(draft.body.data.status).toBe('draft');

    const issue = await owner()
      .patch(`/api/v1/projects/purchase-orders/${draft.body.data.id}`)
      .send({ status: 'issued' });
    expect(issue.status).toBe(409);
  });

  it('a counter purchase needs no vendor, just a supplier name', async () => {
    const { projectId, lines } = await projectWithBudget();
    const res = await owner()
      .post(`/api/v1/projects/projects/${projectId}/purchase-orders`)
      .send({
        po_number: 'PO-COUNTER',
        supplier_name: 'Ferguson',
        cost_code_id: lines[0]!.cost_code_id,
        cost_type: 'M',
        amount: 340.12,
        scope_text: 'Trim kit and supply lines',
        issue: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('issued');
  });

  it('needs either a vendor or a supplier name', async () => {
    const { projectId, lines } = await projectWithBudget();
    const res = await owner()
      .post(`/api/v1/projects/projects/${projectId}/purchase-orders`)
      .send({
        po_number: 'PO-NEITHER',
        cost_code_id: lines[0]!.cost_code_id,
        cost_type: 'M',
        amount: 1,
        scope_text: 'x',
      });
    expect(res.status).toBe(400);
  });

  it('shows as committed cost against the budget once issued', async () => {
    const { projectId, lines } = await projectWithBudget();
    const vendorId = await compliantVendor();
    await owner().post(`/api/v1/projects/vendors/${vendorId}/activate`);

    const tile = lines.find((l) => l.code === '1120')!;
    await owner()
      .post(`/api/v1/projects/projects/${projectId}/purchase-orders`)
      .send({
        po_number: 'PO-TILE',
        vendor_id: vendorId,
        cost_code_id: tile.cost_code_id,
        cost_type: 'S',
        amount: 5000,
        scope_text: 'Set tile',
        issue: true,
      });

    const cost = await owner().get(`/api/v1/projects/projects/${projectId}/cost-position`);
    const row = (cost.body.data as any[]).find((r) => r.cost_code === '1120');
    expect(row.committed_open).toBe(5000);
    expect(row.actual_cost).toBe(0);
    expect(row.variance).toBe(200); // 5200 budget − 5000 committed
  });
});

describe('vendor bills', () => {
  async function issuedPo() {
    const { projectId, lines } = await projectWithBudget();
    const vendorId = await compliantVendor();
    await owner().post(`/api/v1/projects/vendors/${vendorId}/activate`);
    const tile = lines.find((l) => l.code === '1120')!;
    const po = await owner()
      .post(`/api/v1/projects/projects/${projectId}/purchase-orders`)
      .send({
        po_number: `PO-${Math.random().toString(36).slice(2, 7)}`,
        vendor_id: vendorId,
        cost_code_id: tile.cost_code_id,
        cost_type: 'S',
        amount: 5000,
        scope_text: 'Set tile',
        issue: true,
      });
    return { projectId, poId: po.body.data.id as string, vendorId };
  }

  it('a bill becomes actual cost only once approved', async () => {
    const { projectId, poId } = await issuedPo();
    await owner()
      .post(`/api/v1/projects/purchase-orders/${poId}/bills`)
      .send({ vendor_invoice_number: 'INV-1', amount: 3000 });

    const received = await owner().get(`/api/v1/projects/projects/${projectId}/cost-position`);
    expect((received.body.data as any[]).find((r) => r.cost_code === '1120').actual_cost).toBe(0);

    const bills = await owner().get(`/api/v1/projects/purchase-orders/${poId}/bills`);
    const approve = await h
      .as(t.staff.bookkeeper!.token)
      .post(`/api/v1/projects/bills/${bills.body.data[0].id}/approve`);
    expect(approve.status).toBe(200);

    const after = await owner().get(`/api/v1/projects/projects/${projectId}/cost-position`);
    const row = (after.body.data as any[]).find((r) => r.cost_code === '1120');
    expect(row.actual_cost).toBe(3000);
    expect(row.committed_open).toBe(2000); // 5000 PO − 3000 billed
    expect(row.total_committed).toBe(5000);
  });

  it('overbilling warns and still records — it does not refuse', async () => {
    // An overrun that the software refuses to record is an overrun that lives
    // in somebody's inbox instead of the cost position.
    const { poId } = await issuedPo();
    const res = await owner()
      .post(`/api/v1/projects/purchase-orders/${poId}/bills`)
      .send({ vendor_invoice_number: 'INV-OVER', amount: 5600 });
    expect(res.status).toBe(201);
    expect(res.body.data.warning.code).toBe('exceeds_purchase_order');
    expect(res.body.data.warning.over_by).toBe(600);
  });

  it('a duplicate invoice number on the same PO is rejected', async () => {
    const { poId } = await issuedPo();
    await owner()
      .post(`/api/v1/projects/purchase-orders/${poId}/bills`)
      .send({ vendor_invoice_number: 'INV-DUP', amount: 100 });
    const again = await owner()
      .post(`/api/v1/projects/purchase-orders/${poId}/bills`)
      .send({ vendor_invoice_number: 'INV-DUP', amount: 100 });
    expect(again.status).toBe(409);
  });

  it('a PO with only unapproved bills can still be voided', async () => {
    const { poId } = await issuedPo();
    await owner()
      .post(`/api/v1/projects/purchase-orders/${poId}/bills`)
      .send({ vendor_invoice_number: 'INV-UNAPP', amount: 100 });

    const res = await owner()
      .patch(`/api/v1/projects/purchase-orders/${poId}`)
      .send({ status: 'void' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('void');
  });

  it('a PO with an approved bill cannot be voided', async () => {
    const { poId } = await issuedPo();
    const bill = await owner()
      .post(`/api/v1/projects/purchase-orders/${poId}/bills`)
      .send({ vendor_invoice_number: 'INV-V', amount: 100 });
    await h
      .as(t.staff.bookkeeper!.token)
      .post(`/api/v1/projects/bills/${bill.body.data.id}/approve`);

    const blocked = await owner()
      .patch(`/api/v1/projects/purchase-orders/${poId}`)
      .send({ status: 'void' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.approved_bills).toBe(1);
  });

  it('void is terminal — a voided PO cannot be amended or un-voided', async () => {
    // Deliberate. A PO that can come back has a status nobody can rely on, and
    // the cost position reads committed cost straight off it.
    const { poId } = await issuedPo();
    expect(
      (await owner().patch(`/api/v1/projects/purchase-orders/${poId}`).send({ status: 'void' }))
        .status,
    ).toBe(200);

    const revive = await owner()
      .patch(`/api/v1/projects/purchase-orders/${poId}`)
      .send({ status: 'draft' });
    expect(revive.status).toBe(409);

    const amend = await owner()
      .patch(`/api/v1/projects/purchase-orders/${poId}`)
      .send({ amount: 1 });
    expect(amend.status).toBe(409);
  });

  it('a voided PO stops counting as committed cost', async () => {
    const { projectId, poId } = await issuedPo();
    const before = await owner().get(`/api/v1/projects/projects/${projectId}/cost-position`);
    expect((before.body.data as any[]).find((r) => r.cost_code === '1120').committed_open).toBe(
      5000,
    );

    await owner().patch(`/api/v1/projects/purchase-orders/${poId}`).send({ status: 'void' });

    const after = await owner().get(`/api/v1/projects/projects/${projectId}/cost-position`);
    expect((after.body.data as any[]).find((r) => r.cost_code === '1120').committed_open).toBe(0);
  });

  it('cannot bill against a voided PO', async () => {
    const { poId } = await issuedPo();
    await owner().patch(`/api/v1/projects/purchase-orders/${poId}`).send({ status: 'void' });
    const res = await owner()
      .post(`/api/v1/projects/purchase-orders/${poId}/bills`)
      .send({ vendor_invoice_number: 'INV-AFTER-VOID', amount: 100 });
    expect(res.status).toBe(409);
  });

  it('a project manager cannot approve a bill', async () => {
    const { poId } = await issuedPo();
    const bill = await owner()
      .post(`/api/v1/projects/purchase-orders/${poId}/bills`)
      .send({ vendor_invoice_number: 'INV-ROLE', amount: 100 });
    const res = await h
      .as(t.staff.pm!.token)
      .post(`/api/v1/projects/bills/${bill.body.data.id}/approve`);
    expect(res.status).toBe(403);
  });

  it('the accounting export groups approved bills by ledger account', async () => {
    const { poId } = await issuedPo();
    const bill = await owner()
      .post(`/api/v1/projects/purchase-orders/${poId}/bills`)
      .send({ vendor_invoice_number: 'INV-EXP', amount: 2500 });
    await h
      .as(t.staff.bookkeeper!.token)
      .post(`/api/v1/projects/bills/${bill.body.data.id}/approve`);

    const res = await h.as(t.staff.bookkeeper!.token).get('/api/v1/projects/export/vendor-bills');
    expect(res.status).toBe(200);
    expect(res.text).toContain('50300 COGS — Subcontractors');
    expect(res.text).toContain('INV-EXP');

    // Unapproved bills stay out of the accounting handoff.
    await owner()
      .post(`/api/v1/projects/purchase-orders/${poId}/bills`)
      .send({ vendor_invoice_number: 'INV-UNAPPROVED', amount: 10 });
    const again = await h
      .as(t.staff.bookkeeper!.token)
      .get('/api/v1/projects/export/vendor-bills');
    expect(again.text).not.toContain('INV-UNAPPROVED');
  });
});

describe('vendors and compliance', () => {
  it('a new vendor is inactive and not schedulable', async () => {
    const res = await owner()
      .post('/api/v1/projects/vendors')
      .send({ legal_name: 'Brand New Co', email: 'bn@v.test' });
    expect(res.body.data.active).toBe(false);

    const detail = await owner().get(`/api/v1/projects/vendors/${res.body.data.id}`);
    expect(detail.body.data.eligibility.schedulable).toBe(false);
    expect(Number(detail.body.data.eligibility.missing_count)).toBe(6);
  });

  it('activation is refused until every required document is present', async () => {
    const created = await owner()
      .post('/api/v1/projects/vendors')
      .send({ legal_name: 'Half Done Co', email: 'hd@v.test' });
    const vendorId = created.body.data.id;

    await owner()
      .post(`/api/v1/projects/vendors/${vendorId}/documents`)
      .send({ kind: 'gl_insurance', expires_on: '2027-01-01', file_key: 'k/gl' });

    const refused = await owner().post(`/api/v1/projects/vendors/${vendorId}/activate`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('compliance_blocked');
    expect(refused.body.error.details.documents.map((d: any) => d.kind)).not.toContain(
      'gl_insurance',
    );
  });

  it('a compliant vendor activates and becomes schedulable', async () => {
    const vendorId = await compliantVendor('Fully Papered Co');
    const res = await owner().post(`/api/v1/projects/vendors/${vendorId}/activate`);
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(true);
    expect(res.body.data.onboarded_at).toBeTruthy();

    const list = await owner().get('/api/v1/projects/vendors');
    const row = (list.body.data as any[]).find((v) => v.id === vendorId);
    expect(row.schedulable).toBe(true);
  });

  it('an expiring document warns but does not block; an expired one blocks', async () => {
    const vendorId = await compliantVendor('Expiring Co');
    await owner().post(`/api/v1/projects/vendors/${vendorId}/activate`);

    await h.db.withTenant(t.id, async (c) => {
      await c.query(
        `UPDATE projects.vendor_documents SET expires_on = CURRENT_DATE + 10
          WHERE vendor_id = $1 AND kind = 'wc_insurance'`,
        [vendorId],
      );
    });
    const expiring = await owner().get(`/api/v1/projects/vendors/${vendorId}`);
    expect(expiring.body.data.eligibility.schedulable).toBe(true);
    expect(Number(expiring.body.data.eligibility.expiring_count)).toBe(1);

    await h.db.withTenant(t.id, async (c) => {
      await c.query(
        `UPDATE projects.vendor_documents SET expires_on = CURRENT_DATE - 1
          WHERE vendor_id = $1 AND kind = 'wc_insurance'`,
        [vendorId],
      );
    });
    const expired = await owner().get(`/api/v1/projects/vendors/${vendorId}`);
    expect(expired.body.data.eligibility.schedulable).toBe(false);
  });

  it('a requirement the tenant turns off stops blocking', async () => {
    // Requirements vary by state and by risk appetite — that is why they are
    // per tenant rather than a fixed list.
    const created = await owner()
      .post('/api/v1/projects/vendors')
      .send({ legal_name: 'No Auto Co', email: 'na@v.test' });
    const vendorId = created.body.data.id;

    const kinds = await owner().get('/api/v1/projects/compliance-requirements');
    for (const req of kinds.body.data as Array<{ kind: string; required: boolean }>) {
      if (!req.required || req.kind === 'auto_insurance') continue;
      await owner()
        .post(`/api/v1/projects/vendors/${vendorId}/documents`)
        .send({ kind: req.kind, expires_on: '2027-12-31', file_key: `k/${req.kind}` });
    }

    expect((await owner().post(`/api/v1/projects/vendors/${vendorId}/activate`)).status).toBe(409);

    const off = await owner()
      .patch('/api/v1/projects/compliance-requirements/auto_insurance')
      .send({ required: false });
    expect(off.status).toBe(200);

    expect((await owner().post(`/api/v1/projects/vendors/${vendorId}/activate`)).status).toBe(200);
  });

  it('verification records who checked and how', async () => {
    const vendorId = await compliantVendor('Verified Co');
    const detail = await owner().get(`/api/v1/projects/vendors/${vendorId}`);
    const doc = (detail.body.data.documents as any[])[0];
    expect(doc.verified_at).toBeNull();

    const res = await owner()
      .patch(`/api/v1/projects/vendors/${vendorId}/documents/${doc.id}`)
      .send({ verify_method: 'Called the carrier and confirmed the policy' });
    expect(res.status).toBe(200);
    expect(res.body.data.verified_by).toBe(t.staff.owner!.id);
    expect(res.body.data.verify_method).toContain('Called the carrier');
  });

  it('the expiring list drives the weekly report', async () => {
    const vendorId = await compliantVendor('Soon Co');
    await h.db.withTenant(t.id, async (c) => {
      await c.query(
        `UPDATE projects.vendor_documents SET expires_on = CURRENT_DATE + 5
          WHERE vendor_id = $1 AND kind = 'license'`,
        [vendorId],
      );
    });
    const res = await owner().get('/api/v1/projects/vendors/expiring');
    expect(res.status).toBe(200);
    const row = (res.body.data as any[]).find(
      (r) => r.vendor_id === vendorId && r.kind === 'license',
    );
    expect(row.state).toBe('expiring');
    expect(row.days_remaining).toBe(5);
  });

  it('"expiring" is not read as a vendor id', async () => {
    // Route ordering, asserted rather than assumed: /vendors/expiring is
    // declared before /vendors/:id, and swapping them turns a report into a
    // 404 that looks like a data problem.
    const res = await owner().get('/api/v1/projects/vendors/expiring');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('an office user can manage vendors, an estimator cannot', async () => {
    const office = await h
      .as(t.staff.office!.token)
      .post('/api/v1/projects/vendors')
      .send({ legal_name: 'Office Added Co', email: 'oa@v.test' });
    expect(office.status).toBe(201);

    const estimator = await h
      .as(t.staff.estimator!.token)
      .post('/api/v1/projects/vendors')
      .send({ legal_name: 'Estimator Added Co', email: 'ea@v.test' });
    expect(estimator.status).toBe(403);
  });
});

describe('project exceptions', () => {
  it('reports a budget line committed more than 10 percent over baseline', async () => {
    const { projectId, lines } = await projectWithBudget();
    await owner().post(`/api/v1/projects/projects/${projectId}/gates/0/approve`);
    await owner().post(`/api/v1/projects/projects/${projectId}/gates/1/approve`);

    const vendorId = await compliantVendor('Over Co');
    await owner().post(`/api/v1/projects/vendors/${vendorId}/activate`);
    const tile = lines.find((l) => l.code === '1120')!;

    await owner()
      .post(`/api/v1/projects/projects/${projectId}/purchase-orders`)
      .send({
        po_number: 'PO-OVER',
        vendor_id: vendorId,
        cost_code_id: tile.cost_code_id,
        cost_type: 'S',
        amount: 6500, // baseline was 5200
        scope_text: 'Set tile, more than planned',
        issue: true,
      });

    const res = await owner().get(`/api/v1/projects/projects/${projectId}/exceptions`);
    expect(res.status).toBe(200);
    const row = (res.body.data.budget as any[]).find((r) => r.cost_code === '1120');
    expect(row.baseline).toBe(5200);
    expect(row.total_committed).toBe(6500);
    expect(row.pct_over).toBe(25);
  });

  it('is quiet on a healthy project', async () => {
    const { projectId } = await projectWithBudget();
    const res = await owner().get(`/api/v1/projects/projects/${projectId}/exceptions`);
    expect(res.body.data.budget).toEqual([]);
    expect(res.body.data.permits).toEqual([]);
    expect(res.body.data.draws).toEqual([]);
    expect(res.body.data.missing_daily_log).toBe(false);
  });
});

async function costCodeIdFor(code: string): Promise<string> {
  const rows = await h.db.withTenant(t.id, async (c) =>
    c.query<{ id: string }>(`SELECT id FROM projects.cost_codes WHERE code = $1`, [code]),
  );
  return rows.rows[0]!.id;
}
