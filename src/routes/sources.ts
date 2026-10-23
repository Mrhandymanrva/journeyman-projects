import { Router } from "express";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import {
  staffRoute,
  staffExternalRoute,
  type StaffRouterDeps,
  type StaffContext,
} from "../http/staffSession.js";
import { requireCapability } from "../http/capabilities.js";
import { ApiError, notFound } from "../http/errors.js";
import { sendData } from "../http/envelope.js";
import { loadVisibleProject, parseUuidParam } from "./shared.js";

export function sourceRoutes(
  deps: StaffRouterDeps,
  connections: SourceConnections = {},
): Router {
  const router = Router();
  async function job(ctx: StaffContext) {
    const projectId = parseUuidParam(ctx.req.params.id, "Project");
    const jobId = parseUuidParam(ctx.req.params.jobId, "Job");
    await loadVisibleProject(ctx, projectId, "id");
    const { rows } = await ctx.db.query<{
      id: string;
      external_system_id: string;
      external_job_id: string;
    }>(
      `SELECT j.id,j.external_system_id,j.external_job_id FROM projects.project_job_links j JOIN projects.external_systems e ON e.id=j.external_system_id WHERE j.id=$1 AND j.project_id=$2 AND e.active`,
      [jobId, projectId],
    );
    if (!rows[0]) throw notFound("Job link not found");
    return { ...rows[0], projectId };
  }
  function stConnection(ctx: StaffContext, systemId: string) {
    const c = connections.serviceTitan;
    if (
      !c ||
      c.tenantId !== ctx.staff.tenantId ||
      c.externalSystemId !== systemId
    )
      throw new ApiError(
        "conflict",
        "ServiceTitan is not configured for this job link.",
      );
    return c;
  }
  async function poConnection(ctx: StaffContext) {
    requireCapability(ctx.staff.role, "view_margin");
    // Unallocated purchases have no business-unit ownership; restricted users
    // must not see the account-wide financial inbox.
    if (ctx.settings.enforceBusinessUnitScoping && ctx.staff.businessUnitId)
      throw new ApiError(
        "forbidden",
        "The reconciliation inbox requires account-wide access.",
      );
    const c = connections.reconciliation;
    if (!c || c.tenantId !== ctx.staff.tenantId)
      throw new ApiError(
        "conflict",
        "The reconciliation connection is not configured for this account.",
      );
    const { rows } = await ctx.db.query(
      "SELECT id FROM projects.external_systems WHERE id=$1 AND active",
      [c.externalSystemId],
    );
    if (!rows.length)
      throw new ApiError("conflict", "The reconciliation source is inactive.");
    return c;
  }
  router.get(
    "/projects/:id/jobs/:jobId/dispatch",
    staffRoute(deps, async (ctx) => {
      const j = await job(ctx);
      const c = connections.serviceTitan;
      const configured =
        !!c &&
        c.tenantId === ctx.staff.tenantId &&
        c.externalSystemId === j.external_system_id;
      const { rows } = await ctx.db.query(
        "SELECT observed_at,payload FROM projects.dispatch_snapshots WHERE job_link_id=$1 AND connection_key=$2",
        [j.id, configured ? c!.key : ""],
      );
      sendData(ctx.res, { configured, snapshot: rows[0] ?? null });
    }),
  );
  router.post(
    "/projects/:id/jobs/:jobId/dispatch/refresh",
    staffExternalRoute(
      deps,
      async (ctx) => {
        requireCapability(ctx.staff.role, "advance_stage");
        const j = await job(ctx);
        const c = stConnection(ctx, j.external_system_id);
        return { j, c, startedAt: new Date().toISOString() };
      },
      (p) => p.c.client.readJob(p.j.external_job_id),
      async (ctx, p, result) => {
        requireCapability(ctx.staff.role, "advance_stage");
        const j = await job(ctx);
        const c = stConnection(ctx, j.external_system_id);
        if (c.key !== p.c.key || j.external_job_id !== p.j.external_job_id)
          throw new ApiError(
            "conflict",
            "The source changed during refresh. Retry.",
          );
        const { rows } = await ctx.db.query(
          `INSERT INTO projects.dispatch_snapshots (tenant_id,project_id,job_link_id,connection_key,observed_at,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
   ON CONFLICT(job_link_id) DO UPDATE SET connection_key=excluded.connection_key,observed_at=excluded.observed_at,payload=excluded.payload
   WHERE dispatch_snapshots.observed_at < excluded.observed_at RETURNING observed_at,payload`,
          [
            ctx.staff.tenantId,
            j.projectId,
            j.id,
            c.key,
            p.startedAt,
            JSON.stringify(result),
          ],
        );
        if (!rows.length)
          throw new ApiError("conflict", "A newer refresh is already saved.");
        sendData(ctx.res, { configured: true, snapshot: rows[0] });
      },
    ),
  );
  router.get(
    "/reconciliation-inbox",
    staffRoute(deps, async (ctx) => {
      const c = await poConnection(ctx);
      const { rows } = await ctx.db.query(
        "SELECT observed_at,payload FROM projects.reconciliation_snapshots WHERE external_system_id=$1 AND connection_key=$2",
        [c.externalSystemId, c.key],
      );
      sendData(ctx.res, {
        snapshot: rows[0] ?? null,
        accountingEffect: "none",
        coverage: "PO app purchase feed; not the complete QuickBooks ledger",
      });
    }),
  );
  router.post(
    "/reconciliation-inbox/refresh",
    staffExternalRoute(
      deps,
      async (ctx) => {
        const c = await poConnection(ctx);
        requireCapability(ctx.staff.role, "export_cost_data");
        return { c, startedAt: new Date().toISOString() };
      },
      (p) => p.c.client.read(),
      async (ctx, p, result) => {
        const c = await poConnection(ctx);
        requireCapability(ctx.staff.role, "export_cost_data");
        if (c.key !== p.c.key)
          throw new ApiError(
            "conflict",
            "The source changed during refresh. Retry.",
          );
        const { rows } = await ctx.db.query(
          `INSERT INTO projects.reconciliation_snapshots(tenant_id,external_system_id,connection_key,observed_at,payload) VALUES ($1,$2,$3,$4,$5::jsonb)
   ON CONFLICT(tenant_id,external_system_id) DO UPDATE SET connection_key=excluded.connection_key,observed_at=excluded.observed_at,payload=excluded.payload
   WHERE reconciliation_snapshots.observed_at < excluded.observed_at AND (reconciliation_snapshots.connection_key <> excluded.connection_key OR (reconciliation_snapshots.payload->>'revision')::bigint <= (excluded.payload->>'revision')::bigint)
   RETURNING observed_at,payload`,
          [
            ctx.staff.tenantId,
            c.externalSystemId,
            c.key,
            p.startedAt,
            JSON.stringify(result),
          ],
        );
        if (!rows.length)
          throw new ApiError(
            "conflict",
            "An equal-time, newer or higher-revision snapshot is already saved.",
          );
        sendData(ctx.res, { snapshot: rows[0], accountingEffect: "none" });
      },
    ),
  );
  return router;
}
