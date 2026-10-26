import { Router } from "express";
import { loadNewHandoffs } from "../domain/csrHandoff.js";
import { newYorkDate } from "../domain/fieldStart.js";
import { loadDueItems, loadHomeBoard, parseHomeFilters } from "../domain/homeBoard.js";
import { unitFilter } from "../http/capabilities.js";
import { sendData } from "../http/envelope.js";
import { staffRoute, type StaffRouterDeps } from "../http/staffSession.js";

/**
 * Read-only home board. Same staff session and business-unit visibility as
 * GET /projects. Nothing here writes, and ServiceTitan is not called.
 */
export function homeRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    "/home/due",
    staffRoute(deps, async (ctx) => {
      const scope = unitFilter(
        ctx.staff.businessUnitId,
        ctx.settings.enforceBusinessUnitScoping,
      );
      const today = newYorkDate(new Date().toISOString());
      const items = await loadDueItems(ctx.db, scope, today);
      sendData(ctx.res, { today, items });
    }),
  );

  router.get(
    "/home/handoffs",
    staffRoute(deps, async (ctx) => {
      const scope = unitFilter(
        ctx.staff.businessUnitId,
        ctx.settings.enforceBusinessUnitScoping,
      );
      sendData(ctx.res, await loadNewHandoffs(ctx.db, scope));
    }),
  );

  router.get(
    "/home",
    staffRoute(deps, async (ctx) => {
      const filters = parseHomeFilters(ctx.req.query as Record<string, unknown>);
      const scope = unitFilter(
        ctx.staff.businessUnitId,
        ctx.settings.enforceBusinessUnitScoping,
      );
      const today = newYorkDate(new Date().toISOString());
      const board = await loadHomeBoard(ctx.db, scope, filters, today);
      sendData(ctx.res, board);
    }),
  );

  return router;
}
