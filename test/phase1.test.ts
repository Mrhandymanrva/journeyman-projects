import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addBusinessUnit,
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

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
});

let n = 0;
beforeEach(async () => {
  t = await createTenant(h, { slug: `phase1-${n++}` });
});

const owner = () => h.as(t.staff.owner!.token);

async function newProject(overrides: Record<string, unknown> = {}) {
  const res = await owner()
    .post('/api/v1/projects/projects')
    .send(projectBody(overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as Record<string, any>;
}

describe('estimate imports', () => {
  it('stores a valid v1 payload and reports its shape', async () => {
    const res = await owner()
      .post('/api/v1/projects/estimate-imports')
      .send(estimatePayload());
    expect(res.status).toBe(201);
    expect(res.body.data.line_count).toBe(3);
    expect(res.body.data.sold_price).toBe(41800);
  });

  it('rejects an unknown contract version with 422, never a best-effort parse', async () => {
    const res = await owner()
      .post('/api/v1/projects/estimate-imports')
      .send(estimatePayload({ contract_version: 'estimate.v9' }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('contract_version_unsupported');
  });

  it('rejects an unrecognised cost code rather than dropping the line', async () => {
    const payload = estimatePayload();
    (payload.payload.lines as any[]).push({
      code: '9999',
      description: 'Something nobody codes',
      quantity: 1,
      unit: 'ls',
      cost_type: 'S',
      amount: 400,
    });
    const res = await owner().post('/api/v1/projects/estimate-imports').send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(JSON.stringify(res.body.error.details)).toContain('9999');
  });

  it('a revised estimate is a new import, and the same source_key twice conflicts', async () => {
    const payload = estimatePayload();
    const first = await owner().post('/api/v1/projects/estimate-imports').send(payload);
    expect(first.status).toBe(201);
    const again = await owner().post('/api/v1/projects/estimate-imports').send(payload);
    expect(again.status).toBe(409);
  });
});

describe('project creation', () => {
  it('requires an estimate import or an explicit manual source', async () => {
    const body = projectBody();
    delete (body as Record<string, unknown>).source_kind;
    const res = await owner().post('/api/v1/projects/projects').send(body);
    expect(res.status).toBe(400);
  });

  it('seeds gates from the tenant templates in the same transaction', async () => {
    const project = await newProject();
    expect(project.gates_created).toBe(5);

    const gates = await owner().get(`/api/v1/projects/projects/${project.id}/gates`);
    expect(gates.body.data).toHaveLength(5);
    expect(gates.body.data[0].title).toBe('Qualification and handoff');
    expect(gates.body.data[1].freezes_baseline).toBe(true);
  });

  it('builds budget lines from the estimate, summing lines that share a code', async () => {
    const payload = estimatePayload();
    (payload.payload.lines as any[]).push({
      code: '1120',
      description: 'Tile setting — shower pan',
      quantity: 1,
      unit: 'ls',
      cost_type: 'S',
      amount: 800,
    });
    const imported = await owner().post('/api/v1/projects/estimate-imports').send(payload);
    const project = await newProject({
      estimate_import_id: imported.body.data.id,
      source_kind: 'journeyman_estimate',
    });

    // Four estimate lines, three cost codes.
    expect(project.budget_lines_created).toBe(3);
    const cost = await owner().get(`/api/v1/projects/projects/${project.id}/cost-position`);
    const tile = (cost.body.data as any[]).find((r) => r.cost_code === '1120');
    expect(tile.budget_amount).toBe(6000);
  });

  it('a duplicate project number in the same tenant is a 409, not a 500', async () => {
    await newProject({ project_number: 'DUP-1' });
    const res = await owner()
      .post('/api/v1/projects/projects')
      .send(projectBody({ project_number: 'DUP-1' }));
    expect(res.status).toBe(409);
  });

  it('a role without create_project is refused', async () => {
    const res = await h
      .as(t.staff.bookkeeper!.token)
      .post('/api/v1/projects/projects')
      .send(projectBody());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });
});

describe('gates', () => {
  it('approval is refused when checklist items are outstanding', async () => {
    await h.db.withTenant(t.id, async (c) => {
      await c.query(
        `UPDATE projects.gate_templates
            SET checklist = '[{"key":"signed","label":"Contract signed"}]'::jsonb
          WHERE tenant_id = $1 AND gate_number = 0`,
        [t.id],
      );
    });
    const project = await newProject();

    const refused = await owner().post(
      `/api/v1/projects/projects/${project.id}/gates/0/approve`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('gate_not_satisfied');

    const ticked = await owner()
      .patch(`/api/v1/projects/projects/${project.id}/gates/0/checklist`)
      .send({ key: 'signed', done: true });
    expect(ticked.status).toBe(200);
    expect(ticked.body.data.checklist[0].done).toBe(true);
    expect(ticked.body.data.checklist[0].done_by).toBe(t.staff.owner!.id);

    const approved = await owner().post(
      `/api/v1/projects/projects/${project.id}/gates/0/approve`,
    );
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('approved');
  });

  it('the approver comes from the template, not from a hardcoded role', async () => {
    const project = await newProject();
    // Gate 2 (Mobilization) ships assigned to project_manager.
    const byManager = await h
      .as(t.staff.manager!.token)
      .post(`/api/v1/projects/projects/${project.id}/gates/2/approve`);
    expect(byManager.status).toBe(403);
    expect(byManager.body.error.details.approver_role).toBe('project_manager');

    await tickGate(h.as(t.staff.pm!.token), project.id, 2);
    const byPm = await h
      .as(t.staff.pm!.token)
      .post(`/api/v1/projects/projects/${project.id}/gates/2/approve`);
    expect(byPm.status).toBe(200);
  });

  it('rejection requires a note', async () => {
    const project = await newProject();
    const empty = await owner()
      .post(`/api/v1/projects/projects/${project.id}/gates/0/reject`)
      .send({ note: '   ' });
    expect(empty.status).toBe(400);

    const ok = await owner()
      .post(`/api/v1/projects/projects/${project.id}/gates/0/reject`)
      .send({ note: 'Scope of work not signed' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('rejected');
  });

  it('approving the freeze gate copies budget to baseline — via the trigger', async () => {
    const imported = await owner()
      .post('/api/v1/projects/estimate-imports')
      .send(estimatePayload());
    const project = await newProject({
      estimate_import_id: imported.body.data.id,
      source_kind: 'journeyman_estimate',
    });

    const before = await owner().get(`/api/v1/projects/projects/${project.id}/cost-position`);
    // No baseline yet, so v_cost_position falls back to budget_amount.
    expect((before.body.data as any[]).every((r) => r.baseline === r.budget_amount)).toBe(true);

    await owner().post(`/api/v1/projects/projects/${project.id}/gates/0/approve`);
    await tickGate(owner(), project.id, 1);
    const gate1 = await owner().post(`/api/v1/projects/projects/${project.id}/gates/1/approve`);
    expect(gate1.status).toBe(200);
    expect(gate1.body.data.freezes_baseline).toBe(true);
    expect(gate1.body.data.baseline_lines).toBe(3);

    const frozen = await h.db.withTenant(t.id, async (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.budget_lines
          WHERE project_id = $1 AND baseline_amount IS NOT NULL`,
        [project.id],
      ),
    );
    expect(Number(frozen.rows[0]!.n)).toBe(3);
  });

  it('a rejected gate does not un-freeze an already frozen baseline', async () => {
    const imported = await owner()
      .post('/api/v1/projects/estimate-imports')
      .send(estimatePayload());
    const project = await newProject({
      estimate_import_id: imported.body.data.id,
      source_kind: 'journeyman_estimate',
    });
    await owner().post(`/api/v1/projects/projects/${project.id}/gates/0/approve`);
    await tickGate(owner(), project.id, 1);
    await owner().post(`/api/v1/projects/projects/${project.id}/gates/1/approve`);
    await owner()
      .post(`/api/v1/projects/projects/${project.id}/gates/1/reject`)
      .send({ note: 'Reopened for a scope change' });

    const still = await h.db.withTenant(t.id, async (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.budget_lines
          WHERE project_id = $1 AND baseline_amount IS NOT NULL`,
        [project.id],
      ),
    );
    expect(Number(still.rows[0]!.n)).toBe(3);
  });
});

describe('stage advance', () => {
  it('is blocked while the gate for the current stage is open', async () => {
    const project = await newProject();
    const blocked = await owner()
      .post(`/api/v1/projects/projects/${project.id}/stage`)
      .send({ stage: 'precon' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('gate_not_satisfied');
    expect(blocked.body.error.details.gates[0].gate_number).toBe(0);

    await owner().post(`/api/v1/projects/projects/${project.id}/gates/0/approve`);
    const ok = await owner()
      .post(`/api/v1/projects/projects/${project.id}/stage`)
      .send({ stage: 'precon' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.stage).toBe('precon');
    expect(ok.body.data.next_stage).toBe('mobilization');
  });

  it('cannot skip a stage or go backwards', async () => {
    const project = await newProject();
    await owner().post(`/api/v1/projects/projects/${project.id}/gates/0/approve`);

    const skip = await owner()
      .post(`/api/v1/projects/projects/${project.id}/stage`)
      .send({ stage: 'execution' });
    expect(skip.status).toBe(409);

    await owner().post(`/api/v1/projects/projects/${project.id}/stage`).send({ stage: 'precon' });
    const back = await owner()
      .post(`/api/v1/projects/projects/${project.id}/stage`)
      .send({ stage: 'handoff' });
    expect(back.status).toBe(409);
  });

  it('cancelling is reachable from any stage and is terminal', async () => {
    const project = await newProject();
    const cancel = await owner()
      .post(`/api/v1/projects/projects/${project.id}/stage`)
      .send({ stage: 'cancelled' });
    expect(cancel.status).toBe(200);

    const after = await owner()
      .post(`/api/v1/projects/projects/${project.id}/stage`)
      .send({ stage: 'precon' });
    expect(after.status).toBe(409);
  });
});

describe('target margin', () => {
  it('is immutable once gate 0 is approved', async () => {
    const project = await newProject();
    const early = await owner()
      .patch(`/api/v1/projects/projects/${project.id}`)
      .send({ target_margin: 0.42 });
    expect(early.status).toBe(200);
    expect(early.body.data.target_margin).toBe(0.42);

    await owner().post(`/api/v1/projects/projects/${project.id}/gates/0/approve`);
    const late = await owner()
      .patch(`/api/v1/projects/projects/${project.id}`)
      .send({ target_margin: 0.5 });
    expect(late.status).toBe(409);

    // Re-sending the same value is not a change and must not be blocked.
    const same = await owner()
      .patch(`/api/v1/projects/projects/${project.id}`)
      .send({ target_margin: 0.42, name: 'Whitfield — Primary Bath (rev B)' });
    expect(same.status).toBe(200);
  });
});

describe('business unit scoping', () => {
  it('is off by default and a scoped user sees only their unit when on', async () => {
    const scoped = await createTenant(h, {
      slug: 'scoped-tenant',
      unitName: 'Richmond',
      enforceBusinessUnitScoping: true,
      staff: [
        { key: 'owner', email: 'o@s.test', role: 'owner' },
        { key: 'rvaManager', email: 'rva@s.test', role: 'manager', unit: 'Richmond' },
      ],
    });
    const hampton = await addBusinessUnit(h, scoped, 'Hampton-Newport News');

    const inRichmond = await h
      .as(scoped.staff.owner!.token)
      .post('/api/v1/projects/projects')
      .send(
        projectBody({
          project_number: 'RVA-1',
          business_unit_id: scoped.businessUnits.Richmond,
        }),
      );
    expect(inRichmond.status).toBe(201);

    const inHampton = await h
      .as(scoped.staff.owner!.token)
      .post('/api/v1/projects/projects')
      .send(projectBody({ project_number: 'HNN-1', business_unit_id: hampton }));
    expect(inHampton.status).toBe(201);

    // Owner has no unit, so sees both.
    const ownerList = await h
      .as(scoped.staff.owner!.token)
      .get('/api/v1/projects/projects?per_page=200');
    expect((ownerList.body.data as any[]).map((p) => p.project_number).sort()).toEqual([
      'HNN-1',
      'RVA-1',
    ]);

    const scopedList = await h
      .as(scoped.staff.rvaManager!.token)
      .get('/api/v1/projects/projects?per_page=200');
    expect((scopedList.body.data as any[]).map((p) => p.project_number)).toEqual(['RVA-1']);

    // And cannot read the other unit's project directly.
    const direct = await h
      .as(scoped.staff.rvaManager!.token)
      .get(`/api/v1/projects/projects/${inHampton.body.data.id}`);
    expect(direct.status).toBe(404);

    // Nor move their own project into a unit they cannot see (§2.2, on write).
    const move = await h
      .as(scoped.staff.rvaManager!.token)
      .patch(`/api/v1/projects/projects/${inRichmond.body.data.id}`)
      .send({ business_unit_id: hampton });
    expect(move.status).toBe(403);
  });

  it('requires a business unit at creation once scoping is on', async () => {
    const scoped = await createTenant(h, {
      slug: 'scoped-required',
      enforceBusinessUnitScoping: true,
      staff: [{ key: 'owner', email: 'o@r.test', role: 'owner' }],
    });
    const res = await h
      .as(scoped.staff.owner!.token)
      .post('/api/v1/projects/projects')
      .send(projectBody({ project_number: 'NO-UNIT' }));
    expect(res.status).toBe(400);
  });
});

describe('margin', () => {
  it('says so plainly when there is no budget yet', async () => {
    const project = await newProject();
    const res = await owner().get(`/api/v1/projects/projects/${project.id}/margin`);
    expect(res.status).toBe(200);
    expect(res.body.data.has_budget).toBe(false);
  });

  it('projects margin against the revised contract', async () => {
    const imported = await owner()
      .post('/api/v1/projects/estimate-imports')
      .send(estimatePayload());
    const project = await newProject({
      estimate_import_id: imported.body.data.id,
      source_kind: 'journeyman_estimate',
      contract_value: 41800,
    });
    const res = await owner().get(`/api/v1/projects/projects/${project.id}/margin`);
    expect(res.body.data.has_budget).toBe(true);
    expect(res.body.data.revised_contract).toBe(41800);
    expect(res.body.data.projected_cost).toBe(10380);
    expect(res.body.data.projected_margin).toBeCloseTo((41800 - 10380) / 41800, 4);
  });

  it('is refused for a role that cannot view margin', async () => {
    const project = await newProject();
    const res = await h
      .as(t.staff.office!.token)
      .get(`/api/v1/projects/projects/${project.id}/margin`);
    expect(res.status).toBe(403);
  });
});

describe('authentication', () => {
  it('no token is 401', async () => {
    const res = await h.request.get('/api/v1/projects/projects');
    expect(res.status).toBe(401);
  });

  it('an unknown token is 401', async () => {
    const res = await h.as('not-a-real-token').get('/api/v1/projects/projects');
    expect(res.status).toBe(401);
  });
});
