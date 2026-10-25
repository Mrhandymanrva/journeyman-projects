import { Router } from "express";
import { z } from "zod";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import {
  portfolioLaborColumns,
  presentPortfolioLabor,
  readLaborJobs,
  stampLaborCodes,
  storeJobLabor,
} from "../domain/laborActuals.js";
import { can, requireCapability } from "../http/capabilities.js";
import { sendData } from "../http/envelope.js";
import { ApiError } from "../http/errors.js";
import {
  staffExternalRoute,
  staffRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import { loadVisibleProject, num, parseBody, parseUuidParam, requireOwnedRow } from "./shared.js";

const settingsSchema = z.object({
  labor_burdened_hourly_rate: z.number().finite().nonnegative().nullable(),
  labor_cost_code_id: z.string().uuid().nullable(),
});

const projectCodeSchema = z.object({
  cost_code_id: z.string().uuid().nullable(),
});

export function laborRoutes(deps: StaffRouterDeps, sources: SourceConnections): Router {
  const router = Router();

  router.get(
    "/settings/labor",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_company_settings");
      sendData(ctx.res, await loadSettings(ctx));
    }),
  );

  router.put(
    "/settings/labor",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_company_settings");
      const body = parseBody(settingsSchema, ctx.req.body);
      if (body.labor_cost_code_id) {
        await requireOwnedRow(ctx.db, "cost_codes", body.labor_cost_code_id, "labor_cost_code_id");
      }
      await ctx.db.query(
        `UPDATE projects.tenant_settings
            SET labor_burdened_hourly_rate = $2, labor_cost_code_id = $3
          WHERE tenant_id = $1`,
        [ctx.staff.tenantId, body.labor_burdened_hourly_rate, body.labor_cost_code_id],
      );
      await stampLaborCodes(ctx.db, ctx.staff.tenantId);
      sendData(ctx.res, await loadSettings(ctx));
    }),
  );

  router.get(
    "/projects/:id/labor",
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      sendData(ctx.res, await presentLabor(ctx, projectId));
    }),
  );

  router.put(
    "/projects/:id/labor-cost-code",
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      requireCapability(ctx.staff.role, "set_labor_cost_code");
      const body = parseBody(projectCodeSchema, ctx.req.body);
      if (body.cost_code_id) {
        await requireOwnedRow(ctx.db, "cost_codes", body.cost_code_id, "cost_code_id");
      }
      await ctx.db.query(
        `UPDATE projects.projects SET labor_cost_code_id = $2 WHERE id = $1`,
        [projectId, body.cost_code_id],
      );
      await stampLaborCodes(ctx.db, ctx.staff.tenantId, projectId);
      sendData(ctx.res, await presentLabor(ctx, projectId));
    }),
  );

  router.post(
    "/projects/:id/labor/refresh",
    staffExternalRoute(
      deps,
      async (ctx) => {
        const projectId = parseUuidParam(ctx.req.params.id, "Project");
        await loadVisibleProject(ctx, projectId, "id");
        requireCapability(ctx.staff.role, "refresh_labor");
        const source = sources.serviceTitan;
        if (!source?.client.readJobTimesheets) {
          throw new ApiError(
            "conflict",
            "ServiceTitan timesheet read is not configured. Existing hours were left as they are.",
          );
        }
        const jobs = await ctx.db.query<{ id: string; external_job_id: string }>(
          `SELECT id, external_job_id FROM projects.project_job_links
            WHERE project_id = $1 AND external_system_id = $2 AND source_active
            ORDER BY external_job_id`,
          [projectId, source.externalSystemId],
        );
        return {
          projectId,
          jobs: jobs.rows,
          readJobTimesheets: (jobId: string) => source.client.readJobTimesheets!(jobId),
          readJob: (jobId: string) => source.client.readJob(jobId),
        };
      },
      async (prepared) =>
        readLaborJobs(
          prepared.jobs.map((job) => job.external_job_id),
          { readJobTimesheets: prepared.readJobTimesheets, readJob: prepared.readJob },
        ),
      async (ctx, prepared, results) => {
        requireCapability(ctx.staff.role, "refresh_labor");
        await loadVisibleProject(ctx, prepared.projectId, "id");
        const observedAt = new Date();
        for (const result of results) {
          const link = prepared.jobs.find((job) => job.external_job_id === result.jobId);
          await storeJobLabor(ctx.db, {
            tenantId: ctx.staff.tenantId,
            projectId: prepared.projectId,
            jobId: result.jobId,
            jobLinkId: link?.id ?? null,
            result,
            observedAt,
          });
        }
        await stampLaborCodes(ctx.db, ctx.staff.tenantId, prepared.projectId);
        sendData(ctx.res, await presentLabor(ctx, prepared.projectId));
      },
    ),
  );

  return router;
}

async function loadSettings(ctx: StaffContext) {
  const { rows } = await ctx.db.query<{
    labor_burdened_hourly_rate: string | null;
    labor_cost_code_id: string | null;
    code: string | null;
    description: string | null;
  }>(
    `SELECT s.labor_burdened_hourly_rate::text, s.labor_cost_code_id, c.code, c.description
       FROM projects.tenant_settings s
       LEFT JOIN projects.cost_codes c ON c.id = s.labor_cost_code_id
      WHERE s.tenant_id = $1`,
    [ctx.staff.tenantId],
  );
  const row = rows[0];
  return {
    labor_burdened_hourly_rate: num(row?.labor_burdened_hourly_rate),
    labor_cost_code_id: row?.labor_cost_code_id ?? null,
    labor_cost_code: row?.code ?? null,
    labor_cost_code_description: row?.description ?? null,
  };
}

async function presentLabor(ctx: StaffContext, projectId: string) {
  const summary = await ctx.db.query<Record<string, unknown>>(
    `SELECT ${portfolioLaborColumns("p")},
            COALESCE(p.labor_cost_code_id, s.labor_cost_code_id) AS effective_code_id,
            c.code AS effective_code, c.description AS effective_description
       FROM projects.projects p
       JOIN projects.tenant_settings s ON s.tenant_id = p.tenant_id
       LEFT JOIN projects.cost_codes c
         ON c.id = COALESCE(p.labor_cost_code_id, s.labor_cost_code_id)
      WHERE p.id = $1`,
    [projectId],
  );
  const labor = presentPortfolioLabor(summary.rows[0] ?? {});
  const showMoney = can(ctx.staff.role, "view_margin");
  const lines = await ctx.db.query<{
    id: string;
    work_date: string;
    hours: string;
    technician_name: string | null;
    source: string;
    external_job_id: string;
  }>(
    `SELECT id, work_date::text, hours::text, technician_name, source, external_job_id
       FROM projects.labor_actuals WHERE project_id = $1
      ORDER BY work_date, technician_name`,
    [projectId],
  );
  return {
    hours: labor.hours,
    uncoded_hours: labor.uncoded_hours,
    source: labor.source,
    observed_at: labor.observed_at,
    ...(showMoney ? { amount: labor.amount, rate: num(summary.rows[0]?.labor_rate) } : {}),
    cost_code: summary.rows[0]?.effective_code
      ? {
          id: summary.rows[0]?.effective_code_id ?? null,
          code: summary.rows[0]?.effective_code,
          description: summary.rows[0]?.effective_description ?? null,
        }
      : null,
    lines: lines.rows.map((line) => ({
      id: line.id,
      work_date: line.work_date,
      hours: num(line.hours),
      technician_name: line.technician_name,
      source: line.source,
      external_job_id: line.external_job_id,
    })),
  };
}
