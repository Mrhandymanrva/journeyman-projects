import { Router } from "express";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import {
  listActiveRateGaps,
  portfolioLaborColumns,
  presentPortfolioLabor,
  readLaborJobs,
  readTechnicianDirectory,
  saveLaborRefresh,
  type PricedTechnician,
} from "../domain/laborActuals.js";
import {
  applyResolvedLaborCode,
  presentStLaborCode,
  readStLaborCode,
  resolveStLaborCode,
} from "../domain/stLaborCode.js";
import { can, requireCapability } from "../http/capabilities.js";
import { sendData } from "../http/envelope.js";
import { ApiError } from "../http/errors.js";
import {
  staffExternalRoute,
  staffRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import { loadVisibleProject, num, parseUuidParam } from "./shared.js";

export function laborRoutes(deps: StaffRouterDeps, sources: SourceConnections): Router {
  const router = Router();

  router.get(
    "/settings/labor",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_company_settings");
      sendData(ctx.res, await loadSettings(ctx, sources.serviceTitan?.client));
    }),
  );

  router.get(
    "/projects/:id/labor",
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      sendData(ctx.res, await presentLabor(ctx, projectId, sources.serviceTitan?.client));
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
          readTechnicians: source.client.readTechnicians?.bind(source.client),
          laborClient: source.client,
        };
      },
      async (prepared) => {
        const jobs = await readLaborJobs(
          prepared.jobs.map((job) => job.external_job_id),
          { readJobTimesheets: prepared.readJobTimesheets, readJob: prepared.readJob },
        );
        const directory = await readTechnicianDirectory({
          readTechnicians: prepared.readTechnicians,
        });
        const laborCode = await resolveStLaborCode(prepared.laborClient);
        return { jobs, directory, laborCode };
      },
      async (ctx, prepared, read) => {
        requireCapability(ctx.staff.role, "refresh_labor");
        await loadVisibleProject(ctx, prepared.projectId, "id");
        await saveLaborRefresh(ctx.db, {
          tenantId: ctx.staff.tenantId,
          projectId: prepared.projectId,
          jobs: prepared.jobs,
          results: read.jobs,
          directory: read.directory,
          source: "manual",
          observedAt: new Date(),
        });
        await applyResolvedLaborCode(ctx.db, ctx.staff.tenantId, read.laborCode);
        sendData(ctx.res, await presentLabor(ctx, prepared.projectId, prepared.laborClient));
      },
    ),
  );

  return router;
}

async function loadSettings(
  ctx: StaffContext,
  client: Parameters<typeof readStLaborCode>[2],
) {
  const shown = presentStLaborCode(
    await readStLaborCode(ctx.db, ctx.staff.tenantId, client),
  );
  return {
    st_labor_code: shown.st_labor_code,
    st_labor_code_error: shown.st_labor_code_error,
    rate_gaps: await listActiveRateGaps(ctx.db, ctx.staff.tenantId),
  };
}

async function presentLabor(
  ctx: StaffContext,
  projectId: string,
  client: Parameters<typeof readStLaborCode>[2],
) {
  const shown = presentStLaborCode(
    await readStLaborCode(ctx.db, ctx.staff.tenantId, client),
  );
  const summary = await ctx.db.query<Record<string, unknown>>(
    `SELECT ${portfolioLaborColumns("p")},
            s.labor_rates_forbidden
       FROM projects.projects p
       JOIN projects.tenant_settings s ON s.tenant_id = p.tenant_id
      WHERE p.id = $1`,
    [projectId],
  );
  const labor = presentPortfolioLabor(summary.rows[0] ?? {});
  const showMoney = can(ctx.staff.role, "view_margin");
  const showRates = can(ctx.staff.role, "view_labor_rates");
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
    hours: labor.labor_hours,
    labor_hours: labor.labor_hours,
    uncoded_hours: labor.uncoded_hours,
    source: labor.source,
    hours_source: labor.hours_source,
    observed_at: labor.observed_at,
    missing: labor.missing,
    rates_forbidden: summary.rows[0]?.labor_rates_forbidden === true,
    ...(showMoney
      ? {
          labor_wage: labor.labor_wage,
          labor_burden: labor.labor_burden,
          total: labor.total,
        }
      : {}),
    ...(showRates ? { rate_gaps: await listActiveRateGaps(ctx.db, ctx.staff.tenantId) } : {}),
    st_labor_code: shown.st_labor_code,
    st_labor_code_error: shown.st_labor_code_error,
    cost_code: shown.st_labor_code
      ? {
          id: shown.costCodeId,
          code: shown.st_labor_code.code,
          description: shown.st_labor_code.name,
        }
      : null,
    technicians: labor.technicians.map((tech) => presentTechnician(tech, showRates)),
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

function presentTechnician(tech: PricedTechnician, showRates: boolean) {
  return {
    external_technician_id: tech.external_technician_id,
    technician_name: tech.technician_name,
    hours: tech.hours,
    missing: tech.missing,
    ...(showRates
      ? {
          hourly_rate: tech.hourly_rate,
          burden_rate: tech.burden_rate,
          wage: tech.wage,
          burden: tech.burden,
          amount: tech.wage === null || tech.burden === null ? null : round2(tech.wage + tech.burden),
        }
      : {}),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
