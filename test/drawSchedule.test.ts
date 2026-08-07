import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from './support/harness.js';
import { buildDrawSchedule } from '../src/domain/drawSchedule.js';

const TEMPLATE = [
  { sequence_number: 1, label: 'Deposit', trigger_milestone: 'Contract signed', percentage: 0.3, is_retainage: false },
  { sequence_number: 2, label: 'Draw 1', trigger_milestone: 'Rough-in', percentage: 0.3, is_retainage: false },
  { sequence_number: 3, label: 'Draw 2', trigger_milestone: 'Substantial', percentage: 0.3, is_retainage: false },
  { sequence_number: 4, label: 'Retainage', trigger_milestone: 'Closeout', percentage: 0.1, is_retainage: true },
];

describe('the 30/30/30/10 arithmetic', () => {
  it('divides a clean contract exactly', () => {
    const draws = buildDrawSchedule(TEMPLATE, 41800);
    expect(draws.map((d) => d.amount)).toEqual([12540, 12540, 12540, 4180]);
    expect(draws.reduce((s, d) => s + d.amount, 0)).toBe(41800);
  });

  it('never misses the contract by a cent, whatever the contract is', () => {
    // The last draw takes the remainder rather than its own percentage. Three
    // rounded instalments plus a rounded retainage can otherwise miss by a
    // penny, and a statement that is a penny out is a statement somebody has
    // to explain.
    for (const value of [41833.33, 57200.01, 1.03, 99999.99, 68400.55, 7.77]) {
      const draws = buildDrawSchedule(TEMPLATE, value);
      const total = draws.reduce((s, d) => s + d.amount, 0);
      expect(Math.round(total * 100), `contract ${value}`).toBe(Math.round(value * 100));
    }
  });

  it('marks the retainage, and it is not merely the last one', () => {
    const draws = buildDrawSchedule(TEMPLATE, 41800);
    expect(draws.filter((d) => d.is_retainage).map((d) => d.label)).toEqual(['Retainage']);

    const noRetainage = buildDrawSchedule(
      TEMPLATE.map((t) => ({ ...t, is_retainage: false })),
      41800,
    );
    expect(noRetainage.some((d) => d.is_retainage)).toBe(false);
  });

  it('seeds nothing rather than a schedule with a zero draw', () => {
    // A contract too small for the percentages produces a draw of 0, which the
    // amount > 0 check would reject anyway. Better to seed nothing than
    // something that has to be deleted.
    expect(buildDrawSchedule(TEMPLATE, 0.01)).toEqual([]);
    expect(buildDrawSchedule([], 41800)).toEqual([]);
  });
});

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
  t = await createTenant(h, { slug: `draws-${n++}` });
});

const owner = () => h.as(t.staff.owner!.token);

describe('project creation seeds the schedule', () => {
  it('creates the tenant default, which closes the open item', async () => {
    const created = await owner()
      .post('/api/v1/projects/projects')
      .send(projectBody({ contract_value: 41800 }));
    expect(created.status).toBe(201);
    expect(created.body.data.draws_created).toBe(4);

    const draws = await owner()
      .get(`/api/v1/projects/projects/${created.body.data.id}/draws`);
    expect(draws.body.data.draws.map((d: any) => [d.label, d.amount])).toEqual([
      ['Deposit', 12540],
      ['Draw 1', 12540],
      ['Draw 2', 12540],
      ['Retainage', 4180],
    ]);
  });

  it('follows the tenant template, not a hardcoded 30/30/30/10', async () => {
    await h.db.withTenant(t.id, async (c) => {
      await c.query(`DELETE FROM projects.draw_templates WHERE tenant_id = $1`, [t.id]);
      await c.query(
        `INSERT INTO projects.draw_templates
           (tenant_id, sequence_number, label, trigger_milestone, percentage, is_retainage)
         VALUES ($1,1,'Half up front','Signed',0.5,false),
                ($1,2,'Balance','Complete',0.5,false)`,
        [t.id],
      );
    });
    const created = await owner()
      .post('/api/v1/projects/projects')
      .send(projectBody({ contract_value: 10000 }));
    expect(created.body.data.draws_created).toBe(2);

    const draws = await owner().get(`/api/v1/projects/projects/${created.body.data.id}/draws`);
    expect(draws.body.data.draws.map((d: any) => d.amount)).toEqual([5000, 5000]);
  });
});

