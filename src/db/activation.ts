import type { Database, SqlClient } from './database.js';

/**
 * Tenant provisioning, in the only order that works.
 *
 * activate_tenant_full() runs as the caller under RLS, and every table it
 * writes carries a WITH CHECK of tenant_enabled(tenant_id). So the entitlement
 * rows have to exist and be live BEFORE activation runs, and the transaction
 * has to already have app.tenant_id set to the tenant being activated.
 *
 * Get the order wrong and Postgres says "new row violates row-level security
 * policy for table compliance_requirements", which is a true statement that
 * tells an operator nothing. This function is the order, written down once.
 */

export interface ProvisionTenantInput {
  tenantId: string;
  slug: string;
  displayName: string;
  country?: string;
  /** Defaults to trial on both modules. Projects requires estimating. */
  entitlements?: Array<{
    moduleKey: 'estimating' | 'projects';
    state?: 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled';
    businessUnitsLicensed?: number;
    validUntil?: string | null;
  }>;
  firstBusinessUnitName?: string;
}

/**
 * Step 1 — platform data. The tenants and entitlements rows belong to the
 * platform and to billing; the application role is not granted writes on
 * entitlements, so this half runs on a privileged connection. Passed in as a
 * client rather than taken from the Database so that the caller has to have
 * decided, deliberately, which connection this is.
 */
export async function writePlatformRows(
  privileged: SqlClient,
  input: ProvisionTenantInput,
): Promise<void> {
  await privileged.query(
    `INSERT INTO projects.tenants (id, slug, display_name, country)
     VALUES ($1, $2, $3, COALESCE($4, 'US'))
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [input.tenantId, input.slug, input.displayName, input.country ?? null],
  );

  const entitlements = input.entitlements ?? [
    { moduleKey: 'estimating' as const, state: 'trial' as const },
    { moduleKey: 'projects' as const, state: 'trial' as const },
  ];
  for (const e of entitlements) {
    await privileged.query(
      `INSERT INTO projects.entitlements
         (tenant_id, module_key, state, business_units_licensed, valid_until)
       VALUES ($1, $2, COALESCE($3,'trial')::projects.entitlement_state, COALESCE($4,1), $5)
       ON CONFLICT (tenant_id, module_key) DO UPDATE
         SET state = EXCLUDED.state,
             business_units_licensed = EXCLUDED.business_units_licensed,
             valid_until = EXCLUDED.valid_until,
             updated_at = now()`,
      [
        input.tenantId,
        e.moduleKey,
        e.state ?? null,
        e.businessUnitsLicensed ?? null,
        e.validUntil ?? null,
      ],
    );
  }
}

/**
 * Step 2 — module data. Runs as the application role with the tenant set, so
 * everything it writes goes through the same RLS predicate that will serve it
 * back. If activation can write it, a request can read it.
 */
export async function activateModule(
  db: Database,
  tenantId: string,
  firstBusinessUnitName = 'Main',
): Promise<{ costCodes: number; gates: number }> {
  return db.withTenant(tenantId, async (c) => {
    await c.query(`SELECT projects.activate_tenant_full($1, $2)`, [
      tenantId,
      firstBusinessUnitName,
    ]);
    const codes = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM projects.cost_codes WHERE tenant_id = $1`,
      [tenantId],
    );
    const gates = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM projects.gate_templates WHERE tenant_id = $1`,
      [tenantId],
    );
    return {
      costCodes: Number(codes.rows[0]?.n ?? 0),
      gates: Number(gates.rows[0]?.n ?? 0),
    };
  });
}
