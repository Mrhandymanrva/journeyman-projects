import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  estimatePayload,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from './support/harness.js';
import { tickGate } from './support/tickGate.js';

let h: Harness;
let t: TenantFixture;
let projectId: string;
let lines: Array<Record<string, any>>;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
});

const owner = () => h.as(t.staff.owner!.token);
const pm = () => h.as(t.staff.pm!.token);

let n = 0;
beforeEach(async () => {
  t = await createTenant(h, { slug: `co-${n++}` });
  const imported = await owner().post('/api/v1/projects/estimate-imports').send(estimatePayload());
  const created = await owner()
    .post('/api/v1/projects/projects')
    .send(
      projectBody({
        estimate_import_id: imported.body.data.id,
        source_kind: 'journeyman_estimate',
        contract_value: 41800,
        scheduled_start: '2026-08-01',
        scheduled_end: '2026-09-01',
      }),
    );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  projectId = created.body.data.id;
  const budget = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
  lines = budget.body.data.lines;
});

const codeFor = (code: string) => lines.find((l) => l.code === code)!.cost_code_id as string;

async function raise(body: Record<string, unknown> = {}) {
  const res = await owner()
    .post(`/api/v1/projects/projects/${projectId}/change-orders`)
    .send({
      description: 'Customer upgraded the tile selection',
      customer_amount: 2400,
      schedule_impact_days: 3,
      lines: [{ cost_code_id: codeFor('1110'), cost_type: 'M', amount: 1500 }],
      ...body,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function freeze() {
  await owner().post(`/api/v1/projects/projects/${projectId}/gates/0/approve`);
  await tickGate(owner(), projectId, 1);
  await owner().post(`/api/v1/projects/projects/${projectId}/gates/1/approve`);
}

describe('raising a change order', () => {
  it('numbers sequentially per project and derives cost from its lines', async () => {
    const first = await raise();
    expect(first.co_number).toBe(1);
    expect(first.cost_amount).toBe(1500);
    expect(first.margin_on_this_change).toBeCloseTo((2400 - 1500) / 2400, 4);

    const second = await raise({ description: 'Second' });
    expect(second.co_number).toBe(2);
  });

  it('accepts negative lines, because removing scope is a change order too', async () => {
    const co = await raise({
      description: 'Customer dropped the heated floor',
      customer_amount: -1800,
      lines: [{ cost_code_id: codeFor('1110'), cost_type: 'M', amount: -1200 }],
    });
    expect(co.cost_amount).toBe(-1200);
  });

  it('an estimator cannot raise one', async () => {
    const res = await h
      .as(t.staff.estimator!.token)
      .post(`/api/v1/projects/projects/${projectId}/change-orders`)
      .send({ description: 'x', customer_amount: 1 });
    expect(res.status).toBe(403);
  });

  it('can be amended while it is a draft, and not once it has gone out', async () => {
    const co = await raise();
    const amended = await owner()
      .patch(`/api/v1/projects/change-orders/${co.id}`)
      .send({ customer_amount: 2600 });
    expect(amended.status).toBe(200);

    await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
    const late = await owner()
      .patch(`/api/v1/projects/change-orders/${co.id}`)
      .send({ customer_amount: 9999 });
    expect(late.status).toBe(409);
  });
});

describe('the approval sequence', () => {
  it('cannot be approved before it has been sent', async () => {
    const co = await raise();
    const early = await owner().post(`/api/v1/projects/change-orders/${co.id}/approve`).send({});
    expect(early.status).toBe(409);
    expect(early.body.error.message).toMatch(/send/i);
  });

  it('records the date the customer actually agreed, not the date it was typed', async () => {
    const co = await raise();
    await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
    const res = await owner()
      .post(`/api/v1/projects/change-orders/${co.id}/approve`)
      .send({ customer_approved_at: '2026-08-02' });
    expect(res.status).toBe(200);
    expect(String(res.body.data.customer_approved_at)).toContain('2026-08-02');
  });

  it('an approved change order cannot be rejected — it has to be reversed', async () => {
    const co = await raise();
    await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
    await owner().post(`/api/v1/projects/change-orders/${co.id}/approve`).send({});
    const res = await owner().post(`/api/v1/projects/change-orders/${co.id}/reject`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/reversing/i);
  });
});

describe('the approval threshold', () => {
  it('is a tenant setting, and a PM may approve at or below it', async () => {
    const list = await owner().get(`/api/v1/projects/projects/${projectId}/change-orders`);
    expect(list.body.data.approval_threshold).toBe(5000);

    const co = await raise({ customer_amount: 4000 });
    await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
    const res = await pm().post(`/api/v1/projects/change-orders/${co.id}/approve`).send({});
    expect(res.status).toBe(200);
  });

  it('a PM may not approve above it', async () => {
    const co = await raise({ customer_amount: 9000 });
    await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
    const refused = await pm().post(`/api/v1/projects/change-orders/${co.id}/approve`).send({});
    expect(refused.status).toBe(403);
    expect(refused.body.error.details.capability).toBe('approve_change_order_over_threshold');

    const allowed = await h
      .as(t.staff.manager!.token)
      .post(`/api/v1/projects/change-orders/${co.id}/approve`)
      .send({});
    expect(allowed.status).toBe(200);
  });

  it('moves when the tenant moves it', async () => {
    await h.db.withTenant(t.id, async (c) => {
      await c.query(
        `UPDATE projects.tenant_settings SET change_order_approval_threshold = 500
          WHERE tenant_id = $1`,
        [t.id],
      );
    });
    const co = await raise({ customer_amount: 1000 });
    await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
    const res = await pm().post(`/api/v1/projects/change-orders/${co.id}/approve`).send({});
    expect(res.status).toBe(403);
  });
});

describe('what approval does to the project', () => {
  it('adds to revised contract without touching contract_value', async () => {
    const before = await owner().get(`/api/v1/projects/projects/${projectId}/margin`);
    expect(before.body.data.revised_contract).toBe(41800);

    const co = await raise({ customer_amount: 2400 });
    await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
    await owner().post(`/api/v1/projects/change-orders/${co.id}/approve`).send({});

    const after = await owner().get(`/api/v1/projects/projects/${projectId}/margin`);
    expect(after.body.data.revised_contract).toBe(44200);

    // The contract value itself must not move, or the change order is counted
    // twice — v_project_margin already sums approved change orders into it.
    const project = await owner().get(`/api/v1/projects/projects/${projectId}`);
    expect(project.body.data.contract_value).toBe(41800);
  });

  it('adds the cost to the budget line for that code', async () => {
    const co = await raise({
      lines: [{ cost_code_id: codeFor('1110'), cost_type: 'M', amount: 1500 }],
    });
    await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
    const res = await owner().post(`/api/v1/projects/change-orders/${co.id}/approve`).send({});
    expect(res.body.data.budget_lines_updated).toBe(1);
    expect(res.body.data.budget_lines_created).toBe(0);

    const cost = await owner().get(`/api/v1/projects/projects/${projectId}/cost-position`);
    const row = (cost.body.data as any[]).find((r) => r.cost_code === '1110');
    expect(row.budget_amount).toBe(3480); // 1980 + 1500
  });

  it('creates a budget line for a code the project did not have', async () => {
    const punch = await h.db.withTenant(t.id, async (c) =>
      c.query<{ id: string }>(`SELECT id FROM projects.cost_codes WHERE code = '1410'`),
    );
    const co = await raise({
      lines: [{ cost_code_id: punch.rows[0]!.id, cost_type: 'L', amount: 800 }],
    });
    await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
    const res = await owner().post(`/api/v1/projects/change-orders/${co.id}/approve`).send({});
    expect(res.body.data.budget_lines_created).toBe(1);

    const cost = await owner().get(`/api/v1/projects/projects/${projectId}/cost-position`);
    expect((cost.body.data as any[]).some((r) => r.cost_code === '1410')).toBe(true);
  });

  it('pushes scheduled_end out by the schedule impact', async () => {
    const co = await raise({ schedule_impact_days: 5 });
    await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
    const res = await owner().post(`/api/v1/projects/change-orders/${co.id}/approve`).send({});
    expect(res.body.data.scheduled_end).toBe('2026-09-06');
  });

  it('warns when it carries cost with no lines, because that cost reaches nothing', async () => {
    const co = await raise({ lines: [] });
    await h.db.withTenant(t.id, async (c) => {
      await c.query(`UPDATE projects.change_orders SET cost_amount = 900 WHERE id = $1`, [co.id]);
    });
    await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
    const res = await owner().post(`/api/v1/projects/change-orders/${co.id}/approve`).send({});
    expect(res.body.data.warning.code).toBe('no_cost_lines');
  });
});

describe('the frozen baseline', () => {
  it('is the whole point: a change order is the only way past the freeze', async () => {
    await freeze();

    // The budget route says so, and says to use a change order.
    const blocked = await owner()
      .patch(`/api/v1/projects/projects/${projectId}/budget/${lines[0]!.id}`)
      .send({ budget_amount: 9999 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/change order/i);

    const before = await owner().get(`/api/v1/projects/projects/${projectId}/cost-position`);
    const tileBefore = (before.body.data as any[]).find((r) => r.cost_code === '1110');
    expect(tileBefore.baseline).toBe(1980);

    const co = await raise({
      lines: [{ cost_code_id: codeFor('1110'), cost_type: 'M', amount: 1500 }],
    });
    await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
    await owner().post(`/api/v1/projects/change-orders/${co.id}/approve`).send({});

    const after = await owner().get(`/api/v1/projects/projects/${projectId}/cost-position`);
    const tileAfter = (after.body.data as any[]).find((r) => r.cost_code === '1110');

    // BOTH move, by the same amount. Moving only the budget would leave the
    // line reading as an overrun against its original baseline forever; moving
    // only the baseline would hide real spend.
    expect(tileAfter.budget_amount).toBe(3480);
    expect(tileAfter.baseline).toBe(3480);
    expect(tileAfter.variance).toBe(3480);
  });

  it('a line created by a change order after the freeze carries its own baseline', async () => {
    // The trap already guarded against elsewhere: v_cost_position falls back to
    // budget_amount when baseline is null, so a line with no baseline silently
    // becomes its own and shows zero variance whatever is spent on it.
    await freeze();
    const punch = await h.db.withTenant(t.id, async (c) =>
      c.query<{ id: string }>(`SELECT id FROM projects.cost_codes WHERE code = '1410'`),
    );
    const co = await raise({
      lines: [{ cost_code_id: punch.rows[0]!.id, cost_type: 'L', amount: 800 }],
    });
    await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
    await owner().post(`/api/v1/projects/change-orders/${co.id}/approve`).send({});

    const raw = await h.db.withTenant(t.id, async (c) =>
      c.query<{ baseline_amount: string | null }>(
        `SELECT bl.baseline_amount FROM projects.budget_lines bl
           JOIN projects.cost_codes cc ON cc.id = bl.cost_code_id
          WHERE bl.project_id = $1 AND cc.code = '1410'`,
        [projectId],
      ),
    );
    expect(raw.rows[0]!.baseline_amount).not.toBeNull();
    expect(Number(raw.rows[0]!.baseline_amount)).toBe(800);
  });

  it('leaves an unfrozen baseline null rather than inventing one', async () => {
    // No freeze gate approved, so baselines are still null and
    // v_cost_position falls back to budget_amount. Adding to a null baseline
    // must not turn it into a number, or the freeze has effectively happened
    // early for that one line.
    const co = await raise({
      lines: [{ cost_code_id: codeFor('1110'), cost_type: 'M', amount: 1500 }],
    });
    await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
    await owner().post(`/api/v1/projects/change-orders/${co.id}/approve`).send({});

    const raw = await h.db.withTenant(t.id, async (c) =>
      c.query<{ baseline_amount: string | null; budget_amount: string }>(
        `SELECT bl.baseline_amount, bl.budget_amount FROM projects.budget_lines bl
           JOIN projects.cost_codes cc ON cc.id = bl.cost_code_id
          WHERE bl.project_id = $1 AND cc.code = '1110'`,
        [projectId],
      ),
    );
    expect(raw.rows[0]!.baseline_amount).toBeNull();
    expect(Number(raw.rows[0]!.budget_amount)).toBe(3480);
  });

  it('two change orders against the same code accumulate', async () => {
    await freeze();
    for (const amount of [1000, 500]) {
      const co = await raise({ lines: [{ cost_code_id: codeFor('1110'), cost_type: 'M', amount }] });
      await owner().post(`/api/v1/projects/change-orders/${co.id}/send`);
      await owner().post(`/api/v1/projects/change-orders/${co.id}/approve`).send({});
    }
    const cost = await owner().get(`/api/v1/projects/projects/${projectId}/cost-position`);
    const row = (cost.body.data as any[]).find((r) => r.cost_code === '1110');
    expect(row.baseline).toBe(3480); // 1980 + 1000 + 500
  });
});
