import { Router } from "express";
import { z } from "zod";
import {
  staffRoute,
  staffExternalRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import { can, requireCapability } from "../http/capabilities.js";
import { ApiError } from "../http/errors.js";
import { sendData } from "../http/envelope.js";
import {
  assertUnitWritable,
  requireOwnedRow,
  loadVisibleProject,
  parseBody,
  parseUuidParam,
} from "./shared.js";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import { createProject } from "./projects.js";
import type { ServiceTitanReadAdapter } from "../adapters/serviceTitan.js";
type Details = Awaited<
  ReturnType<ServiceTitanReadAdapter["readProjectDetails"]>
>;
export function stProjectRoutes(
  deps: StaffRouterDeps,
  sources: SourceConnections = {},
) {
  const router = Router();
  async function binding(ctx: StaffContext) {
    const c = sources.serviceTitan;
    if (
      !c ||
      c.tenantId !== ctx.staff.tenantId ||
      !c.client.listProjects ||
      !c.client.readProjectDetails
    )
      throw new ApiError(
        "conflict",
        "ServiceTitan project connector is not configured for this account.",
      );
    const r = await ctx.db.query(
      "SELECT id FROM projects.external_systems WHERE id=$1 AND active AND adapter_key='servicetitan'",
      [c.externalSystemId],
    );
    if (!r.rows.length)
      throw new ApiError("conflict", "ServiceTitan source is inactive.");
    return c;
  }
  async function applySource(
    ctx: StaffContext,
    id: string,
    c: NonNullable<SourceConnections["serviceTitan"]>,
    result: Details,
  ) {
    await ctx.db.query(
      "SELECT id FROM projects.projects WHERE id=$1 FOR UPDATE",
      [id],
    );
    const prior = await ctx.db.query<{
      external_project_id: string;
      connection_key: string;
      observed_at: string;
    }>(
      "SELECT external_project_id,connection_key,observed_at FROM projects.st_project_connections WHERE project_id=$1",
      [id],
    );
    if (
      prior.rows[0] &&
      (prior.rows[0].external_project_id !== result.project.id ||
        prior.rows[0].connection_key !== c.key)
    )
      throw new ApiError(
        "conflict",
        "This PM project is already connected to another ST project. Its existing association was preserved.",
      );
    if (
      prior.rows[0] &&
      new Date(prior.rows[0].observed_at) >= new Date(result.observedAt)
    )
      throw new ApiError(
        "conflict",
        "A newer ST snapshot has already been saved.",
      );
    const duplicate = await ctx.db.query(
      "SELECT project_id FROM projects.st_project_connections WHERE external_system_id=$1 AND external_project_id=$2 AND project_id<>$3",
      [c.externalSystemId, result.project.id, id],
    );
    if (duplicate.rows.length)
      throw new ApiError(
        "conflict",
        "That ST project is already connected to another PM project.",
      );
    const conflicting = await ctx.db.query(
      "SELECT id FROM projects.project_job_links WHERE external_system_id=$1 AND external_job_id=ANY($2::text[]) AND project_id<>$3",
      [c.externalSystemId, result.project.jobIds, id],
    );
    if (conflicting.rows.length)
      throw new ApiError(
        "conflict",
        "An ST job is already linked to another PM project. Resolve that link before connecting this project.",
      );
    await ctx.db.query(
      `INSERT INTO projects.st_project_connections(project_id,tenant_id,external_system_id,external_project_id,connection_key,snapshot,observed_at,linked_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(project_id) DO UPDATE SET snapshot=excluded.snapshot,observed_at=excluded.observed_at`,
      [
        id,
        ctx.staff.tenantId,
        c.externalSystemId,
        result.project.id,
        c.key,
        JSON.stringify({
          ...result.project,
          customer: result.customer,
          location: result.location,
        }),
        result.observedAt,
        ctx.staff.staffId,
      ],
    );

    const a = result.location.address;
    await ctx.db.query(
      `UPDATE projects.projects SET project_number=$2,name=$3,address_line1=$4,city=$5,region=$6,postal_code=$7,external_system_id=$8,external_customer_id=$9,scheduled_start=$10,scheduled_end=$11,source_customer_name=$12,source_location_name=$13,source_project_status=$14,source_project_summary=$15 WHERE id=$1`,
      [
        id,
        result.project.number,
        result.project.name || "ST project " + result.project.number,
        [a.street, a.unit].filter(Boolean).join(" "),
        a.city,
        a.state,
        a.zip,
        c.externalSystemId,
        result.customer.id,
        result.project.startDate?.slice(0, 10) || null,
        result.project.targetCompletionDate?.slice(0, 10) || null,
        result.customer.name,
        result.location.name,
        result.project.status ?? null,
        result.project.summary ?? null,
      ],
    );
    await ctx.db.query(
      "UPDATE projects.project_job_links SET source_managed=true,source_active=false WHERE project_id=$1 AND external_system_id=$2",
      [id, c.externalSystemId],
    );
    for (const job of result.jobs) {
      const linked = await ctx.db.query(
        `INSERT INTO projects.project_job_links(tenant_id,project_id,external_system_id,external_job_id,title,source_managed,source_active,source_job_number,source_job_status,source_summary) VALUES($1,$2,$3,$4,$5,true,true,$6,$7,$8) ON CONFLICT(tenant_id,external_system_id,external_job_id) DO UPDATE SET title=excluded.title,source_managed=true,source_active=true,source_job_number=excluded.source_job_number,source_job_status=excluded.source_job_status,source_summary=excluded.source_summary WHERE project_job_links.project_id=excluded.project_id RETURNING id`,
        [
          ctx.staff.tenantId,
          id,
          c.externalSystemId,
          job.id,
          "Job " + job.jobNumber,
          job.jobNumber,
          job.jobStatus,
          job.summary ?? null,
        ],
      );
      if (!linked.rows.length)
        throw new ApiError(
          "conflict",
          "An ST job was linked elsewhere during refresh. No changes were saved.",
        );
    }
  }
  router.post(
    "/servicetitan/projects/import",
    staffExternalRoute(
      deps,
      async (ctx) => {
        requireCapability(ctx.staff.role, "create_project");
        const b = parseBody(
          z
            .object({
              external_project_id: z.string().regex(/^\d+$/),
              business_unit_id: z.string().uuid().nullish(),
            })
            .strict(),
          ctx.req.body,
        );
        if (ctx.settings.enforceBusinessUnitScoping && !b.business_unit_id)
          throw new ApiError(
            "validation_failed",
            "Choose a business unit for this project.",
          );
        assertUnitWritable(ctx, b.business_unit_id ?? null);
        await requireOwnedRow(
          ctx.db,
          "business_units",
          b.business_unit_id,
          "business_unit_id",
        );
        return { b, c: await binding(ctx) };
      },
      (p) => p.c.client.readProjectDetails!(p.b.external_project_id),
      async (ctx, p, result) => {
        requireCapability(ctx.staff.role, "create_project");
        if(ctx.settings.enforceBusinessUnitScoping&&!p.b.business_unit_id)throw new ApiError("validation_failed","Choose a business unit for this project.");
        assertUnitWritable(ctx, p.b.business_unit_id ?? null);
        await requireOwnedRow(
          ctx.db,
          "business_units",
          p.b.business_unit_id,
          "business_unit_id",
        );
        const c = await binding(ctx);
        if (c.key !== p.c.key || c.externalSystemId !== p.c.externalSystemId)
          throw new ApiError("conflict", "ST connection changed; try again.");
        // Serialize imports of the same source record, including the initial creation.
        await ctx.db.query(
          "SELECT id FROM projects.external_systems WHERE id=$1 FOR UPDATE",
          [c.externalSystemId],
        );
        const existing = await ctx.db.query<{ project_id: string }>(
          "SELECT project_id FROM projects.st_project_connections WHERE external_system_id=$1 AND external_project_id=$2",
          [c.externalSystemId, result.project.id],
        );
        let id = existing.rows[0]?.project_id;
        if (id) await loadVisibleProject(ctx, id, "id");
        else {
          const a = result.location.address;
          const created = await createProject(ctx, {
            project_number: result.project.number,
            name: result.project.name || "ST project " + result.project.number,
            address_line1: [a.street, a.unit].filter(Boolean).join(" "),
            city: a.city,
            region: a.state,
            postal_code: a.zip,
            external_system_id: c.externalSystemId,
            external_customer_id: result.customer.id,
            business_unit_id: p.b.business_unit_id ?? null,
            contract_value: null,
            target_margin: null,
            currency: "USD",
            source_kind: "external",
          });
          id = created.id as string;
        }
        await applySource(ctx, id, c, result);
        sendData(
          ctx.res,
          { id, project: result.project, linkedJobs: result.jobs.length },
          undefined,
          existing.rows.length ? 200 : 201,
        );
      },
    ),
  );
  router.get(
    "/servicetitan/projects",
    staffExternalRoute(
      deps,
      async (ctx) => {
        if(!can(ctx.staff.role,"create_project"))requireCapability(ctx.staff.role, "advance_stage");
        const c = await binding(ctx);
        const q = parseBody(
          z.object({
            page: z.coerce.number().int().min(1).max(10000).default(1),
            number: z.string().max(100).optional(),
          }),
          ctx.req.query,
        );
        return { c, q };
      },
      (p) => p.c.client.listProjects!(p.q.page, p.q.number),
      async (ctx, _p, result) => {
        if(!can(ctx.staff.role,"create_project"))requireCapability(ctx.staff.role, "advance_stage");
        await binding(ctx);
        sendData(ctx.res, result);
      },
    ),
  );
  router.get(
    "/projects/:id/servicetitan",
    staffRoute(deps, async (ctx) => {
      const id = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, id, "id");
      const r = await ctx.db.query(
        "SELECT external_project_id,external_system_id,connection_key,snapshot,observed_at FROM projects.st_project_connections WHERE project_id=$1",
        [id],
      );
      let configured = false;
      try {
        await binding(ctx);
        configured = true;
      } catch {}
      const c = sources.serviceTitan;
      sendData(ctx.res, {
        configured,
        connection: r.rows[0] ?? null,
        connectionMatches:
          !!r.rows[0] &&
          r.rows[0].connection_key === c?.key &&
          r.rows[0].external_system_id === c?.externalSystemId,
      });
    }),
  );
  router.post(
    "/projects/:id/servicetitan",
    staffExternalRoute(
      deps,
      async (ctx) => {
        requireCapability(ctx.staff.role, "advance_stage");
        const id = parseUuidParam(ctx.req.params.id, "Project");
        await loadVisibleProject(ctx, id, "id");
        const b = parseBody(
          z.object({ external_project_id: z.string().regex(/^\d+$/) }).strict(),
          ctx.req.body,
        );
        const c = await binding(ctx);
        return { id, b, c };
      },
      (p) => p.c.client.readProjectDetails!(p.b.external_project_id),
      async (ctx, p, result) => {
        requireCapability(ctx.staff.role, "advance_stage");
        await loadVisibleProject(ctx, p.id, "id");
        const c = await binding(ctx);
        if (c.key !== p.c.key || c.externalSystemId !== p.c.externalSystemId)
          throw new ApiError(
            "conflict",
            "ServiceTitan connection changed; refresh before linking.",
          );
        await applySource(ctx, p.id, c, result);
        sendData(ctx.res, {
          project: result.project,
          observedAt: result.observedAt,
          linkedJobs: result.project.jobIds.length,
        });
      },
    ),
  );
  return router;
}
