import { z } from 'zod';
import type { SqlClient } from '../db/database.js';
import { ApiError, notFound, validationFailed } from '../http/errors.js';
import { unitFilter } from '../http/capabilities.js';
import type { StaffContext } from '../http/staffSession.js';

export const uuid = z.string().uuid();

export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw validationFailed(
      result.error.issues.map((i) => ({
        field: i.path.join('.') || '(root)',
        message: i.message,
      })),
    );
  }
  return result.data;
}

export function parseUuidParam(value: string | undefined, what: string): string {
  // A malformed uuid is not_found rather than validation_failed: `/projects/x`
  // and `/projects/<someone-else's-uuid>` should be indistinguishable, and a
  // 400 on one of them is a signal that the other is well-formed.
  if (!value || !uuid.safeParse(value).success) throw notFound(`${what} not found`);
  return value;
}

/** numeric(14,2) arrives from node-postgres as a string. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface Pagination {
  page: number;
  perPage: number;
  offset: number;
}

export function parsePagination(query: Record<string, unknown>): Pagination {
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const perPage = Math.min(200, Math.max(1, Number(query.per_page ?? 50) || 50));
  return { page, perPage, offset: (page - 1) * perPage };
}

/**
 * Loads a project the caller is allowed to see, or throws not_found.
 *
 * Tenancy is RLS's job and is not mentioned here. Business unit scoping is
 * this function's job (§2.2) — it is a visibility preference inside one
 * tenant, so it lives in the API. Both a wrong-tenant id and an out-of-unit id
 * come back as not_found; the caller cannot tell them apart, which is correct
 * for the first and adequate for the second.
 */
export async function loadVisibleProject<R = Record<string, unknown>>(
  ctx: StaffContext,
  projectId: string,
  columns = '*',
): Promise<R> {
  const scope = unitFilter(ctx.staff.businessUnitId, ctx.settings.enforceBusinessUnitScoping);
  const { rows } = await ctx.db.query<R>(
    `SELECT ${columns} FROM projects.projects
      WHERE id = $1
        AND ($2::uuid IS NULL OR business_unit_id IS NULL OR business_unit_id = $2::uuid)`,
    [projectId, scope],
  );
  const row = rows[0];
  if (!row) throw notFound('Project not found');
  return row;
}

/**
 * A staff member confined to one business unit may not put a row into another
 * one. Checked on write as well as read (§2.2), because a scoped list plus an
 * unscoped write is a scoping rule that only holds until someone sends a PATCH.
 */
export function assertUnitWritable(ctx: StaffContext, targetUnitId: string | null | undefined): void {
  const scope = unitFilter(ctx.staff.businessUnitId, ctx.settings.enforceBusinessUnitScoping);
  if (scope === null) return;
  if (targetUnitId === undefined) return;
  if (targetUnitId !== scope) {
    throw new ApiError('forbidden', 'You cannot place a project in another business unit.', {
      business_unit_id: targetUnitId,
    });
  }
}

/**
 * Tables a request may name by id in a body field.
 *
 * No foreign key in this schema carries a tenant_id, so the database will
 * happily let a project in tenant A point at tenant B's business unit or
 * jurisdiction. RLS stops anyone reading across that pointer, but it does not
 * stop the pointer being written, and a row that references another tenant is
 * a cross-tenant join waiting for the first person who writes one.
 *
 * The check is one query per referenced id, and it is generic on purpose: a
 * per-field check is a check that gets forgotten the next time a nullable
 * reference is added to a request body.
 */
const REFERENCEABLE = {
  staff: 'projects.staff',
  business_units: 'projects.business_units',
  jurisdictions: 'projects.jurisdictions',
  external_systems: 'projects.external_systems',
  cost_codes: 'projects.cost_codes',
  vendors: 'projects.vendors',
} as const;

export type ReferenceableTable = keyof typeof REFERENCEABLE;

/**
 * Asserts the id names a row this tenant can see. RLS supplies the tenancy —
 * the query has no tenant_id in it and must not grow one, because the moment
 * it does, the check is testing the handler's idea of the tenant rather than
 * the session's.
 */
export async function requireOwnedRow(
  db: SqlClient,
  table: ReferenceableTable,
  id: string | null | undefined,
  field: string,
  extraPredicate = '',
): Promise<void> {
  if (id === null || id === undefined) return;
  const { rows } = await db.query(
    `SELECT 1 FROM ${REFERENCEABLE[table]} WHERE id = $1 ${extraPredicate}`,
    [id],
  );
  if (rows.length === 0) {
    // validation_failed, not not_found: the request is malformed with respect
    // to this account's data, and the field it is wrong about is nameable.
    // The caller still cannot learn whether the id exists somewhere else.
    throw validationFailed([
      { field, message: `No such ${table.replace(/_/g, ' ').replace(/s$/, '')} in this account` },
    ]);
  }
}

export async function requireStaffOfTenant(
  db: SqlClient,
  staffId: string | null | undefined,
  field: string,
): Promise<void> {
  await requireOwnedRow(db, 'staff', staffId, field, 'AND active');
}