describe('the statement', () => {
  async function project(contract = 41800) {
    const created = await owner()
      .post('/api/v1/projects/projects')
      .send(projectBody({ contract_value: contract }));
    return created.body.data.id as string;
  }

  it('reports retainage as held, not as merely unbilled', async () => {
    const projectId = await project();
    const res = await owner().get(`/api/v1/projects/projects/${projectId}/statement`);
    expect(res.status).toBe(200);
    expect(res.body.data.original_contract).toBe(41800);
    expect(res.body.data.draw_schedule_total).toBe(41800);
    expect(res.body.data.retainage_held).toBe(4180);
    expect(res.body.data.invoiced_to_date).toBe(0);
  });

  it('adds approved change orders to the revised contract but not to the draw schedule', async () => {
    // Change orders are invoiced separately and do not reopen the schedule, so
    // these two deliberately disagree and the gap is the change orders.
    const projectId = await project();
    const co = await owner()
      .post(`/api/v1/projects/projects/${projectId}/change-orders`)
      .send({ description: 'Upgraded tile', customer_amount: 2400 });
    await owner().post(`/api/v1/projects/change-orders/${co.body.data.id}/send`);
    await owner().post(`/api/v1/projects/change-orders/${co.body.data.id}/approve`).send({});

    const res = await owner().get(`/api/v1/projects/projects/${projectId}/statement`);
    expect(res.body.data.original_contract).toBe(41800);
    expect(res.body.data.approved_change_orders).toBe(2400);
    expect(res.body.data.revised_contract).toBe(44200);
    expect(res.body.data.draw_schedule_total).toBe(41800);
    expect(res.body.data.remaining_to_invoice).toBe(44200);
    expect(res.body.data.change_orders).toHaveLength(1);
  });

  it('moves a draw from remaining to invoiced when the invoice number lands', async () => {
    const projectId = await project();
    const draws = await owner().get(`/api/v1/projects/projects/${projectId}/draws`);
    const deposit = draws.body.data.draws[0];

    await owner().post(`/api/v1/projects/draws/${deposit.id}/earn`);
    await owner().post(`/api/v1/projects/draws/${deposit.id}/approve`);

    const earned = await owner().get(`/api/v1/projects/projects/${projectId}/statement`);
    expect(earned.body.data.earned_not_yet_invoiced).toBe(12540);
    expect(earned.body.data.invoiced_to_date).toBe(0);

    await owner()
      .post(`/api/v1/projects/draws/${deposit.id}/external-invoice`)
      .send({ external_invoice_number: '118432-1' });

    const after = await owner().get(`/api/v1/projects/projects/${projectId}/statement`);
    expect(after.body.data.invoiced_to_date).toBe(12540);
    expect(after.body.data.earned_not_yet_invoiced).toBe(0);
    expect(after.body.data.remaining_to_invoice).toBe(41800 - 12540);
    expect(after.body.data.draws[0].invoiced).toBe(true);
    // Carrying a reference in the revenue system is a different claim from
    // having been verified against it.
    expect(after.body.data.draws[0].recorded_in_revenue_system).toBe(true);
    expect(after.body.data.draws[0].verified).toBe(false);
  });

  it('carries no cost and no margin', async () => {
    // A statement is the customer-facing view of a project's money. The moment
    // cost appears on it, somebody sends it out with the job's margin on it.
    const projectId = await project();
    const res = await owner().get(`/api/v1/projects/projects/${projectId}/statement`);
    const body = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of ['margin', 'cost_code', 'baseline', 'committed', 'budget']) {
      expect(body, `statement leaks ${forbidden}`).not.toContain(forbidden);
    }
  });
});
