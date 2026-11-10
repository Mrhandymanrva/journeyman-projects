import { Router } from "express";
import { can, requireCapability } from "../http/capabilities.js";
import { sendData } from "../http/envelope.js";
import { ApiError, validationFailed } from "../http/errors.js";
import {
  staffRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import {
  closeoutReportWarnings,
  closeoutSummaryBodySchema,
  emptyCloseoutSummary,
  formatStampEt,
  missingFinalFields,
  presentSavedSummary,
  pullCloseoutSummary,
  redactCosts,
  savedSummarySchema,
  showCloseoutDraftBanner,
  tidySummary,
  todayEt,
  type SavedCloseoutSummary,
} from "../domain/closeoutSummary.js";
import {
  closeoutReportHtml,
  pdfFileName,
  renderCloseoutReportPdf,
} from "../domain/closeoutSummaryExport.js";
import { loadVisibleProject, parseBody, parseUuidParam } from "./shared.js";

/**
 * Final project report on the closeout card.
 * Writes stay on project_closeout. The risk register is not updated.
 * PDF and HTML include cost and margin, so both require view_margin.
 * That is the same set of roles as export_cost_data or manage_project_controls.
 * Nothing here emails the customer or writes to ServiceTitan.
 */
export function closeoutSummaryRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    "/projects/:id/closeout/summary",
    staffRoute(deps, async (ctx) => {
      const projectId = await visibleProject(ctx);
      sendData(ctx.res, await present(ctx, projectId));
    }),
  );

  router.put(
    "/projects/:id/closeout/summary",
    staffRoute(deps, async (ctx) => {
      const projectId = await visibleProject(ctx);
      requireCapability(ctx.staff.role, "manage_project_controls");
      await assertDraft(ctx, projectId);
      const saved = await snapshot(ctx, projectId, readBody(ctx));
      await ctx.db.query(
        `INSERT INTO projects.project_closeout (
           project_id, tenant_id, summary, summary_updated_at, summary_updated_by
         ) VALUES ($1, $2, $3::jsonb, now(), $4)
         ON CONFLICT (project_id) DO UPDATE SET
           summary = EXCLUDED.summary,
           summary_updated_at = now(),
           summary_updated_by = EXCLUDED.summary_updated_by`,
        [
          projectId,
          ctx.staff.tenantId,
          JSON.stringify(saved),
          ctx.staff.staffId,
        ],
      );
      sendData(ctx.res, await present(ctx, projectId));
    }),
  );

  router.post(
    "/projects/:id/closeout/summary/finalize",
    staffRoute(deps, async (ctx) => {
      const projectId = await visibleProject(ctx);
      requireCapability(ctx.staff.role, "manage_project_controls");
      await assertDraft(ctx, projectId);
      const saved = await snapshot(ctx, projectId, readBody(ctx));
      const missing = missingFinalFields(saved);
      if (Object.keys(missing).length) {
        throw validationFailed(
          missing,
          "Fill in the required narrative before finalizing.",
        );
      }
      await ctx.db.query(
        `INSERT INTO projects.project_closeout (
           project_id, tenant_id, summary, summary_updated_at, summary_updated_by,
           summary_finalized_at, summary_finalized_by
         ) VALUES ($1, $2, $3::jsonb, now(), $4, now(), $4)
         ON CONFLICT (project_id) DO UPDATE SET
           summary = EXCLUDED.summary,
           summary_updated_at = now(),
           summary_updated_by = EXCLUDED.summary_updated_by,
           summary_finalized_at = now(),
           summary_finalized_by = EXCLUDED.summary_finalized_by
         WHERE project_closeout.summary_finalized_at IS NULL`,
        [
          projectId,
          ctx.staff.tenantId,
          JSON.stringify(saved),
          ctx.staff.staffId,
        ],
      );
      sendData(ctx.res, await present(ctx, projectId));
    }),
  );

  router.get(
    "/projects/:id/closeout/summary.pdf",
    staffRoute(deps, async (ctx) => {
      const projectId = await visibleProject(ctx);
      requireCapability(ctx.staff.role, "view_margin");
      const source = await exportSource(ctx, projectId);
      const bytes = await renderCloseoutReportPdf(source);
      const filename = pdfFileName(source.pulled.cover.project_number);
      ctx.res.set("Cache-Control", "no-store");
      ctx.res
        .status(200)
        .type("application/pdf")
        .setHeader("Content-Disposition", `attachment; filename="${filename}"`)
        .send(bytes);
    }),
  );

  router.get(
    "/projects/:id/closeout/summary.html",
    staffRoute(deps, async (ctx) => {
      const projectId = await visibleProject(ctx);
      requireCapability(ctx.staff.role, "view_margin");
      const source = await exportSource(ctx, projectId);
      ctx.res.set("Cache-Control", "no-store");
      ctx.res.status(200).type("html").send(closeoutReportHtml(source));
    }),
  );

  return router;
}

