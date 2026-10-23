import { Router } from "express";
import { z } from "zod";
import { staffRoute, type StaffRouterDeps } from "../http/staffSession.js";
import { requireCapability, unitFilter } from "../http/capabilities.js";
import { sendData } from "../http/envelope.js";
import { ApiError, notFound } from "../http/errors.js";
import {
  loadVisibleProject,
  parseBody,
  parseUuidParam,
  requireOwnedRow,
} from "./shared.js";
import { enrichSchedule } from "../domain/planning.js";

export function planningRoutes(deps: StaffRouterDeps): Router {
  const router = Router();
  router.get(
    "/resources",
    staffRoute(deps, async (ctx) => {
      const result = await ctx.db.query(
        `SELECT r.id, r.name, r.kind, r.trade, r.active, r.source_system_id, r.source_technician_id, r.vendor_id, v.legal_name AS vendor_name
      FROM projects.scheduling_resources r LEFT JOIN projects.vendors v ON v.id = r.vendor_id
      WHERE ($1::boolean OR r.active) ORDER BY r.name`,
        [ctx.req.query.include_inactive === "true"],
      );
      sendData(ctx.res, result.rows);
    }),
  );
  router.post(
    "/resources",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "advance_stage");
      const b = parseBody(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            kind: z.enum(["employee", "crew", "subcontractor"]),
            trade: z.string().trim().max(120).nullish(),
            vendor_id: z.string().uuid().nullish(),
          })
          .strict()
          .refine((v) => v.kind !== "subcontractor" || Boolean(v.vendor_id), {
            message: "Choose a vendor for a subcontractor resource",
            path: ["vendor_id"],
          }),
        ctx.req.body,
      );
      await requireOwnedRow(ctx.db, "vendors", b.vendor_id, "vendor_id");
      if (
        b.vendor_id &&
        (
          await ctx.db.query(
            "SELECT archived FROM projects.vendors WHERE id=$1",
            [b.vendor_id],
          )
        ).rows[0]?.archived
      )
        throw new ApiError(
          "conflict",
          "Restore the archived company before adding its crew.",
        );
      const result = await ctx.db.query(
        `INSERT INTO projects.scheduling_resources (tenant_id,name,kind,trade,vendor_id)
      VALUES ($1,$2,$3,$4,$5) RETURNING id,name,kind,trade,vendor_id`,
        [
          ctx.staff.tenantId,
          b.name,
          b.kind,
          b.trade ?? null,
          b.vendor_id ?? null,
        ],
      );
      sendData(ctx.res, result.rows[0], undefined, 201);
    }),
  );
  router.patch(
    "/resources/:id",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "advance_stage");
      const id = parseUuidParam(ctx.req.params.id, "Resource");
      const row = (
        await ctx.db.query(
          "SELECT * FROM projects.scheduling_resources WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!row) throw notFound("Resource not found");
      if (row.source_system_id)
        throw new ApiError(
          "conflict",
          "Manage imported technicians in ServiceTitan, then refresh the directory.",
        );
      const b = parseBody(
        z
          .object({
            name: z.string().trim().min(1).max(200).optional(),
            kind: z.enum(["employee", "crew", "subcontractor"]).optional(),
            trade: z.string().trim().max(120).nullable().optional(),
            vendor_id: z.string().uuid().nullable().optional(),
            active: z.boolean().optional(),
          })
          .strict(),
        ctx.req.body,
      );
      const next = { ...row, ...b };
      if (next.kind === "subcontractor" && !next.vendor_id)
        throw new ApiError(
          "validation_failed",
          "Choose a vendor for a subcontractor resource.",
        );
      await requireOwnedRow(
        ctx.db,
        "vendors",
        next.vendor_id as string | null,
        "vendor_id",
      );
      if (next.vendor_id && next.active) {
        const vendor = (
          await ctx.db.query(
            "SELECT archived FROM projects.vendors WHERE id=$1",
            [next.vendor_id],
          )
        ).rows[0];
        if (vendor?.archived)
          throw new ApiError(
            "conflict",
            "Restore the archived company before restoring its crew.",
          );
      }
      const saved = await ctx.db.query(
        "UPDATE projects.scheduling_resources SET name=$2,kind=$3,trade=$4,vendor_id=$5,active=$6 WHERE id=$1 RETURNING *",
        [id, next.name, next.kind, next.trade, next.vendor_id, next.active],
      );
      sendData(ctx.res, saved.rows[0]);
    }),
  );
  router.get(
    "/external-systems",
    staffRoute(deps, async (ctx) => {
      const result = await ctx.db.query(
        "SELECT id, display_name FROM projects.external_systems WHERE active ORDER BY display_name",
      );
      sendData(ctx.res, result.rows);
    }),
  );
  router.get(
    "/projects/:id/jobs",
    staffRoute(deps, async (ctx) => {
      const id = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, id, "id");
      const result = await ctx.db.query(
        `SELECT j.id,j.title,j.external_system_id,j.external_job_id,j.source_managed,j.source_active,j.source_job_number,j.source_job_status,j.source_summary,e.display_name AS system_name
      FROM projects.project_job_links j JOIN projects.external_systems e ON e.id = j.external_system_id
      WHERE j.project_id = $1 ORDER BY j.created_at`,
        [id],
      );
      sendData(ctx.res, result.rows);
    }),
  );
  router.post(
    "/projects/:id/jobs",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "advance_stage");
      const id = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, id, "id");
      if (
        (
          await ctx.db.query(
            "SELECT project_id FROM projects.st_project_connections WHERE project_id=$1",
            [id],
          )
        ).rows.length
      )
        throw new ApiError(
          "conflict",
          "Project jobs come from ServiceTitan. Refresh the ST project to update them.",
        );
      const b = parseBody(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            external_system_id: z.string().uuid(),
            external_job_id: z.string().trim().min(1).max(200),
          })
          .strict(),
        ctx.req.body,
      );
      await requireOwnedRow(
        ctx.db,
        "external_systems",
        b.external_system_id,
        "external_system_id",
      );
      const result = await ctx.db.query(
        `INSERT INTO projects.project_job_links (tenant_id,project_id,title,external_system_id,external_job_id)
      VALUES ($1,$2,$3,$4,$5) RETURNING id,title,external_system_id,external_job_id`,
        [
          ctx.staff.tenantId,
          id,
          b.title,
          b.external_system_id,
          b.external_job_id,
        ],
      );
      sendData(ctx.res, result.rows[0], undefined, 201);
    }),
  );
  router.delete(
    "/projects/:id/jobs/:jobId",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "advance_stage");
      const id = parseUuidParam(ctx.req.params.id, "Project");
      const job = parseUuidParam(ctx.req.params.jobId, "Job");
      await loadVisibleProject(ctx, id, "id");
      const exists = await ctx.db.query(
        "SELECT id FROM projects.project_job_links WHERE id = $1 AND project_id = $2 FOR UPDATE",
        [job, id],
      );
      if (!exists.rows.length) throw notFound("Job link not found");
      if (
        (
          await ctx.db.query(
            "SELECT project_id FROM projects.st_project_connections WHERE project_id=$1",
            [id],
          )
        ).rows.length
      )
        throw new ApiError(
          "conflict",
          "Project jobs come from ServiceTitan. Refresh the ST project to update them.",
        );
      const used = await ctx.db.query(
        "SELECT id FROM projects.schedule_items WHERE job_link_id = $1",
        [job],
      );
      if (used.rows.length)
        throw new ApiError(
          "conflict",
          "Remove this job from its schedule activities before unlinking it.",
        );
      await ctx.db.query(
        "DELETE FROM projects.project_job_links WHERE id = $1",
        [job],
      );
      sendData(ctx.res, { id: job, deleted: true });
    }),
  );
  router.get(
    "/schedule-lookahead",
    staffRoute(deps, async (ctx) => {
      const q = parseBody(
        z.object({ from: z.string().date(), to: z.string().date() }).strict(),
        ctx.req.query,
      );
      const days = (Date.parse(q.to) - Date.parse(q.from)) / 86400000;
      if (days < 0 || days > 92)
        throw new ApiError(
          "validation_failed",
          "Choose a date range of up to 93 days.",
        );
      const scope = unitFilter(
        ctx.staff.businessUnitId,
        ctx.settings.enforceBusinessUnitScoping,
      );
      const result = await ctx.db.query<Record<string, any>>(
        `SELECT s.id,s.project_id,p.project_number,p.name AS project_name,
      s.title,s.phase,s.trade,s.activity_type,s.window_start,s.window_end,s.status,s.staff_id,st.full_name AS staff_name,s.vendor_id,v.legal_name AS vendor_name,
      COALESCE(e.schedulable,true) AS vendor_schedulable,s.job_link_id
      FROM projects.schedule_items s JOIN projects.projects p ON p.id = s.project_id
      LEFT JOIN projects.staff st ON st.id = s.staff_id LEFT JOIN projects.vendors v ON v.id = s.vendor_id
      LEFT JOIN projects.v_vendor_eligibility e ON e.vendor_id = s.vendor_id
      WHERE s.window_start <= $2::date AND s.window_end >= $1::date AND s.status <> 'cancelled'
      AND ($3::uuid IS NULL OR p.business_unit_id IS NULL OR p.business_unit_id = $3)
      ORDER BY s.window_start,p.project_number,s.title`,
        [q.from, q.to, scope],
      );
      sendData(ctx.res, await enrichSchedule(ctx, result.rows));
    }),
  );
  return router;
}
