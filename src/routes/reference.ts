import { Router } from 'express';
import { sendData } from '../http/envelope.js';
import { staffRoute, type StaffRouterDeps } from '../http/staffSession.js';
import { parsePagination } from './shared.js';

/**
 * The lists a form has to offer before someone can fill it in — cost codes and
 * business units. Read-only, tenant-scoped by RLS like everything else.
 *
 * Cost codes are a copy of the shipped library made at activation, so a
 * tenant's edits never touch another tenant's list. That is why this reads
 * cost_codes and not cost_code_library: the library is product content and
 * would be the same for everyone.
 */
export function referenceRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    '/cost-codes',
    staffRoute(deps, async (ctx) => {
      const { perPage, offset } = parsePagination({
        per_page: 500,
        ...(ctx.req.query as Record<string, unknown>),
      });
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT id, code, division_code, division_name, description,
                default_cost_type::text AS default_cost_type, ledger_account, active
           FROM projects.cost_codes
          WHERE ($1::bool IS NULL OR active = $1::bool)
          ORDER BY sort_order, code
          LIMIT $2 OFFSET $3`,
        [ctx.req.query.active === 'false' ? false : true, perPage, offset],
      );
      sendData(ctx.res, rows);
    }),
  );

  router.get(
    '/business-units',
    staffRoute(deps, async (ctx) => {
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT id, name, code, active FROM projects.business_units
          WHERE active ORDER BY name`,
      );
      sendData(ctx.res, rows);
    }),
  );

  router.get(
    '/staff',
    staffRoute(deps, async (ctx) => {
      // Names and roles only. This populates "who is the PM" pickers, and a
      // staff directory is not the place to hand out email addresses to every
      // role that can open a form.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT id, full_name, role::text AS role, business_unit_id
           FROM projects.staff WHERE active ORDER BY full_name`,
      );
      sendData(ctx.res, rows);
    }),
  );

  return router;
}
