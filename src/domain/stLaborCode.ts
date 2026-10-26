import type { SqlClient } from "../db/database.js";
import { stampLaborCodes } from "./laborActuals.js";

/** Successes stay for an hour. A failure is checked again within five minutes. */
export const ST_LABOR_CODE_SUCCESS_TTL_MS = 60 * 60 * 1000;
export const ST_LABOR_CODE_FAILURE_TTL_MS = 5 * 60 * 1000;

export const ST_LABOR_SOURCE = "servicetitan_labor_type";

export const ST_LABOR_FORBIDDEN_MESSAGE =
  "Journeyman's ServiceTitan app cannot read Payroll > Labor Types (403). Hours stay uncoded.";

export function laborTypeCountMessage(count: number): string {
  return `ServiceTitan has ${count} active labor types; Journeyman expects exactly one. Hours stay uncoded.`;
}

export function laborCodeCollisionMessage(code: string): string {
  return `code ${code} already exists as a Journeyman cost code. Hours stay uncoded.`;
}

export interface StLaborTypeRow {
  id: string;
  name: string | null;
  code: string | null;
  serviceCodeId: string | null;
  active: boolean;
}

export interface StLaborTypeClient {
  readLaborTypes?: () => Promise<{
    forbidden: boolean;
    laborTypes: StLaborTypeRow[];
  }>;
  /** ServiceTitan tenant id. The in-memory cache is keyed on this. */
  sourceTenantId?: string;
}

export type StLaborResolve =
  | {
      ok: true;
      code: string;
      name: string;
      stId: string;
      serviceCodeId: string | null;
    }
  | {
      ok: false;
      reason: "forbidden" | "none" | "many" | "read_failed";
      message: string;
    };

export type StLaborStatus =
  | (Extract<StLaborResolve, { ok: true }> & { costCodeId: string })
  | {
      ok: false;
      reason: "forbidden" | "none" | "many" | "read_failed" | "collision";
      message: string;
    };

interface CacheEntry {
  storedAt: number;
  result: StLaborResolve;
}

const cache = new Map<string, CacheEntry>();
const objectKeys = new WeakMap<object, string>();
let objectSeq = 0;

export function clearStLaborCodeCache(): void {
  cache.clear();
}

function cacheKey(client: StLaborTypeClient | null | undefined): string {
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

function failure(reason: "forbidden" | "none" | "many" | "read_failed", message: string): StLaborResolve {
  return { ok: false, reason, message };
}

function remember(key: string, now: number, result: StLaborResolve): StLaborResolve {
  cache.set(key, { storedAt: now, result });
  return result;
}

/**
 * The one active ServiceTitan labor type.
 * A success is remembered for an hour. A failure is remembered for five minutes.
 * Nothing is written to tenant settings.
 */
export async function resolveStLaborCode(
  client: StLaborTypeClient | null | undefined,
  now = Date.now(),
): Promise<StLaborResolve> {
  const reader = client ?? null;
  const key = cacheKey(reader);
  const hit = cache.get(key);
  if (hit) {
    const ttl = hit.result.ok ? ST_LABOR_CODE_SUCCESS_TTL_MS : ST_LABOR_CODE_FAILURE_TTL_MS;
    if (now - hit.storedAt < ttl) return hit.result;
  }
  if (!reader?.readLaborTypes) {
    return remember(
      key,
      now,
      failure(
        "read_failed",
        "ServiceTitan labor-type read is not configured. Hours stay uncoded.",
      ),
    );
  }
  let read: { forbidden: boolean; laborTypes: StLaborTypeRow[] };
  try {
    read = await reader.readLaborTypes();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\bHTTP 403\b/.test(message)) {
      return remember(key, now, failure("forbidden", ST_LABOR_FORBIDDEN_MESSAGE));
    }
    const detail = message.trim() || "ServiceTitan labor types could not be read.";
    return remember(key, now, failure("read_failed", `${detail} Hours stay uncoded.`));
  }
  if (read.forbidden) {
    return remember(key, now, failure("forbidden", ST_LABOR_FORBIDDEN_MESSAGE));
  }
  const active = (read.laborTypes ?? []).filter((row) => row.active);
  if (active.length !== 1) {
    return remember(key, now, failure(active.length === 0 ? "none" : "many", laborTypeCountMessage(active.length)));
  }
  const only = active[0]!;
  const code = only.code?.trim() ?? "";
  if (!code || !only.id) {
    return remember(
      key,
      now,
      failure("read_failed", "ServiceTitan's only active labor type has no code. Hours stay uncoded."),
    );
  }
  const name = only.name?.trim() || code;
  return remember(key, now, {
    ok: true,
    code,
    name,
    stId: only.id,
    serviceCodeId: only.serviceCodeId,
  });
}

/**
 * One system-managed cost code for the ServiceTitan labor type.
 * A seeded row with the same code is left as it is.
 */
export async function mirrorStLaborCode(
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
    [tenantId, resolved.code, resolved.name, ST_LABOR_SOURCE, resolved.stId],
  );
  if (inserted.rows[0]) {
    return { ...resolved, costCodeId: inserted.rows[0].id };
  }
  const existing = await db.query<{
    id: string;
    external_source: string | null;
  }>(
    `SELECT id, external_source
       FROM projects.cost_codes
      WHERE tenant_id = $1 AND code = $2`,
    [tenantId, resolved.code],
  );
  const row = existing.rows[0];
  if (!row || row.external_source !== ST_LABOR_SOURCE) {
    return {
      ok: false,
      reason: "collision",
      message: laborCodeCollisionMessage(resolved.code),
    };
  }
  await db.query(
    `UPDATE projects.cost_codes
        SET description = $3,
            external_id = $4,
            external_source = $5,
            default_cost_type = 'L'::projects.cost_type
      WHERE id = $1 AND tenant_id = $2`,
    [row.id, tenantId, resolved.name, resolved.stId, ST_LABOR_SOURCE],
  );
  return { ...resolved, costCodeId: row.id };
}

/** Mirror the resolved code and stamp every labor row for the tenant. A failure leaves cost_code_id as it is. */
export async function applyResolvedLaborCode(
  db: SqlClient,
  tenantId: string,
  resolved: StLaborResolve,
): Promise<StLaborStatus> {
  if (!resolved.ok) return resolved;
  const mirrored = await mirrorStLaborCode(db, tenantId, resolved);
  if (!mirrored.ok) return mirrored;
  await stampLaborCodes(db, tenantId, mirrored.costCodeId);
  return mirrored;
}

/** Resolve and mirror for display. Does not stamp hours. */
export async function readStLaborCode(
  db: SqlClient,
  tenantId: string,
  client: StLaborTypeClient | null | undefined,
  now = Date.now(),
): Promise<StLaborStatus> {
  const resolved = await resolveStLaborCode(client, now);
  if (!resolved.ok) return resolved;
  return mirrorStLaborCode(db, tenantId, resolved);
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
