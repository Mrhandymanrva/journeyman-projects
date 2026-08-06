import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  createTenant,
  estimatePayload,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from './support/harness.js';

/**
 * MANDATORY TEST 1 — cross-tenant isolation. Handoff README §2.
 *
 * Log in as tenant A. Request every route with tenant B's identifiers
 * substituted into every path parameter and body field. Every one must return
 * 404 — not 403, which would confirm the row exists.
 *
 * This file is written to be the thing that fails when a route is added
 * without thinking about tenancy: ROUTES below is the list of every staff
 * route the module serves, and there is a test at the bottom asserting the
 * list is complete against the Express router. Adding a route without adding
 * it here breaks the build.
 */

let h: Harness;
let A: TenantFixture;
let B: TenantFixture;

/** Identifiers that belong to tenant B, to be substituted into A's requests. */
interface ForeignIds {
  projectId: string;
  estimateImportId: string;
  staffId: string;
  businessUnitId: string;
  budgetLineId: string;
  costCodeId: string;
  vendorId: string;
  documentId: string;
  poId: string;
  billId: string;
  drawId: string;
  jurisdictionId: string;
  permitId: string;
  milestoneId: string;
  scheduleItemId: string;
  changeOrderId: string;
}
let foreign: ForeignIds;

beforeAll(async () => {
  h = await startHarness();
  A = await createTenant(h, { slug: 'tenant-a', displayName: 'Tenant A' });
  B = await createTenant(h, { slug: 'tenant-b', displayName: 'Tenant B' });

  // Build a fully populated project inside tenant B, using B's own session.
  const importRes = await h
    .as(B.staff.owner!.token)
    .post('/api/v1/projects/estimate-imports')
    .send(estimatePayload());
  expect(importRes.status).toBe(201);

  const projectRes = await h
    .as(B.staff.owner!.token)
    .post('/api/v1/projects/projects')
    .send(
      projectBody({
        project_number: 'TENANT-B-0001',
        estimate_import_id: importRes.body.data.id,
        source_kind: 'journeyman_estimate',
        pm_id: B.staff.pm!.id,
      }),
    );
  expect(projectRes.status).toBe(201);

  const projectId = projectRes.body.data.id as string;
  const b = h.as(B.staff.owner!.token);

  // A vendor with every required document, so it can hold a purchase order.
  const vendorRes = await b
    .post('/api/v1/projects/vendors')
    .send({ legal_name: 'Tenant B Tile Co', email: 'tile@tenant-b.test', trades: ['tile'] });
  expect(vendorRes.status).toBe(201);
  const vendorId = vendorRes.body.data.id as string;

  const kinds = await b.get('/api/v1/projects/compliance-requirements');
  let documentId = '';
  for (const req of kinds.body.data as Array<{ kind: string; required: boolean }>) {
    if (!req.required) continue;
    const doc = await b
      .post(`/api/v1/projects/vendors/${vendorId}/documents`)
      .send({ kind: req.kind, expires_on: '2027-12-31', file_key: `k/${req.kind}` });
    expect(doc.status).toBe(201);
    documentId ||= doc.body.data.id;
  }
  expect((await b.post(`/api/v1/projects/vendors/${vendorId}/activate`)).status).toBe(200);

  const budget = await b.get(`/api/v1/projects/projects/${projectId}/budget`);
  const budgetLineId = budget.body.data.lines[0].id as string;
  const costCodeId = budget.body.data.lines[0].cost_code_id as string;

  const poRes = await b.post(`/api/v1/projects/projects/${projectId}/purchase-orders`).send({
    po_number: 'B-PO-0001',
    vendor_id: vendorId,
    cost_code_id: costCodeId,
    cost_type: 'S',
    amount: 5200,
    scope_text: 'Set tile to primary bath',
    issue: true,
  });
  expect(poRes.status, JSON.stringify(poRes.body)).toBe(201);

  const billRes = await b
    .post(`/api/v1/projects/purchase-orders/${poRes.body.data.id}/bills`)
    .send({ vendor_invoice_number: 'B-INV-1', amount: 5200 });
  expect(billRes.status).toBe(201);

  // A draw, a permit with milestones, and a scheduled window — all inside
  // tenant B, so tenant A has something real to try to reach.
  const drawRes = await b.post(`/api/v1/projects/projects/${projectId}/draws`).send({
    draws: [
      { label: 'Deposit', trigger_milestone: 'Contract signature', amount: 10450 },
      { label: 'Final', trigger_milestone: 'Punch complete', amount: 8360 },
    ],
  });
  expect(drawRes.status, JSON.stringify(drawRes.body)).toBe(201);

  const jurisdictionRes = await b
    .post('/api/v1/projects/jurisdictions')
    .send({ name: 'Tenant B County', typical_review_days: 10 });
  expect(jurisdictionRes.status).toBe(201);

  const permitRes = await b.post(`/api/v1/projects/projects/${projectId}/permits`).send({
    jurisdiction_id: jurisdictionRes.body.data.id,
    permit_type: 'Building',
    applied_on: '2026-07-01',
  });
  expect(permitRes.status, JSON.stringify(permitRes.body)).toBe(201);

  const permits = await b.get(`/api/v1/projects/projects/${projectId}/permits`);
  const milestoneId = permits.body.data[0].milestones[0].id as string;

  const scheduleRes = await b.post(`/api/v1/projects/projects/${projectId}/schedule`).send({
    title: 'Tile setting',
    window_start: '2026-08-10',
    window_end: '2026-08-12',
  });
  expect(scheduleRes.status).toBe(201);

  const coRes = await b.post(`/api/v1/projects/projects/${projectId}/change-orders`).send({
    description: "Tenant B's change order",
    customer_amount: 2400,
    lines: [{ cost_code_id: costCodeId, cost_type: 'S', amount: 1500 }],
  });
  expect(coRes.status, JSON.stringify(coRes.body)).toBe(201);

  foreign = {
    projectId,
    changeOrderId: coRes.body.data.id,
    estimateImportId: importRes.body.data.id,
    drawId: drawRes.body.data[0].id,
    jurisdictionId: jurisdictionRes.body.data.id,
    permitId: permitRes.body.data.id,
    milestoneId,
    scheduleItemId: scheduleRes.body.data.id,
    staffId: B.staff.pm!.id,
    businessUnitId: Object.values(B.businessUnits)[0]!,
    budgetLineId,
    costCodeId,
    vendorId,
    documentId,
    poId: poRes.body.data.id,
    billId: billRes.body.data.id,
  };
});