async function visibleProject(ctx: StaffContext): Promise<string> {
  const projectId = parseUuidParam(ctx.req.params.id, "Project");
  await loadVisibleProject(ctx, projectId, "id");
  return projectId;
}

function readBody(ctx: StaffContext) {
  return tidySummary(parseBody(closeoutSummaryBodySchema, ctx.req.body));
}

async function assertDraft(
  ctx: StaffContext,
  projectId: string,
): Promise<void> {
  const { rows } = await ctx.db.query<{ summary_finalized_at: unknown }>(
    `SELECT summary_finalized_at
       FROM projects.project_closeout
      WHERE project_id = $1
      FOR UPDATE`,
    [projectId],
  );
  if (rows[0]?.summary_finalized_at) {
    throw new ApiError("conflict", "This report is finalized and read-only.");
  }
}

async function snapshot(
  ctx: StaffContext,
  projectId: string,
  body: ReturnType<typeof readBody>,
): Promise<SavedCloseoutSummary> {
  const pull = await pullCloseoutSummary(ctx.db, projectId);
  return {
    ...body,
    version: 1,
    pulled_snapshot: pull.pulled,
  };
}

async function present(ctx: StaffContext, projectId: string) {
  const pull = await pullCloseoutSummary(ctx.db, projectId);
  const canViewCosts = can(ctx.staff.role, "view_margin");
  const canEdit = can(ctx.staff.role, "manage_project_controls");
  const stored = await ctx.db.query<{
    summary: unknown;
    summary_updated_at: Date | string | null;
    summary_finalized_at: Date | string | null;
    updated_by: string | null;
    finalized_by: string | null;
  }>(
    `SELECT c.summary, c.summary_updated_at, c.summary_finalized_at,
            u.full_name AS updated_by, f.full_name AS finalized_by
       FROM projects.project_closeout c
       LEFT JOIN projects.staff u ON u.id = c.summary_updated_by
       LEFT JOIN projects.staff f ON f.id = c.summary_finalized_by
      WHERE c.project_id = $1`,
    [projectId],
  );
  const row = stored.rows[0];
  const summary = row?.summary == null ? null : parseStored(row.summary);
  const finalized = row?.summary_finalized_at != null;
  const narrative = summary ?? emptyCloseoutSummary(todayEt());
  const warnings = closeoutReportWarnings({
    stage: pull.stage,
    finalized,
    actualEnd: pull.pulled.schedule.actual_end,
    punchDone: pull.pulled.closeout.punch_done,
    photosDone: pull.pulled.closeout.photos_done,
    finalDrawInvoice: pull.pulled.closeout.final_draw_invoice_number,
    warrantyStart: pull.pulled.closeout.warranty_start_on,
    reviewRequest: pull.pulled.closeout.review_request_note,
    lessonsLearned: narrative.narrative.lessons_learned,
    achievementsObstacles: narrative.post_mortem.achievements_obstacles,
    rootCauses: narrative.post_mortem.root_causes,
    keyTakeaways: narrative.post_mortem.key_takeaways,
    actionItems: narrative.post_mortem.action_items,
    nextSteps: narrative.post_mortem.next_steps,
  });
  return {
    available: true,
    stage: pull.stage,
    gate_4_status: pull.gate_4_status,
    today: todayEt(),
    can_edit: canEdit && !finalized,
    can_view_costs: canViewCosts,
    finalized,
    warnings,
    draft_banner: showCloseoutDraftBanner(finalized, warnings),
    updated_at: iso(row?.summary_updated_at),
    updated_label: formatStampEt(row?.summary_updated_at),
    updated_by: row?.updated_by ?? null,
    finalized_at: iso(row?.summary_finalized_at),
    finalized_label: formatStampEt(row?.summary_finalized_at),
    finalized_by: row?.finalized_by ?? null,
    summary: presentSavedSummary(summary, canViewCosts),
    pulled: redactCosts(pull.pulled, canViewCosts),
  };
}

function parseStored(value: unknown): SavedCloseoutSummary {
  const parsed = savedSummarySchema.safeParse(value);
  if (!parsed.success) {
    throw validationFailed(
      { summary: "The saved report is not a version this screen can open." },
      "The saved report is not a version this screen can open.",
    );
  }
  return parsed.data;
}

async function exportSource(ctx: StaffContext, projectId: string) {
  const view = await present(ctx, projectId);
  const company =
    (
      await ctx.db.query<{ name: string }>(
        `SELECT display_name AS name FROM projects.tenants WHERE id = $1`,
        [ctx.staff.tenantId],
      )
    ).rows[0]?.name ?? "Journeyman Projects";
  const body = view.summary ?? emptyCloseoutSummary(view.today);
  return {
    company,
    body,
    pulled: view.summary?.pulled_snapshot ?? view.pulled,
    finalized: view.finalized,
    warnings: view.warnings,
  };
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
