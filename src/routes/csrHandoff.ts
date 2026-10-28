import { Router } from "express";
import {
  acknowledgeHandoff,
  handoffWriteSchema,
  presentHandoff,
  saveHandoff,
} from "../domain/csrHandoff.js";
import { requireCapability } from "../http/capabilities.js";
import { sendData } from "../http/envelope.js";
import { ApiError } from "../http/errors.js";
import { staffRoute, type StaffRouterDeps } from "../http/staffSession.js";
import { loadVisibleProject, parseBody, parseUuidParam } from "./shared.js";

/**
 * CSR hand-off on a project in the Handoff stage.
 * Office can save and submit. The Project Coordinator acknowledges.
 * No email is sent. Command Center is not called. ServiceTitan is not written.
 */
export function csrHandoffRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    "/projects/:id/handoff",
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      sendData(ctx.res, await presentHandoff(ctx.db, projectId));
    }),
  );

  router.put(
    "/projects/:id/handoff",
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      // Visibility before the role check. A foreign id is 404, including for
      // a role that cannot save, so the response does not confirm the row.
      const project = await loadVisibleProject<{ stage: string }>(
        ctx,
        projectId,
        "stage::text AS stage",
      );
      requireCapability(ctx.staff.role, "save_csr_handoff");
      if (project.stage !== "handoff") {
        throw new ApiError(
          "conflict",
          "The CSR hand-off form is on projects in the Handoff stage.",
          { stage: project.stage },
        );
      }
      const body = parseBody(handoffWriteSchema, ctx.req.body);
      sendData(
        ctx.res,
        await saveHandoff(
          ctx.db,
          projectId,
          ctx.staff.tenantId,
          ctx.staff.staffId,
          body,
        ),
      );
    }),
  );

  router.post(
    "/projects/:id/handoff/acknowledge",
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      requireCapability(ctx.staff.role, "acknowledge_csr_handoff");
      sendData(
        ctx.res,
        await acknowledgeHandoff(ctx.db, projectId, ctx.staff.staffId),
      );
    }),
  );

  return router;
}
