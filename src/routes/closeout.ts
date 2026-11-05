import { Router } from "express";
import { z } from "zod";
import { sendData } from "../http/envelope.js";
import { validationFailed } from "../http/errors.js";
import { requireCapability } from "../http/capabilities.js";
import { staffRoute, type StaffContext, type StaffRouterDeps } from "../http/staffSession.js";
import { loadVisibleProject, parseBody, parseUuidParam } from "./shared.js";

const putSchema = z.object({
  punch_done: z.boolean().optional(),
  punch_note: z.string().max(2000).nullable().optional(),
  photos_done: z.boolean().optional(),
  photos_note: z.string().max(2000).nullable().optional(),
  final_draw_invoice_number: z.string().max(80).nullable().optional(),
  warranty_start_on: z.string().date().nullable().optional(),
  review_request_note: z.string().max(2000).nullable().optional(),
});

const SELECT = `SELECT punch_done_at, punch_note, photos_done_at, photos_note,
            final_draw_invoice_number, warranty_start_on::text AS warranty_start_on,
            review_request_note, review_request_recorded_at, review_request_recorded_by
       FROM projects.project_closeout WHERE project_id = $1`;

export function closeoutRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    "/projects/:id/closeout",
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      sendData(ctx.res, await loadCloseout(ctx, projectId));
    }),
  );

  router.put(
    "/projects/:id/closeout",
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      requireCapability(ctx.staff.role, "manage_project_controls");
      const body = parseBody(putSchema, ctx.req.body);
      const invoice = clean(body.final_draw_invoice_number);
      if (typeof invoice === "string" && invoice.length > 80) {
        throw validationFailed(
          { final_draw_invoice_number: "Use 80 characters or fewer." },
          "Final draw invoice number is too long.",
        );
      }

      await ctx.db.query(
        `INSERT INTO projects.project_closeout (
           project_id, tenant_id,
           punch_done_at, punch_note,
           photos_done_at, photos_note,
           final_draw_invoice_number, warranty_start_on,
           review_request_note, review_request_recorded_at, review_request_recorded_by
         ) VALUES (
           $2, $1,
           CASE WHEN $3::boolean AND $4::boolean THEN now() ELSE NULL END,
           CASE WHEN $5::boolean THEN $6 ELSE NULL END,
           CASE WHEN $7::boolean AND $8::boolean THEN now() ELSE NULL END,
           CASE WHEN $9::boolean THEN $10 ELSE NULL END,
           CASE WHEN $11::boolean THEN $12 ELSE NULL END,
           CASE WHEN $13::boolean THEN $14::date ELSE NULL END,
           CASE WHEN $15::boolean THEN $16 ELSE NULL END,
           CASE WHEN $15::boolean AND $16 IS NOT NULL THEN now() ELSE NULL END,
           CASE WHEN $15::boolean AND $16 IS NOT NULL THEN $17::uuid ELSE NULL END
         )
         ON CONFLICT (project_id) DO UPDATE SET
           punch_done_at = CASE
             WHEN $3::boolean THEN CASE
               WHEN $4::boolean THEN COALESCE(project_closeout.punch_done_at, now())
               ELSE NULL
             END
             ELSE project_closeout.punch_done_at
           END,
           punch_note = CASE WHEN $5::boolean THEN $6 ELSE project_closeout.punch_note END,
           photos_done_at = CASE
             WHEN $7::boolean THEN CASE
               WHEN $8::boolean THEN COALESCE(project_closeout.photos_done_at, now())
               ELSE NULL
             END
             ELSE project_closeout.photos_done_at
           END,
           photos_note = CASE WHEN $9::boolean THEN $10 ELSE project_closeout.photos_note END,
           final_draw_invoice_number = CASE
             WHEN $11::boolean THEN $12 ELSE project_closeout.final_draw_invoice_number
           END,
           warranty_start_on = CASE
             WHEN $13::boolean THEN $14::date ELSE project_closeout.warranty_start_on
           END,
           review_request_note = CASE
             WHEN $15::boolean THEN $16 ELSE project_closeout.review_request_note
           END,
           review_request_recorded_at = CASE
             WHEN $15::boolean THEN CASE WHEN $16 IS NOT NULL THEN now() ELSE NULL END
             ELSE project_closeout.review_request_recorded_at
           END,
           review_request_recorded_by = CASE
             WHEN $15::boolean THEN CASE WHEN $16 IS NOT NULL THEN $17::uuid ELSE NULL END
             ELSE project_closeout.review_request_recorded_by
           END`,
        [
          ctx.staff.tenantId,
          projectId,
          body.punch_done !== undefined,
          body.punch_done === true,
          body.punch_note !== undefined,
          clean(body.punch_note) ?? null,
          body.photos_done !== undefined,
          body.photos_done === true,
          body.photos_note !== undefined,
          clean(body.photos_note) ?? null,
          body.final_draw_invoice_number !== undefined,
          invoice ?? null,
          body.warranty_start_on !== undefined,
          body.warranty_start_on ?? null,
          body.review_request_note !== undefined,
          clean(body.review_request_note) ?? null,
          ctx.staff.staffId,
        ],
      );

      sendData(ctx.res, await loadCloseout(ctx, projectId));
    }),
  );

  return router;
}

function clean(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

async function loadCloseout(ctx: StaffContext, projectId: string): Promise<Record<string, unknown>> {
  const { rows } = await ctx.db.query<Record<string, unknown>>(SELECT, [projectId]);
  return (
    rows[0] ?? {
      punch_done_at: null,
      punch_note: null,
      photos_done_at: null,
      photos_note: null,
      final_draw_invoice_number: null,
      warranty_start_on: null,
      review_request_note: null,
      review_request_recorded_at: null,
      review_request_recorded_by: null,
    }
  );
}
