import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, projectBody, startHarness, type Harness } from './support/harness.js';
import { assertDatabaseContract, StartupAssertionError } from '../src/db/assertions.js';
import type { Database } from '../src/db/database.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
});

/**
 * Module Addendum §5. The point of putting the entitlement inside the RLS
 * predicate is that a lapsed tenant reads as an empty database from code that
 * never heard of subscriptions — so these assertions go through the database,
 * not only through the router.
 */
describe('entitlement lifecycle', () => {
  it.each([
    ['trial', true],
    ['active', true],
    ['past_due', true],
    ['suspended', false],
    ['cancelled', false],
  ])('state %s: data readable = %s', async (state, readable) => {
    const t = await createTenant(h, {
      slug: `ent-${state}`,
      entitlements: [
        { module: 'estimating', state: 'active' },
        { module: 'projects', state: 'active' },
      ],
    });
    await h
      .as(t.staff.owner!.token)
      .post('/api/v1/projects/projects')
      .send(projectBody({ project_number: `ENT-${state}` }));

    await h.db.asOwner(async (c) => {
      await c.query(
        `UPDATE projects.entitlements SET state = $2::projects.entitlement_state
          WHERE tenant_id = $1 AND module_key = 'projects'`,
        [t.id, state],
      );
    });

    const rows = await h.db.withTenant(t.id, async (c) =>
      c.query(`SELECT id FROM projects.projects`),
    );
    expect(rows.rows.length > 0).toBe(readable);
  });

  it('past_due keeps full access — a billing hiccup does not hide a live job', async () => {
    const t = await createTenant(h, { slug: 'ent-pastdue-api' });
    const created = await h
      .as(t.staff.owner!.token)
      .post('/api/v1/projects/projects')
      .send(projectBody({ project_number: 'PASTDUE-1' }));
    expect(created.status).toBe(201);

    await h.db.asOwner(async (c) => {
      await c.query(
        `UPDATE projects.entitlements SET state = 'past_due' WHERE tenant_id = $1`,
        [t.id],
      );
    });

    const res = await h.as(t.staff.owner!.token).get('/api/v1/projects/projects');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('a suspended tenant gets module_not_entitled, not an empty list', async () => {
    const t = await createTenant(h, { slug: 'ent-suspended-api' });
    await h.db.asOwner(async (c) => {
      await c.query(
        `UPDATE projects.entitlements SET state = 'suspended'
          WHERE tenant_id = $1 AND module_key = 'projects'`,
        [t.id],
      );
    });

    const res = await h.as(t.staff.owner!.token).get('/api/v1/projects/projects');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('module_not_entitled');
    // The message has to be able to say WHY, which is the whole reason the
    // entitlements table is tenant-isolated but not entitlement-gated.
    expect(res.body.error.message).toContain('projects=suspended');
  });

  it('a lapsed estimating entitlement closes projects too', async () => {
    const t = await createTenant(h, { slug: 'ent-est-lapsed' });
    await h.db.asOwner(async (c) => {
      await c.query(
        `UPDATE projects.entitlements SET state = 'cancelled'
          WHERE tenant_id = $1 AND module_key = 'estimating'`,
        [t.id],
      );
    });
    const res = await h.as(t.staff.owner!.token).get('/api/v1/projects/projects');
    expect(res.status).toBe(403);
  });

  it('an expired valid_until closes access even while the state says active', async () => {
    const t = await createTenant(h, { slug: 'ent-expired-window' });
    await h.db.asOwner(async (c) => {
      await c.query(
        `UPDATE projects.entitlements SET valid_until = CURRENT_DATE - 1 WHERE tenant_id = $1`,
        [t.id],
      );
    });
    const rows = await h.db.withTenant(t.id, async (c) =>
      c.query(`SELECT id FROM projects.cost_codes`),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('a tenant with no entitlement row at all reads nothing', async () => {
    const t = await createTenant(h, { slug: 'ent-none', entitlements: [] });
    const rows = await h.db.withTenant(t.id, async (c) =>
      c.query(`SELECT id FROM projects.cost_codes`),
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe('startup assertions', () => {
  it('pass for a correctly configured application role', async () => {
    await expect(assertDatabaseContract(h.db)).resolves.toBeUndefined();
  });

  it('fail loudly when the connection is a superuser', async () => {
    // The failure mode they exist to catch. A superuser connection ignores RLS
    // entirely — FORCE ROW LEVEL SECURITY does not help, because force closes
    // the table-owner exemption and never the superuser one. Every isolation
    // test in this repo would still pass; every tenant would see every row.
    const asSuperuser: Database = {
      withTenant: (id, fn) => h.db.withTenant(id, fn),
      withoutTenant: (fn) => h.db.asOwner(fn),
      tryAdvisoryLock: async () => null,
      close: async () => {},
    };

    await expect(assertDatabaseContract(asSuperuser)).rejects.toThrow(StartupAssertionError);
    await assertDatabaseContract(asSuperuser).catch((err: StartupAssertionError) => {
      expect(err.failures.join(' ')).toMatch(/superuser/);
    });
  });
});
