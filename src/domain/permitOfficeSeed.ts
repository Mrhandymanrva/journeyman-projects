import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "../db/database.js";
import { importPermitOffices, parsePermitOfficeCsv } from "./permitOffices.js";

/**
 * Loads the shipped 18 permit offices once per tenant.
 *
 * This is a boot step, not a data migration. `db/037` only creates the marker
 * table. The load calls `parsePermitOfficeCsv` and `importPermitOffices`, the
 * same functions as `POST /jurisdictions/import`, so a row is accepted or
 * grouped the same way.
 *
 * The marker is what protects later edits. The importer itself would write the
 * CSV back over an office that someone changed. After the marker commits, a
 * second call does not open the file.
 *
 * The tenant is the one the import would write for. The HTTP import uses the
 * signed-in staff member's tenant. On this product that is the deployment's
 * tenant: `SSO_TENANT_ID`, or `PM_PORTFOLIO_TENANT_ID` when SSO does not name
 * one (the same pair `readEnv` uses). Production has a single
 * `projects.tenants` row — demo data is refused when `NODE_ENV=production` —
 * so an unnamed configuration uses that only row. Zero tenants waits for a
 * later boot. More than one tenant, with neither variable set, is skipped
 * rather than written into every tenant.
 */
export const PERMIT_OFFICE_SEED_KEY = "permit_offices_import_v1";

export interface PermitOfficeSeedResult {
  status: "applied" | "already_applied" | "skipped";
  reason: string | null;
  tenantId: string | null;
  created: number;
  updated: number;
  contacts_upserted: number;
  unchanged: number;
}

export interface SeedPermitOfficesOptions {
  /** Tests pass a tenant. Deploy leaves this unset and resolves one. */
  tenantId?: string;
  csvPath?: string;
  /** Defaults to process.env. Tests pass a fixed object. */
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

const EMPTY = {
  created: 0,
  updated: 0,
  contacts_upserted: 0,
  unchanged: 0,
};

export function permitOfficeSeedCsvPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../db/seeds/permit_offices_import.csv",
  );
}

export async function seedPermitOffices(
  db: Database,
  options: SeedPermitOfficesOptions = {},
): Promise<PermitOfficeSeedResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const resolved = options.tenantId
    ? { tenantId: options.tenantId, reason: null as string | null }
    : await resolveSeedTenant(db, options.env ?? process.env);
  if (!resolved.tenantId) {
    const result = finish("skipped", null, resolved.reason, EMPTY);
    log(line(result));
    return result;
  }
  const csvPath = options.csvPath ?? permitOfficeSeedCsvPath();
  const offices = parsePermitOfficeCsv(readFileSync(csvPath, "utf8"));
  let result: PermitOfficeSeedResult;
  try {
    result = await db.withTenant(resolved.tenantId, async (client) => {
      const existing = await client.query(
        `SELECT 1
           FROM projects.permit_office_seed_runs
          WHERE tenant_id = $1 AND seed_key = $2
          FOR UPDATE`,
        [resolved.tenantId, PERMIT_OFFICE_SEED_KEY],
      );
      if (existing.rows.length > 0) {
        return finish("already_applied", resolved.tenantId, null, EMPTY);
      }
      const counts = await importPermitOffices(client, resolved.tenantId!, offices);
      await client.query(
        `INSERT INTO projects.permit_office_seed_runs
           (tenant_id, seed_key, offices_created, offices_updated, contacts_upserted)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          resolved.tenantId,
          PERMIT_OFFICE_SEED_KEY,
          counts.created,
          counts.updated,
          counts.contacts_upserted,
        ],
      );
      return finish("applied", resolved.tenantId, null, counts);
    });
  } catch (err) {
    if (!isSeedMarkerConflict(err)) throw err;
    result = finish("already_applied", resolved.tenantId, null, EMPTY);
  }
  log(line(result));
  return result;
}

async function resolveSeedTenant(
  db: Database,
  env: NodeJS.ProcessEnv,
): Promise<{ tenantId: string | null; reason: string | null }> {
  const configured = (env.SSO_TENANT_ID ?? env.PM_PORTFOLIO_TENANT_ID ?? "").trim();
  const tenants = await db.withoutTenant(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM projects.tenants ORDER BY created_at, id`,
    );
    return rows.map((row) => row.id);
  });
  if (configured) {
    const match = tenants.find((id) => id.toLowerCase() === configured.toLowerCase());
    if (!match) {
      return {
        tenantId: null,
        reason: "SSO_TENANT_ID or PM_PORTFOLIO_TENANT_ID is not a tenant in this database",
      };
    }
    return { tenantId: match, reason: null };
  }
  if (tenants.length === 1) return { tenantId: tenants[0]!, reason: null };
  if (tenants.length === 0) {
    return { tenantId: null, reason: "no tenant in this database yet" };
  }
  return {
    tenantId: null,
    reason: "more than one tenant, and neither SSO_TENANT_ID nor PM_PORTFOLIO_TENANT_ID is set",
  };
}

function finish(
  status: PermitOfficeSeedResult["status"],
  tenantId: string | null,
  reason: string | null,
  counts: {
    created: number;
    updated: number;
    contacts_upserted: number;
    unchanged: number;
  },
): PermitOfficeSeedResult {
  return {
    status,
    reason,
    tenantId,
    created: counts.created,
    updated: counts.updated,
    contacts_upserted: counts.contacts_upserted,
    unchanged: counts.unchanged,
  };
}

function line(result: PermitOfficeSeedResult): string {
  if (result.status === "skipped") {
    return `permit offices seed: skipped (${result.reason})`;
  }
  const counts = `offices created ${result.created}, offices updated ${result.updated}, contacts ${result.contacts_upserted}`;
  if (result.status === "already_applied") {
    return `permit offices seed: already applied; ${counts}`;
  }
  return `permit offices seed: ${counts}`;
}

function isSeedMarkerConflict(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return code === "23505" && /permit_office_seed_runs/i.test(message);
}
