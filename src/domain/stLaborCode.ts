import type { SqlClient } from "../db/database.js";
import { stampLaborCodes } from "./laborActuals.js";

/** A success is remembered for an hour. A failure is checked again within five minutes. */
export const ST_LABOR_CODE_SUCCESS_TTL_MS = 60 * 60 * 1000;
export const ST_LABOR_CODE_FAILURE_TTL_MS = 5 * 60 * 1000;

/** The only labor code. ServiceTitan pricebook service, not a payroll labor type and not a setting. */
export const LABOR_SERVICE_CODE = "MHM.25PLFE";
export const LABOR_SERVICE_SOURCE = "servicetitan_pricebook_service";

/** Rows written by the payroll labor-type mirror. Retired, not deleted, so stamped hours keep a target. */
export const RETIRED_LABOR_SOURCES = [
  "servicetitan_labor_type",
  "journeyman_builtin_labor",
] as const;

export const LABOR_SERVICE_MISSING_MESSAGE =
  "ServiceTitan labor code MHM.25PLFE not found or inactive; labor hours are uncoded";

export const LABOR_SERVICE_READ_FAILED_MESSAGE =
  "ServiceTitan labor code MHM.25PLFE could not be read; labor hours are uncoded";

export function laborCodeCollisionMessage(code: string): string {
  return `code ${code} already exists as a Journeyman cost code. Hours stay uncoded.`;
}

export interface PricebookServiceRow {
  id: string;
  code: string | null;
  name: string | null;
  active: boolean;
}

export interface LaborServiceClient {
  readLaborService?: () => Promise<{ services: PricebookServiceRow[] }>;
  /** ServiceTitan tenant id. The in-memory cache is keyed on this. */
  sourceTenantId?: string;
}

export type StLaborResolve =
  | {
      ok: true;
      code: string;
      name: string;
      stId: string;
    }
  | {
      ok: false;
      reason: "missing" | "inactive" | "read_failed";
      message: string;
    };

export type StLaborStatus =
  | (Extract<StLaborResolve, { ok: true }> & { costCodeId: string })
  | {
      ok: false;
      reason: "missing" | "inactive" | "read_failed" | "collision";
      message: string;
    };

interface CacheEntry {
  storedAt: number;
  result: StLaborResolve;
}

const cache = new Map<string, CacheEntry>();
const objectKeys = new WeakMap<object, string>();
let objectSeq = 0;
let laborCodeErrorLogged = false;

export function clearStLaborCodeCache(): void {
  cache.clear();
}

/** Tests only. Production logs a labor-code error once per process start. */
export function resetLaborCodeErrorLog(): void {
  laborCodeErrorLogged = false;
}

function cacheKey(client: LaborServiceClient | null | undefined): string {
  if (!client) return "missing";
  const tenant = client.sourceTenantId?.trim();
  if (tenant) return `st:${tenant}`;
  let key = objectKeys.get(client);
  if (!key) {
    objectSeq += 1;
    key = `client:${objectSeq}`;
    objectKeys.set(client, key);
  }
  return key;
}

function noteLaborCodeError(message: string): void {
  if (laborCodeErrorLogged) return;
  laborCodeErrorLogged = true;
  console.error(message);
}

function failure(
  reason: "missing" | "inactive" | "read_failed",
  message: string,
): StLaborResolve {
  noteLaborCodeError(message);
  return { ok: false, reason, message };
}

function remember(key: string, now: number, result: StLaborResolve): StLaborResolve {
  cache.set(key, { storedAt: now, result });
  return result;
}

function serviceName(row: PricebookServiceRow): string {
  const name = row.name?.trim() ?? "";
  return name || LABOR_SERVICE_CODE;
}

/**
 * MHM.25PLFE from the ServiceTitan pricebook.
 * An exact code match is required, compared without case, and the service must be active.
 * A success is remembered for an hour. A failure is remembered for five minutes.
 * The first failure in a process is logged once. Nothing is written to tenant settings.
 */
export async function resolveStLaborCode(
  client: LaborServiceClient | null | undefined,
  now = Date.now(),
): Promise<StLaborResolve> {
  const reader = client ?? null;
  const key = cacheKey(reader);
  const hit = cache.get(key);
  if (hit) {
    const ttl = hit.result.ok ? ST_LABOR_CODE_SUCCESS_TTL_MS : ST_LABOR_CODE_FAILURE_TTL_MS;
    if (now - hit.storedAt < ttl) return hit.result;
  }
  if (!reader?.readLaborService) {
    return remember(key, now, failure("read_failed", LABOR_SERVICE_READ_FAILED_MESSAGE));
  }
  let read: { services: PricebookServiceRow[] };
  try {
    read = await reader.readLaborService();
  } catch {
    return remember(key, now, failure("read_failed", LABOR_SERVICE_READ_FAILED_MESSAGE));
  }
  const exact = (read.services ?? []).filter(
    (row) => row.code?.trim().toLowerCase() === LABOR_SERVICE_CODE.toLowerCase(),
  );
  const active = exact.filter((row) => row.active && row.id);
  if (active.length === 0) {
    const reason = exact.length > 0 ? "inactive" : "missing";
    return remember(key, now, failure(reason, LABOR_SERVICE_MISSING_MESSAGE));
  }
  const only = active[0]!;
  return remember(key, now, {
    ok: true,
    code: LABOR_SERVICE_CODE,
    name: serviceName(only),
    stId: only.id,
  });
}

