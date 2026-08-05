import { Router } from 'express';
import { sendData } from '../http/envelope.js';
import { notFound } from '../http/errors.js';
import { staffRoute, type StaffRouterDeps } from '../http/staffSession.js';
import { parseBody, parseUuidParam } from './shared.js';
import {
  deriveBudgetLines,
  estimateImportSchema,
  parseEstimatePayload,
} from '../domain/estimateContract.js';

/**
 * The module boundary. This is the only route that hears from the estimating
 * core, and it hears a snapshot — no join, no foreign key, no query into the
 * estimating schema from anywhere in this file or anything it calls.
 */
export function estimateImportRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.post(
    '/estimate-imports',
    staffRoute(deps, async (ctx) => {
      const body = parseBody(estimateImportSchema, ctx.req.body);

      // Validate before storing. An import that parses is the contract holding;
      // one that does not is rejected loudly rather than kept for later.
      const payload = parseEstimatePayload(body.contract_version, body.payload);

      // Codes are resolved now, at import, not at project creation. The
      // alternative is a stored import that looks fine until someone tries to
      // build a budget from it three days later and gets a validation error
      // pointing at an estimate they cannot edit.
      await deriveBudgetLines(ctx.db, payload);

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `INSERT INTO projects.estimate_imports
           (tenant_id, contract_version, source_kind, source_key, payload)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         RETURNING id, contract_version, source_kind, source_key, received_at`,
        [
          ctx.staff.tenantId,
          body.contract_version,
          body.source_kind,
          body.source_key,
          JSON.stringify(payload),
        ],
      );

      sendData(
        ctx.res,
        {
          ...rows[0],
          sold_price: payload.sold_price,
          currency: payload.currency,
          line_count: payload.lines.length,
        },
        undefined,
        201,
      );
    }),
  );

  router.get(
    '/estimate-imports/:id',
    staffRoute(deps, async (ctx) => {
      const id = parseUuidParam(ctx.req.params.id, 'Estimate import');
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT id, contract_version, source_kind, source_key, payload, received_at
           FROM projects.estimate_imports WHERE id = $1`,
        [id],
      );
      if (!rows[0]) throw notFound('Estimate import not found');
      sendData(ctx.res, rows[0]);
    }),
  );

  return router;
}
