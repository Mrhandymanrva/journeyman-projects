import { Router } from "express";
import { z } from "zod";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import {
  listActiveRateGaps,
  portfolioLaborColumns,
  presentPortfolioLabor,
  readLaborJobs,
  readTechnicianDirectory,
  saveLaborRefresh,
  stampLaborCodes,
  type PricedTechnician,
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
            SET labor_cost_code_id = $2
          WHERE tenant_id = $1`,
        [ctx.staff.tenantId, body.labor_cost_code_id],
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
          readTechnicians: source.client.readTechnicians?.bind(source.client),
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
        return { jobs, directory };
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
        sendData(ctx.res, await presentLabor(ctx, prepared.projectId));
      },
    ),
  );

  return router;
}

async function loadSettings(ctx: StaffContext) {
  const { rows } = await ctx.db.query<{
    labor_cost_code_id: string | null;
    code: string | null;
    description: string | null;
  }>(
    `SELECT s.labor_cost_code_id, c.code, c.description
       FROM projects.tenant_settings s
       LEFT JOIN projects.cost_codes c ON c.id = s.labor_cost_code_id
      WHERE s.tenant_id = $1`,
    [ctx.staff.tenantId],
  );
  const row = rows[0];
  return {
    labor_cost_code_id: row?.labor_cost_code_id ?? null,
    labor_cost_code: row?.code ?? null,
    labor_cost_code_description: row?.description ?? null,
    rate_gaps: await listActiveRateGaps(ctx.db, ctx.staff.tenantId),
  };
}

async function presentLabor(ctx: StaffContext, projectId: string) {
  const summary = await ctx.db.query<Record<string, unknown>>(
    `SELECT ${portfolioLaborColumns("p")},
            s.labor_rates_forbidden,
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
    cost_code: summary.rows[0]?.effective_code
      ? {
          id: summary.rows[0]?.effective_code_id ?? null,
          code: summary.rows[0]?.effective_code,
          description: summary.rows[0]?.effective_description ?? null,
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
