import { Router } from 'express';
import { sendData } from '../http/envelope.js';
import { staffRoute, type StaffRouterDeps } from '../http/staffSession.js';
import { CAPABILITIES, type Capability } from '../http/capabilities.js';

/**
 * Who am I, what account is this, and what am I allowed to do.
 *
 * The capability list is served rather than reimplemented in the client. A UI
 * that decides for itself which buttons a bookkeeper sees will disagree with
 * the server eventually, and the way you find out is a user clicking something
 * that 403s.
 */
export function sessionRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    '/session',
    staffRoute(deps, async (ctx) => {
      const tenant = await ctx.db.query<{ display_name: string; slug: string }>(
        `SELECT display_name, slug FROM projects.tenants WHERE id = $1`,
        [ctx.staff.tenantId],
      );

      const entitlements = await ctx.db.query<{ module_key: string; state: string }>(
        `SELECT module_key, state::text AS state FROM projects.entitlements
          WHERE tenant_id = $1 ORDER BY module_key`,
        [ctx.staff.tenantId],
      );

      const unit = ctx.staff.businessUnitId
        ? await ctx.db.query<{ name: string }>(
            `SELECT name FROM projects.business_units WHERE id = $1`,
            [ctx.staff.businessUnitId],
          )
        : null;

      const capabilities = (Object.keys(CAPABILITIES) as Capability[]).filter((c) =>
        (CAPABILITIES[c] as readonly string[]).includes(ctx.staff.role),
      );

      sendData(ctx.res, {
        tenant: {
          // The tenants row is a local projection of platform tenancy, and the
          // display name is what the masthead reads — no customer name is
          // compiled into this module anywhere.
          display_name: tenant.rows[0]?.display_name ?? 'Projects',
          slug: tenant.rows[0]?.slug ?? null,
        },
        staff: {
          id: ctx.staff.staffId,
          email: ctx.staff.email,
          full_name: ctx.staff.fullName,
          role: ctx.staff.role,
          business_unit_id: ctx.staff.businessUnitId,
          business_unit_name: unit?.rows[0]?.name ?? null,
        },
        settings: {
          enforce_business_unit_scoping: ctx.settings.enforceBusinessUnitScoping,
        },
        entitlements: entitlements.rows,
        capabilities,
      });
    }),
  );

  return router;
}
