import { Router } from "express";
import {
  staffRoute,
  staffExternalRoute,
  type StaffRouterDeps,
  type StaffContext,
} from "../http/staffSession.js";
import { requireCapability } from "../http/capabilities.js";
import { ApiError } from "../http/errors.js";
import { sendData } from "../http/envelope.js";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import { applyTechnicianDirectory } from "../domain/laborActuals.js";
import { pmCatalog } from "../domain/pmCatalog.js";
export function directoryRoutes(
  deps: StaffRouterDeps,
  sources: SourceConnections = {},
) {
  const router = Router();
  router.get(
    "/planning-catalog",
    staffRoute(deps, async (ctx) => {
      sendData(ctx.res, pmCatalog);
    }),
  );
  async function connection(ctx: StaffContext) {
    const c = sources.serviceTitan;
    if (!c || c.tenantId !== ctx.staff.tenantId || !c.client.readTechnicians)
      throw new ApiError(
        "conflict",
        "ServiceTitan technician connection is not configured for this account.",
      );
    const { rows } = await ctx.db.query(
      "SELECT id FROM projects.external_systems WHERE id=$1 AND active AND adapter_key=$2",
      [c.externalSystemId, "servicetitan"],
    );
    if (!rows.length)
      throw new ApiError(
        "conflict",
        "The ServiceTitan source is inactive or incorrectly configured.",
      );
    return c;
  }
  router.get(
    "/technicians",
    staffRoute(deps, async (ctx) => {
      const c = sources.serviceTitan;
      const configured =
        !!c && c.tenantId === ctx.staff.tenantId && !!c.client.readTechnicians;
      const { rows } = await ctx.db.query(
        `SELECT id,name,source_technician_id,source_observed_at FROM projects.scheduling_resources WHERE active AND source_system_id=$1 AND source_connection_key=$2 ORDER BY name`,
        [configured ? c!.externalSystemId : null, configured ? c!.key : null],
      );
      sendData(ctx.res, { configured, technicians: rows });
    }),
  );
  router.post(
    "/technicians/refresh",
    staffExternalRoute(
      deps,
      async (ctx) => {
        requireCapability(ctx.staff.role, "advance_stage");
        return {
          connection: await connection(ctx),
          startedAt: new Date().toISOString(),
        };
      },
      (p) => p.connection.client.readTechnicians!(),
      async (ctx, p, technicians) => {
        requireCapability(ctx.staff.role, "advance_stage");
        const c = await connection(ctx);
        if (c.key !== p.connection.key)
          throw new ApiError("conflict", "Source changed during refresh.");
        await ctx.db.query(
          "SELECT id FROM projects.external_systems WHERE id=$1 FOR UPDATE",
          [c.externalSystemId],
        );
        const newer = await ctx.db.query(
          "SELECT id FROM projects.scheduling_resources WHERE source_system_id=$1 AND source_observed_at >= $2 LIMIT 1",
          [c.externalSystemId, p.startedAt],
        );
        if (newer.rows.length)
          throw new ApiError(
            "conflict",
            "A newer technician refresh is already saved.",
          );
        await ctx.db.query(
          "UPDATE projects.scheduling_resources SET active=false,source_observed_at=$2 WHERE source_system_id=$1",
          [c.externalSystemId, p.startedAt],
        );
        await applyTechnicianDirectory(
          ctx.db,
          ctx.staff.tenantId,
          {
            read: true,
            forbidden: false,
            technicians: technicians.map((tech) => ({
              id: tech.id,
              name: tech.name,
              active: tech.active,
              hourlyRate: tech.hourlyRate ?? null,
              burdenRate: tech.burdenRate ?? null,
            })),
          },
          new Date(p.startedAt),
        );
        for (const tech of technicians)
          await ctx.db.query(
            `INSERT INTO projects.scheduling_resources(tenant_id,name,kind,active,source_system_id,source_technician_id,source_connection_key,source_observed_at) VALUES($1,$2,'employee',$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,source_system_id,source_technician_id) DO UPDATE SET name=excluded.name,active=excluded.active,source_connection_key=excluded.source_connection_key,source_observed_at=excluded.source_observed_at`,
            [
              ctx.staff.tenantId,
              tech.name,
              tech.active,
              c.externalSystemId,
              tech.id,
              c.key,
              p.startedAt,
            ],
          );
        sendData(ctx.res, {
          active: technicians.filter((t) => t.active).length,
          observedAt: p.startedAt,
        });
      },
    ),
  );
  return router;
}
