import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, startHarness, type Harness, type TenantFixture } from './support/harness.js';

/**
 * The schema's own guarantees, exercised directly rather than through a route.
 *
 * Each of these corresponds to a defect found on the first execution of
 * journeyman_projects_schema.sql — see docs/SCHEMA_FIXES.md. They are here so
 * that a future edit to the SQL that reintroduces one fails the build instead
 * of failing a customer.
 */

let h: Harness;
let t: TenantFixture;

beforeAll(async () => {
  h = await startHarness();
  t = await createTenant(h, { slug: 'hardening' });
});

afterAll(async () => {
  await h?.close();
});

describe('search_path independence (FIX 2)', () => {
  it('RLS still filters when the connection search_path is not projects', async () => {
    const rows = await h.db.withTenant(t.id, async (c) => {
      await c.query(`SET LOCAL search_path = public`);
      return c.query(`SELECT count(*)::text AS n FROM projects.cost_codes`);
    });
    // The predicate functions are all schema-qualified, so this reads the
    // tenant's codes rather than raising "function current_tenant() does not
    // exist" — which is what every RLS policy in the schema used to do.
    expect(Number((rows.rows[0] as { n: string }).n)).toBeGreaterThan(0);
  });

  it('activation runs under a foreign search_path', async () => {
    const other = await h.db.asOwner(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO projects.tenants (id, slug, display_name)
         VALUES (gen_random_uuid(), 'hardening-2', 'Hardening 2') RETURNING id`,
      );
      const id = rows[0]!.id;
      for (const m of ['estimating', 'projects']) {
        await c.query(
          `INSERT INTO projects.entitlements (tenant_id, module_key, state)
           VALUES ($1, $2, 'active')`,
          [id, m],
        );
      }
      return id;
    });

    await expect(
      h.db.withTenant(other, async (c) => {
        await c.query(`SET LOCAL search_path = public`);
        await c.query(`SELECT projects.activate_tenant_full($1, 'Main')`, [other]);
      }),
    ).resolves.toBeUndefined();
  });
});

describe('blank tenant setting (FIX 3)', () => {
  it('an empty app.tenant_id reads as no tenant, not as a cast error', async () => {
    const rows = await h.db.withTenant('', async (c) =>
      c.query(`SELECT count(*)::text AS n FROM projects.entitlements`),
    );
    expect(Number((rows.rows[0] as { n: string }).n)).toBe(0);
  });

  it('an unset app.tenant_id reads as no tenant', async () => {
    const rows = await h.db.withoutTenant(async (c) =>
      c.query(`SELECT count(*)::text AS n FROM projects.cost_codes`),
    );
    expect(Number((rows.rows[0] as { n: string }).n)).toBe(0);
  });
});

describe('vendor eligibility trigger (FIX 4)', () => {
  async function seedVendorAndProject(compliant: boolean) {
    return h.db.withTenant(t.id, async (c) => {
      const suffix = Math.random().toString(36).slice(2, 8);
      const vendor = await c.query<{ id: string }>(
        `INSERT INTO projects.vendors (tenant_id, legal_name, email)
         VALUES ($1, $2, $3) RETURNING id`,
        [t.id, `Acme ${suffix}`, `acme-${suffix}@v.test`],
      );
      const vendorId = vendor.rows[0]!.id;

      if (compliant) {
        const kinds = await c.query<{ kind: string }>(
          `SELECT kind::text AS kind FROM projects.compliance_requirements
            WHERE tenant_id = $1 AND required`,
          [t.id],
        );
        for (const k of kinds.rows) {
          await c.query(
            `INSERT INTO projects.vendor_documents (tenant_id, vendor_id, kind, expires_on)
             VALUES ($1, $2, $3::projects.doc_kind, CURRENT_DATE + 365)`,
            [t.id, vendorId, k.kind],
          );
        }
      }

      const project = await c.query<{ id: string }>(
        `INSERT INTO projects.projects
           (tenant_id, project_number, name, address_line1, city, region,
            contract_value, target_margin)
         VALUES ($1, $2, 'Trigger probe', '1 Main', 'Richmond', 'VA', 1000, 0.38)
         RETURNING id`,
        [t.id, `TRG-${suffix}`],
      );
      return { vendorId, projectId: project.rows[0]!.id };
    });
  }

  it('blocks confirming a vendor with missing documents', async () => {
    const { vendorId, projectId } = await seedVendorAndProject(false);
    await expect(
      h.db.withTenant(t.id, async (c) =>
        c.query(
          `INSERT INTO projects.schedule_items
             (tenant_id, project_id, title, vendor_id, window_start, window_end, status)
           VALUES ($1,$2,'Tile',$3,CURRENT_DATE,CURRENT_DATE + 1,'confirmed')`,
          [t.id, projectId, vendorId],
        ),
      ),
    ).rejects.toThrow(/cannot be scheduled/);
  });

  it('allows pencilling the same vendor in as proposed', async () => {
    // Deliberate: a PM may hold a slot while a renewal is in flight.
    // Confirmation is what actually puts someone on site.
    const { vendorId, projectId } = await seedVendorAndProject(false);
    await expect(
      h.db.withTenant(t.id, async (c) =>
        c.query(
          `INSERT INTO projects.schedule_items
             (tenant_id, project_id, title, vendor_id, window_start, window_end, status)
           VALUES ($1,$2,'Tile',$3,CURRENT_DATE,CURRENT_DATE + 1,'proposed')`,
          [t.id, projectId, vendorId],
        ),
      ),
    ).resolves.toBeDefined();
  });

  it('allows confirming a compliant vendor', async () => {
    const { vendorId, projectId } = await seedVendorAndProject(true);
    await expect(
      h.db.withTenant(t.id, async (c) =>
        c.query(
          `INSERT INTO projects.schedule_items
             (tenant_id, project_id, title, vendor_id, window_start, window_end, status)
           VALUES ($1,$2,'Tile',$3,CURRENT_DATE,CURRENT_DATE + 1,'confirmed')`,
          [t.id, projectId, vendorId],
        ),
      ),
    ).resolves.toBeDefined();
  });

  it('an expired document blocks scheduling and the view says which', async () => {
    const { vendorId } = await seedVendorAndProject(true);
    await h.db.withTenant(t.id, async (c) => {
      await c.query(
        `UPDATE projects.vendor_documents SET expires_on = CURRENT_DATE - 1
          WHERE vendor_id = $1 AND kind = 'gl_insurance'`,
        [vendorId],
      );
    });
    const eligibility = await h.db.withTenant(t.id, async (c) =>
      c.query<{ schedulable: boolean; expired_count: string }>(
        `SELECT schedulable, expired_count::text AS expired_count
           FROM projects.v_vendor_eligibility WHERE vendor_id = $1`,
        [vendorId],
      ),
    );
    expect(eligibility.rows[0]!.schedulable).toBe(false);
    expect(Number(eligibility.rows[0]!.expired_count)).toBe(1);
  });
});

describe('reporting views read through RLS', () => {
  it('every view is selectable by the application role', async () => {
    const views = [
      'v_cost_position',
      'v_project_margin',
      'v_vendor_compliance',
      'v_vendor_eligibility',
      'v_draw_exceptions',
      'v_permit_exceptions',
      'v_budget_exceptions',
      'v_missing_daily_logs',
    ];
    for (const view of views) {
      await expect(
        h.db.withTenant(t.id, async (c) => c.query(`SELECT * FROM projects.${view} LIMIT 1`)),
        view,
      ).resolves.toBeDefined();
    }
  });

  it('views are security_invoker, so they do not become an RLS bypass', async () => {
    // A view without security_invoker runs with its definer's rights. Every
    // exception report in this module is a view, so one missing option turns
    // the entire reporting surface into a cross-tenant read.
    const rows = await h.db.withoutTenant(async (c) =>
      c.query<{ viewname: string }>(
        `SELECT c.relname AS viewname
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'projects' AND c.relkind = 'v'
            AND NOT COALESCE((
              SELECT option_value::boolean FROM pg_options_to_table(c.reloptions)
               WHERE option_name = 'security_invoker'), false)`,
      ),
    );
    expect(rows.rows.map((r) => r.viewname)).toEqual([]);
  });
});
