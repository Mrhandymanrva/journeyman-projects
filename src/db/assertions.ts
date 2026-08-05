import type { Database } from './database.js';

/**
 * Startup assertions. These check the things that, if wrong, make every other
 * guarantee in the module cosmetic — and that are invisible in code review
 * because they live in the database's grant configuration rather than in a
 * file anyone reads.
 *
 * They run at boot and refuse to start the server. A module whose isolation
 * silently degraded is worse than one that will not come up.
 */

export class StartupAssertionError extends Error {
  constructor(readonly failures: string[]) {
    super(`Startup assertions failed:\n  - ${failures.join('\n  - ')}`);
    this.name = 'StartupAssertionError';
  }
}

/**
 * Every table that carries tenant_id and must have RLS enabled and forced.
 *
 * Exported so src/provision.ts checks the same list rather than counting all
 * tables in the schema — two of them deliberately have no RLS, and a check
 * that flags those is a check people learn to ignore:
 *
 *   tenants            a local projection of platform tenancy. Something has
 *                      to resolve an identifier before a session exists.
 *   cost_code_library  product content, not customer data. Readable by every
 *                      tenant, writable only by migration.
 *
 * Anything else appearing without RLS is a mistake, and both this and
 * provisioning report it by name.
 */
export const NON_TENANT_SCOPED_TABLES = ['tenants', 'cost_code_library'] as const;

export const TENANT_SCOPED_TABLES = [
  'business_units',
  'external_systems',
  'estimate_imports',
  'staff',
  'cost_codes',
  'vendors',
  'vendor_documents',
  'compliance_requirements',
  'projects',
  'gate_templates',
  'stage_gates',
  'budget_lines',
  'purchase_orders',
  'vendor_bills',
  'change_orders',
  'draws',
  'jurisdictions',
  'permits',
  'permit_milestone_templates',
  'permit_milestones',
  'schedule_items',
  'daily_logs',
  'vendor_portal_users',
  'vendor_scores',
  'audit_log',
  'entitlements',
  'tenant_settings',
] as const;

export async function assertDatabaseContract(db: Database): Promise<void> {
  const failures: string[] = [];

  await db.withoutTenant(async (c) => {
    const role = await c.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolsuper, rolbypassrls
         FROM pg_roles WHERE rolname = current_user`,
    );
    const r = role.rows[0];
    if (!r) {
      failures.push('current_user has no pg_roles row');
    } else {
      // Either attribute makes RLS a no-op for this connection. FORCE ROW
      // LEVEL SECURITY does not help — force only closes the table-owner
      // exemption, never the superuser/bypassrls one.
      if (r.rolsuper) failures.push(`application role ${r.rolname} is a superuser`);
      if (r.rolbypassrls) failures.push(`application role ${r.rolname} has BYPASSRLS`);
    }

    const owned = await c.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'projects'
          AND c.relkind = 'r'
          AND pg_get_userbyid(c.relowner) = current_user`,
    );
    if (owned.rowCount > 0) {
      // FORCE ROW LEVEL SECURITY is on every table, so ownership alone would
      // not currently leak. It is still asserted: the day someone adds a table
      // and forgets FORCE, ownership is what decides whether that omission is
      // a cosmetic oversight or a cross-tenant read.
      failures.push(
        `application role owns ${owned.rowCount} table(s) in schema projects: ` +
          owned.rows
            .map((x) => x.relname)
            .slice(0, 5)
            .join(', '),
      );
    }

    const rls = await c.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'projects' AND c.relkind = 'r'
          AND c.relname = ANY($1::text[])`,
      [TENANT_SCOPED_TABLES as unknown as string[]],
    );
    const seen = new Map(rls.rows.map((x) => [x.relname, x]));
    for (const table of TENANT_SCOPED_TABLES) {
      const row = seen.get(table);
      if (!row) {
        failures.push(`table projects.${table} is missing`);
        continue;
      }
      if (!row.relrowsecurity) failures.push(`projects.${table} has RLS disabled`);
      if (!row.relforcerowsecurity) failures.push(`projects.${table} does not FORCE RLS`);
    }

    // Any tenant-scoped table added later without a policy would read as empty
    // rather than leak, but it would also be silently unusable. Catch it here.
    const unpoliced = await c.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'projects' AND c.relkind = 'r'
          AND c.relrowsecurity
          AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)`,
    );
    for (const row of unpoliced.rows) {
      failures.push(`projects.${row.relname} has RLS enabled but no policy`);
    }

    // current_setting rather than SHOW: SHOW names its own output column, so
    // reading it by an alias silently yields undefined and the check passes
    // (or, as here, fails) for a reason that has nothing to do with the server.
    const version = await c.query<{ n: string }>(
      `SELECT current_setting('server_version_num') AS n`,
    );
    const num = Number(version.rows[0]?.n ?? 0);
    if (num < 150000) {
      // security_invoker on views. Without it every view reads with the
      // definer's rights and the entire reporting surface ignores RLS.
      failures.push(`PostgreSQL ${num} is below the required 15`);
    }
  });

  if (failures.length > 0) throw new StartupAssertionError(failures);
}
