import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Database, SqlClient } from "../db/database.js";
import { ApiError } from "./errors.js";
import { sourceFailureMessage } from "./sourceError.js";
import type { StaffRole } from "./capabilities.js";

/**
 * Staff identity. This file must not import from portalSession.ts and
 * portalSession.ts must not import from this one — API Contract §1.1: two
 * resolvers, two session stores, no shared code path. A single resolveUser()
 * serving both trees is the shape of the bug that lets a portal token reach a
 * staff route, and it is a bug that reads as tidy refactoring.
 */

export interface StaffSessionRecord {
  tenantId: string;
  staffId: string;
}

export interface StaffSessionStore {
  revokeStaff?(tenantId: string, staffId: string): void;
  /** Resolve a staff session, or null. Never throws for a bad token. */
  resolve(req: Request): Promise<StaffSessionRecord | null>;
}

export interface StaffPrincipal {
  tenantId: string;
  staffId: string;
  email: string;
  fullName: string;
  role: StaffRole;
  businessUnitId: string | null;
}

export interface TenantSettings {
  enforceBusinessUnitScoping: boolean;
  portalUserSoftAlertAt: number | null;
}

export interface StaffContext {
  db: SqlClient;
  staff: StaffPrincipal;
  settings: TenantSettings;
  req: Request;
  res: Response;
}

export interface StaffRouterDeps {
  database: Database;
  sessions: StaffSessionStore;
}

/**
 * The resolved session rides on a module-private symbol rather than a global
 * augmentation of Express's Request. Augmenting Request would put
 * `req.staffSession` on every request object in the process, including the
 * ones the portal tree will serve — which is precisely the confusion §1.1
 * forbids. Nothing outside this file can read or set it.
 */
const STAFF_SESSION = Symbol("staffSession");

type WithStaffSession = Request & { [STAFF_SESSION]?: StaffSessionRecord };

function setStaffSession(req: Request, session: StaffSessionRecord): void {
  (req as WithStaffSession)[STAFF_SESSION] = session;
}

function getStaffSession(req: Request): StaffSessionRecord | undefined {
  return (req as WithStaffSession)[STAFF_SESSION];
}

/**
 * Resolves the session only. The tenant transaction is opened per handler by
 * staffRoute() so that its lifetime is exactly the handler's — a transaction
 * held open across the rest of an Express chain outlives the work it protects.
 */
export function staffAuthentication(
  sessions: StaffSessionStore,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    sessions
      .resolve(req)
      .then((session) => {
        if (!session) {
          next(new ApiError("unauthenticated", "A staff session is required."));
          return;
        }
        setStaffSession(req, session);
        next();
      })
      .catch(next);
  };
}

export async function withStaff<T>(
  deps: StaffRouterDeps,
  req: Request,
  res: Response,
  fn: (ctx: StaffContext) => Promise<T>,
): Promise<T> {
  const session = getStaffSession(req);
  if (!session) {
    throw new ApiError("unauthenticated", "A staff session is required.");
  }
  return deps.database.withTenant(session.tenantId, async (db) => {
    // Entitlement is already enforced by the RLS predicate; every read
    // would simply return nothing. This turns that silence into the honest
    // answer, and it reads the entitlements table, which is tenant-isolated
    // but deliberately not entitlement-gated so a suspended customer can be
    // told why.
    await assertModulesLive(db, session.tenantId);
    const staff = await loadStaff(db, session.staffId);
    const settings = await loadSettings(db, session.tenantId);
    return fn({ db, staff, settings, req, res });
  });
}

export function staffRoute(
  deps: StaffRouterDeps,
  handler: (ctx: StaffContext) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    withStaff(deps, req, res, handler).catch(next);
  };
}

async function assertModulesLive(
  db: SqlClient,
  tenantId: string,
): Promise<void> {
  const { rows } = await db.query<{ module_key: string; state: string }>(
    `SELECT module_key, state FROM projects.entitlements WHERE tenant_id = $1`,
    [tenantId],
  );
  const live = new Set(
    rows
      .filter((r) => ["trial", "active", "past_due"].includes(r.state))
      .map((r) => r.module_key),
  );
  const missing = ["estimating", "projects"].filter((m) => !live.has(m));
  if (missing.length > 0) {
    const states =
      rows.map((r) => `${r.module_key}=${r.state}`).join(", ") ||
      "no entitlements";
    throw new ApiError(
      "module_not_entitled",
      `Journeyman Projects is not active for this account (${states}).`,
      { missing, states: rows },
    );
  }
}

async function loadStaff(
  db: SqlClient,
  staffId: string,
): Promise<StaffPrincipal> {
  const { rows } = await db.query<{
    id: string;
    tenant_id: string;
    email: string;
    full_name: string;
    role: StaffRole;
    business_unit_id: string | null;
    active: boolean;
  }>(
    `SELECT id, tenant_id, email, full_name, role, business_unit_id, active
       FROM projects.staff WHERE id = $1`,
    [staffId],
  );
  const row = rows[0];
  // No row means either the staff member does not exist or RLS filtered them
  // out because they belong to another tenant. Both are 401 here: the session
  // does not resolve to a usable identity, and distinguishing the two would
  // confirm the id is real.
  if (!row || !row.active) {
    throw new ApiError("unauthenticated", "This staff account is not active.");
  }
  return {
    tenantId: row.tenant_id,
    staffId: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    businessUnitId: row.business_unit_id,
  };
}

async function loadSettings(
  db: SqlClient,
  tenantId: string,
): Promise<TenantSettings> {
  const { rows } = await db.query<{
    enforce_business_unit_scoping: boolean;
    portal_user_soft_alert_at: number | null;
  }>(
    `SELECT enforce_business_unit_scoping, portal_user_soft_alert_at
       FROM projects.tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  return {
    enforceBusinessUnitScoping: row?.enforce_business_unit_scoping ?? false,
    portalUserSoftAlertAt: row?.portal_user_soft_alert_at ?? null,
  };
}

/** Authorize before a network read, release the database transaction, then
 * reauthorize before saving. External latency never holds a tenant connection. */
export function staffExternalRoute<P, R>(
  deps: StaffRouterDeps,
  prepare: (ctx: StaffContext) => Promise<P>,
  read: (prepared: P) => Promise<R>,
  apply: (ctx: StaffContext, prepared: P, result: R) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    const run = async () => {
      const session = getStaffSession(req);
      if (!session)
        throw new ApiError("unauthenticated", "A staff session is required.");
      const within = <T>(fn: (ctx: StaffContext) => Promise<T>) =>
        deps.database.withTenant(session.tenantId, async (db) => {
          await assertModulesLive(db, session.tenantId);
          const staff = await loadStaff(db, session.staffId);
          const settings = await loadSettings(db, session.tenantId);
          return fn({ db, staff, settings, req, res });
        });
      const prepared = await within(prepare);
      let result: R;
      try {
        result = await read(prepared);
      } catch (err) {
        console.error(
          `[source-refresh] ${req.method} ${req.originalUrl} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
        throw new ApiError("source_unavailable", sourceFailureMessage(err));
      }
      const current = await deps.sessions.resolve(req);
      if (
        !current ||
        current.tenantId !== session.tenantId ||
        current.staffId !== session.staffId
      )
        throw new ApiError(
          "unauthenticated",
          "Your staff session has expired.",
        );
      await within((ctx) => apply(ctx, prepared, result));
    };
    run().catch(next);
  };
}
