import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from './support/harness.js';

/**
 * Consolidation: in-house technician invoices are generated in ServiceTitan and
 * nowhere else, and are tracked and applied to draws here.
 */

let h: Harness;
let t: TenantFixture;
let projectId: string;
let draws: Array<Record<string, any>>;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
});

const owner = () => h.as(t.staff.owner!.token);
const office = () => h.as(t.staff.office!.token);

let n = 0;
beforeEach(async () => {
  t = await createTenant(h, { slug: `extinv-${n++}` });
  const created = await owner()
    .post('/api/v1/projects/projects')
    .send(projectBody({ contract_value: 41800, external_job_id: '118432' }));
  expect(created.status).toBe(201);
  projectId = created.body.data.id;
  const list = await owner().get(`/api/v1/projects/projects/${projectId}/draws`);
  draws = list.body.data.draws;
});

async function record(body: Record<string, unknown>) {
  const res = await office().post('/api/v1/projects/external-invoices').send({
    external_invoice_number: `INV-${Math.random().toString(36).slice(2, 8)}`,
    amount: 1000,
    invoiced_on: '2026-08-01',
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

describe('recording what exists over there', () => {
  it('records an invoice with no project and says so, rather than refusing it', async () => {
    // Refusing to record an invoice until somebody decides what it is for is
    // exactly how the ones nobody files become invisible.
    const inv = await record({ amount: 450 });
    expect(inv.matched_to_project).toBe(false);
    expect(inv.warning.code).toBe('unmatched_to_project');
  });

  it('places an invoice by external job id when it can', async () => {
    const inv = await record({ external_job_id: '118432', amount: 450 });
    expect(inv.matched_to_project).toBe(true);
    expect(inv.warning).toBeNull();
  });

  it('a project coordinator can record one, and an estimator cannot', async () => {
    const res = await h
      .as(t.staff.pm!.token)
      .post('/api/v1/projects/external-invoices')
      .send({ external_invoice_number: 'X', amount: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.external_invoice_number).toBe('X');
    const estimator = await h
      .as(t.staff.estimator!.token)
      .post('/api/v1/projects/external-invoices')
      .send({ external_invoice_number: 'EST', amount: 1 });
    expect(estimator.status).toBe(403);
  });
});

describe('applying invoices to a draw', () => {
  it('takes many invoices against one draw, which is the whole point', async () => {
    // A technician invoices per visit, so a 12,540 milestone arrives as a run
    // of small invoices rather than one.
    const deposit = draws[0]!;
    for (const amount of [4000, 4000, 4540]) {
      const inv = await record({ project_id: projectId, amount });
      const applied = await office()
        .post(`/api/v1/projects/external-invoices/${inv.id}/apply`)
        .send({ draw_id: deposit.id });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    }

    const state = await owner().get(`/api/v1/projects/projects/${projectId}/external-invoices`);
    const row = (state.body.data.draws as any[]).find((d) => d.draw_id === deposit.id);
    expect(row.applied_amount).toBe(12540);
    expect(row.unapplied_amount).toBe(0);
    expect(row.invoice_count).toBe(3);
    // Deliberately NOT 'invoiced'. Matching technician detail to a milestone
    // says the work is evidenced, not that the customer has been billed.
    expect(row.status).not.toBe('invoiced');
  });

  it('marks the draw invoiced only when it is fully covered', async () => {
    const deposit = draws[0]!;
    const inv = await record({ project_id: projectId, amount: 5000 });
    await office()
      .post(`/api/v1/projects/external-invoices/${inv.id}/apply`)
      .send({ draw_id: deposit.id });

    const partial = await owner().get(`/api/v1/projects/projects/${projectId}/external-invoices`);
    const row = (partial.body.data.draws as any[]).find((d) => d.draw_id === deposit.id);
    expect(row.applied_amount).toBe(5000);
    expect(row.status).not.toBe('invoiced');
  });

  it('splits one invoice across two draws at a milestone boundary', async () => {
    const inv = await record({ project_id: projectId, amount: 3000 });
    const first = await office()
      .post(`/api/v1/projects/external-invoices/${inv.id}/apply`)
      .send({ draw_id: draws[0]!.id, amount_applied: 1800 });
    expect(first.status).toBe(200);

    const second = await office()
      .post(`/api/v1/projects/external-invoices/${inv.id}/apply`)
      .send({ draw_id: draws[1]!.id });
    expect(second.status).toBe(200);
    expect(second.body.data.amount_applied).toBe(1200);
  });

  it('refuses to apply more than the invoice is worth', async () => {
    const inv = await record({ project_id: projectId, amount: 1000 });
    const res = await office()
      .post(`/api/v1/projects/external-invoices/${inv.id}/apply`)
      .send({ draw_id: draws[0]!.id, amount_applied: 1500 });
    expect(res.status).toBe(409);
    expect(res.body.error.details.remaining).toBe(1000);
  });

  it("refuses to satisfy one project's draw with another project's invoice", async () => {
    // Both inside the tenant, so RLS does not catch this. It is a correctness
    // rule, not an isolation one.
    const other = await owner()
      .post('/api/v1/projects/projects')
      .send(projectBody({ project_number: 'OTHER-1', contract_value: 10000 }));
    const otherDraws = await owner()
      .get(`/api/v1/projects/projects/${other.body.data.id}/draws`);

    const inv = await record({ project_id: projectId, amount: 500 });
    const res = await office()
      .post(`/api/v1/projects/external-invoices/${inv.id}/apply`)
      .send({ draw_id: otherDraws.body.data.draws[0].id });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/different project/i);
  });

  it('attaches a floating invoice to the project when it is applied', async () => {
    const inv = await record({ amount: 500 });
    expect(inv.matched_to_project).toBe(false);
    await office()
      .post(`/api/v1/projects/external-invoices/${inv.id}/apply`)
      .send({ draw_id: draws[0]!.id });

    const list = await owner().get(`/api/v1/projects/projects/${projectId}/external-invoices`);
    expect((list.body.data.invoices as any[]).some((i) => i.id === inv.id)).toBe(true);
  });
});

describe('the leakage report', () => {
  it('surfaces an invoice nobody matched to a project at all', async () => {
    // Mason's case: money moved over there and never landed against a job.
    // Nothing else in the module would ever surface it.
    const orphan = await record({ amount: 1250, external_invoice_number: 'ORPHAN-1' });
    const res = await owner().get('/api/v1/projects/exceptions/unapplied-invoices');
    expect(res.status).toBe(200);

    const row = (res.body.data as any[]).find((r) => r.external_invoice_id === orphan.id);
    expect(row.unmatched_to_project).toBe(true);
    expect(row.unapplied_amount).toBe(1250);
    // Worst first: unmatched ahead of merely unapplied.
    expect((res.body.data as any[])[0].unmatched_to_project).toBe(true);
  });

  it('surfaces the unapplied remainder of a part-applied invoice', async () => {
    const inv = await record({ project_id: projectId, amount: 1000 });
    await office()
      .post(`/api/v1/projects/external-invoices/${inv.id}/apply`)
      .send({ draw_id: draws[0]!.id, amount_applied: 400 });

    const res = await owner().get('/api/v1/projects/exceptions/unapplied-invoices');
    const row = (res.body.data as any[]).find((r) => r.external_invoice_id === inv.id);
    expect(row.unapplied_amount).toBe(600);
    expect(row.unmatched_to_project).toBe(false);
  });

  it('drops off once fully applied', async () => {
    const inv = await record({ project_id: projectId, amount: 1000 });
    await office()
      .post(`/api/v1/projects/external-invoices/${inv.id}/apply`)
      .send({ draw_id: draws[0]!.id });

    const res = await owner().get('/api/v1/projects/exceptions/unapplied-invoices');
    expect((res.body.data as any[]).some((r) => r.external_invoice_id === inv.id)).toBe(false);
  });
});

describe('detail is evidence, billing is the invoice', () => {
  it('applied detail does not make the customer billed', async () => {
    // The correction. Nine technician visits matched to a milestone says the
    // work happened. Nobody has been asked for money until an invoice exists.
    const inv = await record({ project_id: projectId, amount: 5000 });
    await office()
      .post(`/api/v1/projects/external-invoices/${inv.id}/apply`)
      .send({ draw_id: draws[0]!.id });

    const res = await owner().get(`/api/v1/projects/projects/${projectId}/statement`);
    expect(res.body.data.invoiced_to_date).toBe(0);
    expect(res.body.data.remaining_to_invoice).toBe(41800);
    expect(res.body.data.draws[0].supporting_detail_applied).toBe(5000);
    expect(res.body.data.draws[0].supporting_invoice_count).toBe(1);
    expect(res.body.data.draws[0].invoiced).toBe(false);
  });

  it('issuing the invoice is what bills it', async () => {
    const deposit = draws[0]!;
    await owner().post(`/api/v1/projects/draws/${deposit.id}/earn`);
    await owner().post(`/api/v1/projects/draws/${deposit.id}/approve`);

    const issued = await office().post(`/api/v1/projects/draws/${deposit.id}/invoice`).send({});
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(issued.body.data.amount).toBe(12540);

    const res = await owner().get(`/api/v1/projects/projects/${projectId}/statement`);
    expect(res.body.data.invoiced_to_date).toBe(12540);
    expect(res.body.data.draws[0].invoice_number).toBe(issued.body.data.invoice_number);
    expect(res.body.data.draws[0].recorded_in_revenue_system).toBe(false);
  });

  it('retainage stays held until its own invoice is issued', async () => {
    const retainage = draws.find((d) => d.is_retainage)!;
    const inv = await record({ project_id: projectId, amount: 1000 });
    await office()
      .post(`/api/v1/projects/external-invoices/${inv.id}/apply`)
      .send({ draw_id: retainage.id });

    const res = await owner().get(`/api/v1/projects/projects/${projectId}/statement`);
    expect(res.body.data.retainage_held).toBe(4180);
  });
});