/** What the hourly summary counts: refreshed projects, failed projects, and the labor code. */
export function laborCodeRunLabel(status: StLaborResolve): string {
  if (!status.ok) return status.message;
  const name = status.name.trim();
  return name && name !== status.code ? `${status.code} ${name}` : status.code;
}

/**
 * One system cost code for MHM.25PLFE. A seeded or user-entered row with that
 * code is left as it is. The payroll labor-type mirror is replaced in place
 * when it already used this code, so the id stamped on hours does not change.
 */
export async function mirrorLaborServiceCode(
  db: SqlClient,
  tenantId: string,
  resolved: Extract<StLaborResolve, { ok: true }>,
): Promise<StLaborStatus> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO projects.cost_codes
       (tenant_id, code, division_code, division_name, description,
        default_cost_type, sort_order, active, external_source, external_id)
     VALUES ($1, $2, 'ST', 'ServiceTitan', $3, 'L'::projects.cost_type, 0, true, $4, $5)
     ON CONFLICT (tenant_id, code) DO NOTHING
     RETURNING id`,
    [tenantId, resolved.code, resolved.name, LABOR_SERVICE_SOURCE, resolved.stId],
  );
  if (inserted.rows[0]) return { ...resolved, costCodeId: inserted.rows[0].id };

  const existing = await db.query<{ id: string; external_source: string | null }>(
    `SELECT id, external_source
       FROM projects.cost_codes
      WHERE tenant_id = $1 AND code = $2`,
    [tenantId, resolved.code],
  );
  const row = existing.rows[0];
  const owned =
    row?.external_source === LABOR_SERVICE_SOURCE ||
    row?.external_source === "servicetitan_labor_type" ||
    row?.external_source === "journeyman_builtin_labor";
  if (!row || !owned) {
    const message = laborCodeCollisionMessage(resolved.code);
    noteLaborCodeError(message);
    return { ok: false, reason: "collision", message };
  }
  await db.query(
    `UPDATE projects.cost_codes
        SET description = $3,
            division_code = 'ST',
            division_name = 'ServiceTitan',
            external_id = $4,
            external_source = $5,
            default_cost_type = 'L'::projects.cost_type,
            active = true
      WHERE id = $1 AND tenant_id = $2`,
    [row.id, tenantId, resolved.name, resolved.stId, LABOR_SERVICE_SOURCE],
  );
  return { ...resolved, costCodeId: row.id };
}

async function retirePreviousLaborCodes(
  db: SqlClient,
  tenantId: string,
  keepId: string,
): Promise<void> {
  await db.query(
    `UPDATE projects.cost_codes
        SET active = false
      WHERE tenant_id = $1
        AND id <> $2
        AND external_source = ANY($3::text[])`,
    [tenantId, keepId, [...RETIRED_LABOR_SOURCES, LABOR_SERVICE_SOURCE]],
  );
}

/**
 * Store the pricebook service and point every labor row at it.
 * Wage and burden both come off those rows, so one stamp codes both.
 * A failure leaves cost_code_id as it is. Previous system rows are retired
 * only after the stamp, and they are not deleted.
 */
export async function applyResolvedLaborCode(
  db: SqlClient,
  tenantId: string,
  resolved: StLaborResolve,
): Promise<StLaborStatus> {
  if (!resolved.ok) return resolved;
  const mirrored = await mirrorLaborServiceCode(db, tenantId, resolved);
  if (!mirrored.ok) return mirrored;
  await stampLaborCodes(db, tenantId, mirrored.costCodeId);
  await retirePreviousLaborCodes(db, tenantId, mirrored.costCodeId);
  return mirrored;
}

/** Resolve and mirror for display. Does not stamp hours. */
export async function readStLaborCode(
  db: SqlClient,
  tenantId: string,
  client: LaborServiceClient | null | undefined,
  now = Date.now(),
): Promise<StLaborStatus> {
  const resolved = await resolveStLaborCode(client, now);
  if (!resolved.ok) return resolved;
  return mirrorLaborServiceCode(db, tenantId, resolved);
}

export function presentStLaborCode(status: StLaborStatus): {
  st_labor_code: { code: string; name: string; st_id: string } | null;
  st_labor_code_error: string | null;
  costCodeId: string | null;
} {
  if (!status.ok) {
    return { st_labor_code: null, st_labor_code_error: status.message, costCodeId: null };
  }
  return {
    st_labor_code: { code: status.code, name: status.name, st_id: status.stId },
    st_labor_code_error: null,
    costCodeId: status.costCodeId,
  };
}