afterAll(async () => {
  await h?.close();
});

type Method = 'get' | 'post' | 'patch';

interface RouteCase {
  method: Method;
  /** The Express route template, matched against the live router below. */
  template: string;
  /** The same path with tenant B's identifiers substituted. */
  path: (f: ForeignIds) => string;
  body?: (f: ForeignIds) => unknown;
}

const BASE = '/api/v1/projects';

const ROUTES: RouteCase[] = [
  {
    method: 'get',
    template: `${BASE}/projects/:id`,
    path: (f) => `${BASE}/projects/${f.projectId}`,
  },
  {
    method: 'get',
    template: `${BASE}/projects/:id/cost-position`,
    path: (f) => `${BASE}/projects/${f.projectId}/cost-position`,
  },
  {
    method: 'get',
    template: `${BASE}/projects/:id/margin`,
    path: (f) => `${BASE}/projects/${f.projectId}/margin`,
  },
  {
    method: 'get',
    template: `${BASE}/projects/:id/gates`,
    path: (f) => `${BASE}/projects/${f.projectId}/gates`,
  },
  {
    method: 'get',
    template: `${BASE}/estimate-imports/:id`,
    path: (f) => `${BASE}/estimate-imports/${f.estimateImportId}`,
  },
  {
    method: 'patch',
    template: `${BASE}/projects/:id`,
    path: (f) => `${BASE}/projects/${f.projectId}`,
    body: () => ({ name: 'Renamed by another tenant' }),
  },
  {
    method: 'post',
    template: `${BASE}/projects/:id/stage`,
    path: (f) => `${BASE}/projects/${f.projectId}/stage`,
    body: () => ({ stage: 'precon' }),
  },
  {
    method: 'patch',
    template: `${BASE}/projects/:id/gates/:n/checklist`,
    path: (f) => `${BASE}/projects/${f.projectId}/gates/0/checklist`,
    body: () => ({ key: 'item_1', done: true }),
  },
  {
    method: 'post',
    template: `${BASE}/projects/:id/gates/:n/approve`,
    path: (f) => `${BASE}/projects/${f.projectId}/gates/0/approve`,
    body: () => ({}),
  },
  {
    method: 'post',
    template: `${BASE}/projects/:id/gates/:n/reject`,
    path: (f) => `${BASE}/projects/${f.projectId}/gates/0/reject`,
    body: () => ({ note: 'no' }),
  },

  // --- phase 2: budget ----------------------------------------------------
  {
    method: 'get',
    template: `${BASE}/projects/:id/budget`,
    path: (f) => `${BASE}/projects/${f.projectId}/budget`,
  },
  {
    method: 'post',
    template: `${BASE}/projects/:id/budget`,
    path: (f) => `${BASE}/projects/${f.projectId}/budget`,
    body: (f) => ({ cost_code_id: f.costCodeId, cost_type: 'S', budget_amount: 100 }),
  },
  {
    method: 'patch',
    template: `${BASE}/projects/:id/budget/:lineId`,
    path: (f) => `${BASE}/projects/${f.projectId}/budget/${f.budgetLineId}`,
    body: () => ({ budget_amount: 1 }),
  },
  {
    method: 'get',
    template: `${BASE}/projects/:id/exceptions`,
    path: (f) => `${BASE}/projects/${f.projectId}/exceptions`,
  },
  {
    method: 'get',
    template: `${BASE}/projects/:id/export/cost`,
    path: (f) => `${BASE}/projects/${f.projectId}/export/cost`,
  },

  // --- phase 2: purchase orders and bills ---------------------------------
  {
    method: 'get',
    template: `${BASE}/projects/:id/purchase-orders`,
    path: (f) => `${BASE}/projects/${f.projectId}/purchase-orders`,
  },
  {
    method: 'post',
    template: `${BASE}/projects/:id/purchase-orders`,
    path: (f) => `${BASE}/projects/${f.projectId}/purchase-orders`,
    body: (f) => ({
      po_number: 'A-STEALS-PO',
      supplier_name: 'Counter purchase',
      cost_code_id: f.costCodeId,
      cost_type: 'M',
      amount: 10,
      scope_text: 'x',
    }),
  },
  {
    method: 'patch',
    template: `${BASE}/purchase-orders/:id`,
    path: (f) => `${BASE}/purchase-orders/${f.poId}`,
    body: () => ({ amount: 1 }),
  },
  {
    method: 'get',
    template: `${BASE}/purchase-orders/:id/bills`,
    path: (f) => `${BASE}/purchase-orders/${f.poId}/bills`,
  },
  {
    method: 'post',
    template: `${BASE}/purchase-orders/:id/bills`,
    path: (f) => `${BASE}/purchase-orders/${f.poId}/bills`,
    body: () => ({ vendor_invoice_number: 'A-STEALS-INV', amount: 1 }),
  },
  {
    method: 'post',
    template: `${BASE}/bills/:id/approve`,
    path: (f) => `${BASE}/bills/${f.billId}/approve`,
    body: () => ({}),
  },
  {
    method: 'post',
    template: `${BASE}/bills/:id/reject`,
    path: (f) => `${BASE}/bills/${f.billId}/reject`,
    body: () => ({}),
  },

  // --- phase 3: vendors and compliance ------------------------------------
  {
    method: 'get',
    template: `${BASE}/vendors/:id`,
    path: (f) => `${BASE}/vendors/${f.vendorId}`,
  },
  {
    method: 'patch',
    template: `${BASE}/vendors/:id`,
    path: (f) => `${BASE}/vendors/${f.vendorId}`,
    body: () => ({ legal_name: 'Renamed by another tenant' }),
  },
  {
    method: 'post',
    template: `${BASE}/vendors/:id/documents`,
    path: (f) => `${BASE}/vendors/${f.vendorId}/documents`,
    body: () => ({ kind: 'license', expires_on: '2028-01-01', file_key: 'k/x' }),
  },
  {
    method: 'patch',
    template: `${BASE}/vendors/:id/documents/:docId`,
    path: (f) => `${BASE}/vendors/${f.vendorId}/documents/${f.documentId}`,
    body: () => ({ verify_method: 'called the carrier' }),
  },
  {
    method: 'post',
    template: `${BASE}/vendors/:id/activate`,
    path: (f) => `${BASE}/vendors/${f.vendorId}/activate`,
    body: () => ({}),
  },
  {
    method: 'post',
    template: `${BASE}/vendors/:id/deactivate`,
    path: (f) => `${BASE}/vendors/${f.vendorId}/deactivate`,
    body: () => ({}),
  },
  {
    method: 'post',
    template: `${BASE}/vendors/:id/scores`,
    path: (f) => `${BASE}/vendors/${f.vendorId}/scores`,
    body: (f) => ({ project_id: f.projectId, quality_score: 1 }),
  },

  // --- phase 5: change orders ---------------------------------------------
  {
    method: 'get',
    template: `${BASE}/projects/:id/change-orders`,
    path: (f) => `${BASE}/projects/${f.projectId}/change-orders`,
  },
  {
    method: 'post',
    template: `${BASE}/projects/:id/change-orders`,
    path: (f) => `${BASE}/projects/${f.projectId}/change-orders`,
    body: () => ({ description: 'Raised into another tenant', customer_amount: 100 }),
  },
  {
    method: 'patch',
    template: `${BASE}/change-orders/:id`,
    path: (f) => `${BASE}/change-orders/${f.changeOrderId}`,
    body: () => ({ customer_amount: 1 }),
  },
  {
    method: 'post',
    template: `${BASE}/change-orders/:id/send`,
    path: (f) => `${BASE}/change-orders/${f.changeOrderId}/send`,
    body: () => ({}),
  },
  {
    method: 'post',
    template: `${BASE}/change-orders/:id/approve`,
    path: (f) => `${BASE}/change-orders/${f.changeOrderId}/approve`,
    body: () => ({}),
  },
  {
    method: 'post',
    template: `${BASE}/change-orders/:id/reject`,
    path: (f) => `${BASE}/change-orders/${f.changeOrderId}/reject`,
    body: () => ({}),
  },

  // --- phase 4: draws -----------------------------------------------------
  {
    method: 'get',
    template: `${BASE}/projects/:id/draws`,
    path: (f) => `${BASE}/projects/${f.projectId}/draws`,
  },
  {
    method: 'post',
    template: `${BASE}/projects/:id/draws`,
    path: (f) => `${BASE}/projects/${f.projectId}/draws`,
    body: () => ({ draws: [{ label: 'Deposit', trigger_milestone: 'Signature', amount: 100 }] }),
  },
  {
    method: 'post',
    template: `${BASE}/draws/:id/earn`,
    path: (f) => `${BASE}/draws/${f.drawId}/earn`,
    body: () => ({}),
  },
  {
    method: 'post',
    template: `${BASE}/draws/:id/approve`,
    path: (f) => `${BASE}/draws/${f.drawId}/approve`,
    body: () => ({}),
  },
  {
    method: 'post',
    template: `${BASE}/draws/:id/external-invoice`,
    path: (f) => `${BASE}/draws/${f.drawId}/external-invoice`,
    body: () => ({ external_invoice_number: 'A-STEALS-INVOICE' }),
  },
  {
    method: 'post',
    template: `${BASE}/draws/:id/verify`,
    path: (f) => `${BASE}/draws/${f.drawId}/verify`,
    body: () => ({}),
  },

  // --- phase 5: permits, schedule, daily logs -----------------------------
  {
    method: 'get',
    template: `${BASE}/projects/:id/permits`,
    path: (f) => `${BASE}/projects/${f.projectId}/permits`,
  },
  {
    method: 'post',
    template: `${BASE}/projects/:id/permits`,
    path: (f) => `${BASE}/projects/${f.projectId}/permits`,
    body: (f) => ({ jurisdiction_id: f.jurisdictionId, permit_type: 'Building' }),
  },
  {
    method: 'patch',
    template: `${BASE}/permits/:id`,
    path: (f) => `${BASE}/permits/${f.permitId}`,
    body: () => ({ permit_number: 'STOLEN-1' }),
  },
  {
    method: 'patch',
    template: `${BASE}/permit-milestones/:id`,
    path: (f) => `${BASE}/permit-milestones/${f.milestoneId}`,
    body: () => ({ status: 'complete' }),
  },
  {
    method: 'get',
    template: `${BASE}/projects/:id/schedule`,
    path: (f) => `${BASE}/projects/${f.projectId}/schedule`,
  },
  {
    method: 'post',
    template: `${BASE}/projects/:id/schedule`,
    path: (f) => `${BASE}/projects/${f.projectId}/schedule`,
    body: () => ({ title: 'Stolen slot', window_start: '2026-09-01', window_end: '2026-09-02' }),
  },
  {
    method: 'patch',
    template: `${BASE}/schedule/:id`,
    path: (f) => `${BASE}/schedule/${f.scheduleItemId}`,
    body: () => ({ status: 'cancelled' }),
  },
  {
    method: 'get',
    template: `${BASE}/projects/:id/daily-logs`,
    path: (f) => `${BASE}/projects/${f.projectId}/daily-logs`,
  },
  {
    method: 'post',
    template: `${BASE}/projects/:id/daily-logs`,
    path: (f) => `${BASE}/projects/${f.projectId}/daily-logs`,
    body: () => ({ log_date: '2026-09-01', work_completed: 'Written into another tenant' }),
  },
];

