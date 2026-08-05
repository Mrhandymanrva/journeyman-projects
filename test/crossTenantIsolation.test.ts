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

  foreign = {
    projectId: projectRes.body.data.id,
    estimateImportId: importRes.body.data.id,
    staffId: B.staff.pm!.id,
    businessUnitId: Object.values(B.businessUnits)[0]!,
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
    const covered = new Set(ROUTES.map((r) => `${r.method.toUpperCase()} ${r.template}`));
    const missing = parameterised
      .map((r) => `${r.method} ${r.path}`)
      .filter((sig) => !covered.has(sig));
    expect(
      missing,
      'These routes take an identifier but are not exercised with a foreign one. ' +
        'Add them to ROUTES in this file.',
    ).toEqual([]);
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
