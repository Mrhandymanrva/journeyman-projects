import { Router } from "express";
import { requireCapability } from "../http/capabilities.js";
import { sendData } from "../http/envelope.js";
import { ApiError } from "../http/errors.js";
import { staffRoute, type StaffRouterDeps } from "../http/staffSession.js";
import { newYorkDate } from "../domain/fieldStart.js";
import { writeHealthSnapshots } from "../workers/healthSnapshot.js";

/**
 * POST /api/v1/projects/health-snapshots/run
 * Owner only. Replaces today's New York rows from local tables.
 * The portfolio token is not a staff session, so it cannot call this.
 */
export function healthSnapshotRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.post(
    "/health-snapshots/run",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "run_health_snapshots");
      const today = newYorkDate(new Date().toISOString());
      const result = await writeHealthSnapshots(ctx.db, { today, replace: true });
      if (result.skipped === "locked") {
        throw new ApiError("conflict", "A health snapshot is already running.");
      }
      sendData(ctx.res, { snapshot_on: today, written: result.written });
    }),
  );

  return router;
}