/**
 * Routes whose path parameter is not an identifier, so "substitute another
 * tenant's value" has no meaning. Each needs its own test instead, and naming
 * one here is a claim that the test exists.
 *
 * The exemption list is deliberately awkward to add to. A route that reaches
 * for it and is actually identifier-shaped will read wrong in review.
 */
const NOT_AN_IDENTIFIER: Array<{ signature: string; why: string; coveredBy: string }> = [
  {
    signature: `PATCH ${BASE}/compliance-requirements/:kind`,
    why: ':kind is a doc_kind enum value, shared vocabulary across all tenants',
    coveredBy: 'compliance requirements are per tenant',
  },
];

describe('cross-tenant isolation', () => {
  it.each(ROUTES.map((r) => [`${r.method.toUpperCase()} ${r.template}`, r] as const))(
    '%s with another tenant\'s ids returns 404',
    async (_label, route) => {
      const req = h.as(A.staff.owner!.token);
      const path = route.path(foreign);
      const res =
        route.method === 'get'
          ? await req.get(path)
          : route.method === 'post'
            ? await req.post(path).send(route.body?.(foreign) ?? {})
            : await req.patch(path).send(route.body?.(foreign) ?? {});

      expect(
        res.status,
        `${route.method.toUpperCase()} ${path} returned ${res.status}: ` +
          JSON.stringify(res.body),
      ).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    },
  );

  it('a foreign id in a body field is rejected, not silently accepted', async () => {
    // The project would be created in tenant A but point at tenant B's import.
    // RLS makes the SELECT for that import return nothing, so this must be a
    // 404 on the import — never a project created with a dangling reference.
    const res = await h
      .as(A.staff.owner!.token)
      .post('/api/v1/projects/projects')
      .send(
        projectBody({
          project_number: 'A-STEALS-B',
          estimate_import_id: foreign.estimateImportId,
          source_kind: 'journeyman_estimate',
        }),
      );
    expect(res.status).toBe(404);

    const check = await h.db.withTenant(A.id, async (c) =>
      c.query(`SELECT 1 FROM projects.projects WHERE project_number = 'A-STEALS-B'`),
    );
    expect(check.rows).toHaveLength(0);
  });

  it("a foreign staff id as pm_id is a validation error, not an assignment", async () => {
    const res = await h
      .as(A.staff.owner!.token)
      .post('/api/v1/projects/projects')
      .send(projectBody({ project_number: 'A-FOREIGN-PM', pm_id: foreign.staffId }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it("a foreign business unit id cannot be attached to this tenant's project", async () => {
    // No FK crosses tenants, so the database would accept this. The API must
    // not: a project pointing at another tenant's unit is a cross-tenant read
    // waiting for someone to join through it.
    const res = await h
      .as(A.staff.owner!.token)
      .post('/api/v1/projects/projects')
      .send(
        projectBody({
          project_number: 'A-FOREIGN-UNIT',
          business_unit_id: foreign.businessUnitId,
        }),
      );
    expect([400, 403, 404]).toContain(res.status);
    expect(res.status).not.toBe(201);
  });

  it("tenant A's list never contains tenant B's project", async () => {
    const res = await h.as(A.staff.owner!.token).get('/api/v1/projects/projects?per_page=200');
    expect(res.status).toBe(200);
    const numbers = (res.body.data as Array<{ project_number: string }>).map(
      (p) => p.project_number,
    );
    expect(numbers).not.toContain('TENANT-B-0001');
  });

  it('the reference collections never leak across tenants', async () => {
    // These have no :id, so the parameterised-route coverage rule above does
    // not see them. They are still tenant-scoped reads and RLS is the only
    // thing filtering them — which is the point, but it has to be asserted.
    const a = h.as(A.staff.owner!.token);
    const b = h.as(B.staff.owner!.token);

    for (const path of ['/cost-codes', '/business-units', '/staff']) {
      const mine = await a.get(`/api/v1/projects${path}`);
      const theirs = await b.get(`/api/v1/projects${path}`);
      expect(mine.status, path).toBe(200);
      expect(theirs.status, path).toBe(200);

      const mineIds = new Set((mine.body.data as Array<{ id: string }>).map((r) => r.id));
      const overlap = (theirs.body.data as Array<{ id: string }>).filter((r) =>
        mineIds.has(r.id),
      );
      expect(overlap, `${path} returned rows belonging to both tenants`).toEqual([]);
      expect(mineIds.size, `${path} returned nothing, so this proves nothing`).toBeGreaterThan(0);
    }
  });

  it('a session for a staff member of another tenant does not resolve', async () => {
    // The token names tenant A but a staff row belonging to B. The tenant
    // transaction opens on A, RLS hides B's staff row, and the session fails
    // to resolve to an identity — 401, not a silently downgraded request.
    const token = h.sessions.issue({ tenantId: A.id, staffId: B.staff.owner!.id });
    const res = await h.as(token).get('/api/v1/projects/projects');
    expect(res.status).toBe(401);
  });

  it('no route answers 403 for a foreign row', async () => {
    // Stated separately from the per-route assertions because it is the rule,
    // and the rule is the thing that must not regress: 403 on another tenant's
    // identifier confirms the identifier is real.
    const req = h.as(A.staff.owner!.token);
    for (const route of ROUTES) {
      const path = route.path(foreign);
      const res =
        route.method === 'get'
          ? await req.get(path)
          : route.method === 'post'
            ? await req.post(path).send(route.body?.(foreign) ?? {})
            : await req.patch(path).send(route.body?.(foreign) ?? {});
      expect(res.status, `${route.method.toUpperCase()} ${path}`).not.toBe(403);
    }
  });
});

describe('route coverage', () => {
  it('every staff route with an :id parameter is covered above', () => {
    const declared = collectRoutes(h.app);
    const parameterised = declared.filter((r) => r.path.includes(':'));
    const covered = new Set([
      ...ROUTES.map((r) => `${r.method.toUpperCase()} ${r.template}`),
      ...NOT_AN_IDENTIFIER.map((e) => e.signature),
    ]);
    const missing = parameterised
      .map((r) => `${r.method} ${r.path}`)
      .filter((sig) => !covered.has(sig));
    expect(
      missing,
      'These routes take an identifier but are not exercised with a foreign one. ' +
        'Add them to ROUTES in this file.',
    ).toEqual([]);
  });

  it('a tenant cannot change another tenant\'s compliance requirements', async () => {
    // The exemption above claims this is covered. This is the coverage.
    const before = await h.as(B.staff.owner!.token).get('/api/v1/projects/compliance-requirements');
    const glBefore = (before.body.data as Array<{ kind: string; warn_days: number }>).find(
      (r) => r.kind === 'gl_insurance',
    );
    expect(glBefore!.warn_days).toBe(30);

    const patched = await h
      .as(A.staff.owner!.token)
      .patch('/api/v1/projects/compliance-requirements/gl_insurance')
      .send({ warn_days: 120 });
    expect(patched.status).toBe(200);

    const after = await h.as(B.staff.owner!.token).get('/api/v1/projects/compliance-requirements');
    const glAfter = (after.body.data as Array<{ kind: string; warn_days: number }>).find(
      (r) => r.kind === 'gl_insurance',
    );
    expect(glAfter!.warn_days).toBe(30);
  });

  it('every ROUTES entry names a route that actually exists', () => {
    // The other direction. A template that matches nothing is a test that
    // passes because it is testing a 404 handler.
    const declared = new Set(collectRoutes(h.app).map((r) => `${r.method} ${r.path}`));
    const stale = ROUTES.map((r) => `${r.method.toUpperCase()} ${r.template}`).filter(
      (sig) => !declared.has(sig),
    );
    expect(stale, 'These ROUTES entries no longer match a mounted route.').toEqual([]);
  });
});

// ---------------------------------------------------------------------------

interface DeclaredRoute {
  method: string;
  path: string;
}

/** Walks the Express router tree so the coverage check reads the app, not a list. */
function collectRoutes(app: unknown): DeclaredRoute[] {
  const out: DeclaredRoute[] = [];
  const walk = (stack: unknown[], prefix: string) => {
    for (const layer of stack as Array<Record<string, any>>) {
      if (layer.route) {
        const path = prefix + layer.route.path;
        for (const [method, on] of Object.entries(layer.route.methods as Record<string, boolean>)) {
          if (on && method !== '_all') out.push({ method: method.toUpperCase(), path });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + extractMountPath(layer));
      }
    }
  };
  walk(((app as Record<string, any>)._router ?? (app as Record<string, any>).router).stack, '');
  return out;
}

function extractMountPath(layer: Record<string, any>): string {
  // Express does not expose the mount path directly; it is recoverable from
  // the layer's regexp for the simple string mounts this app uses.
  const source: string = layer.regexp?.source ?? '';
  if (source === '^\\/?(?=\\/|$)') return '';
  const match = /^\^\\\/((?:[\w\-]|\\\/)*)\\\/\?/.exec(source);
  if (!match) return '';
  return '/' + match[1]!.replace(/\\\//g, '/');
}
