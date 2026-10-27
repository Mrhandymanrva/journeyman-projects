import { Router } from "express";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import { z } from "zod";
import { runCommissionProbe } from "../domain/commissionProbe.js";
import {
  listActiveRateGaps,
  listBurdenNotices,
  portfolioLaborColumns,
  presentPortfolioLabor,
  readBillableRate,
  updateBillableRate,
  type PricedTechnician,
} from "../domain/laborActuals.js";
import { readStoredProjectMoney, readStoredReconciliation, reconciliationNote } from "../domain/projectSync.js";
import {
  presentStLaborCode,
  readStLaborCode,
  resolveStLaborCode,
} from "../domain/stLaborCode.js";
import { refreshLinkedProject } from "../workers/laborRefresh.js";
import { can, requireCapability } from "../http/capabilities.js";
import { sendData } from "../http/envelope.js";
import { ApiError } from "../http/errors.js";
import {
  staffExternalRoute,
  staffRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import { loadVisibleProject, num, parseBody, parseUuidParam } from "./shared.js";

export function laborRoutes(deps: StaffRouterDeps, sources: SourceConnections): Router {
  const router = Router();

  router.get(
    "/settings/labor",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_company_settings");
      sendData(ctx.res, await loadSettings(ctx, sources.serviceTitan?.client));
    }),
  );

  router.put(
    "/settings/labor/billable-rate",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_company_settings");
      const body = parseBody(
        z.object({
          labor_billable_rate: z.number().finite().gte(0).lte(100000),
        }),
        ctx.req.body,
      );
      await updateBillableRate(ctx.db, ctx.staff.tenantId, body.labor_billable_rate);
      sendData(ctx.res, await loadSettings(ctx, sources.serviceTitan?.client));
    }),
  );

  router.get(
    "/settings/labor/commission-probe",
    staffExternalRoute(
      deps,
      async (ctx) => {
        if (ctx.staff.role !== "owner") {
          throw new ApiError("forbidden", "Only an owner can run the commission probe.");
        }
        const raw = ctx.req.query.technician_id;
        const ids = (Array.isArray(raw) ? raw : raw ? [raw] : [])
          .map((value) => String(value).trim())
          .filter((value) => value.length > 0);
        if (ids.some((id) => !/^\d+$/.test(id))) {
          throw new ApiError("validation_failed", "Technician ids must be numeric.");
        }
        const client = sources.serviceTitan?.client;
        if (!client?.readAllowlistedGet || client.sourceTenantId == null) {
          throw new ApiError(
            "conflict",
            "ServiceTitan is not configured for this account. Nothing was read.",
          );
        }
        return { tenantId: String(client.sourceTenantId), ids, client };
      },
      async (prepared) =>
        runCommissionProbe(
          {
            tenantId: prepared.tenantId,
            readAllowlistedGet: (family, resource, query) =>
              prepared.client.readAllowlistedGet!(family, resource, query),
          },
          prepared.ids,
        ),
      async (ctx, _prepared, report) => {
        if (ctx.staff.role !== "owner") {
          throw new ApiError("forbidden", "Only an owner can run the commission probe.");
        }
        sendData(ctx.res, report);
      },
    ),
  );

  router.get(
    "/projects/:id/service-titan-financials",
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      const money = await readStoredProjectMoney(ctx.db, projectId);
      const stored = await readStoredReconciliation(ctx.db, projectId);
      sendData(ctx.res, {
        ...money,
        observed_at: stored?.observed_at ?? null,
        error: stored?.error ?? null,
      });
    }),
  );

  router.get(
    "/projects/:id/financials/reconciliation",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_company_settings");
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      const stored = await readStoredReconciliation(ctx.db, projectId);
      const jobs = await ctx.db.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM projects.project_job_links
          WHERE project_id = $1 AND source_active`,
        [projectId],
      );
      sendData(ctx.res, {
        project_id: projectId,
        job_count: Number(jobs.rows[0]?.n ?? 0),
        observed_at: stored?.observed_at ?? null,
        lines: stored?.lines ?? [],
        technicians: stored?.technicians ?? [],
        error: stored?.error ?? null,
        note: reconciliationNote(stored),
      });
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
        return { projectId, source, tenantId: ctx.staff.tenantId };
      },
      async (prepared) => {
        const laborCode = await resolveStLaborCode(prepared.source.client);
        await refreshLinkedProject(
          deps.database,
          prepared.source,
          prepared.tenantId,
          prepared.projectId,
          new Date(),
          laborCode,
          "manual",
        );
        return prepared.source.client;
      },
      async (ctx, prepared, client) => {
        requireCapability(ctx.staff.role, "refresh_labor");
        await loadVisibleProject(ctx, prepared.projectId, "id");
        sendData(ctx.res, await presentLabor(ctx, prepared.projectId, client));
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
    labor_billable_rate: await readBillableRate(ctx.db, ctx.staff.tenantId),
    rate_gaps: await listActiveRateGaps(ctx.db, ctx.staff.tenantId),
    burden_notices: await listBurdenNotices(ctx.db, ctx.staff.tenantId),
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
    `SELECT a.id, a.work_date::text, a.hours::text,
            COALESCE(NULLIF(btrim(a.technician_name), ''), NULLIF(btrim(r.technician_name), '')) AS technician_name,
            a.source, a.external_job_id
       FROM projects.labor_actuals a
       LEFT JOIN projects.technician_labor_rates r
         ON r.tenant_id = a.tenant_id
        AND r.external_technician_id = a.external_technician_id
      WHERE a.project_id = $1
      ORDER BY a.work_date, COALESCE(NULLIF(btrim(a.technician_name), ''), NULLIF(btrim(r.technician_name), ''))`,
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
    ...(showMoney ? { billable_rate: await readBillableRate(ctx.db, ctx.staff.tenantId) } : {}),
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
    burden_unset: tech.burden_unset,
    notices: tech.notices,
    ...(showRates
      ? {
          pay_basis: tech.pay_basis,
          wage: tech.wage,
          burden: tech.burden,
          amount:
            tech.wage === null ? null : round2(tech.wage + (tech.burden ?? 0)),
        }
      : {}),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
