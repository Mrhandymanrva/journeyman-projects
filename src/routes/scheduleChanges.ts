import { createHash } from "node:crypto";
import {
  ServiceTitanReadError,
  ServiceTitanWriteUncertainError,
} from "../adapters/serviceTitan.js";
import { Router } from "express";
import { z } from "zod";
import {
  staffRoute,
  staffExternalRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import { requireCapability } from "../http/capabilities.js";
import { ApiError, notFound } from "../http/errors.js";
import { sendData } from "../http/envelope.js";
import { loadVisibleProject, parseBody, parseUuidParam } from "./shared.js";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import { proposePlan, type PlanRow } from "../domain/scheduleProposal.js";
export function scheduleChangeRoutes(
  deps: StaffRouterDeps,
  sources: SourceConnections = {},
) {
  const router = Router();
  router.post(
    "/projects/:id/schedule-proposal",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "advance_stage");
      const id = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, id, "id");
      const body = parseBody(
        z
          .object({
            activity_id: z.string().uuid(),
            start: z.string().date(),
            apply: z.boolean().default(false),
            expected: z.string().optional(),
          })
          .strict(),
        ctx.req.body,
      );
      await ctx.db.query(
        "SELECT id FROM projects.projects WHERE id=$1 FOR UPDATE",
        [id],
      );
      const result = await ctx.db.query<PlanRow>(
        `SELECT s.id,s.title,s.window_start::text,s.window_end::text,s.status,
   COALESCE((SELECT json_agg(json_build_object('predecessor_id',d.predecessor_id,'lag_days',d.lag_days) ORDER BY d.predecessor_id) FROM projects.schedule_dependencies d WHERE d.schedule_item_id=s.id),'[]'::json) AS dependencies FROM projects.schedule_items s WHERE s.project_id=$1 ORDER BY s.id`,
        [id],
      );
      if (!result.rows.some((r) => r.id === body.activity_id))
        throw notFound("Activity not found");
      try {
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(result.rows))
          .digest("hex");
        const changes = proposePlan(result.rows, body.activity_id, body.start);
        if (body.apply) {
          if (body.expected !== fingerprint)
            throw new Error("Plan changed; preview again");
          for (const change of changes)
            await ctx.db.query(
              "UPDATE projects.schedule_items SET baseline_window_start=COALESCE(baseline_window_start,window_start),baseline_window_end=COALESCE(baseline_window_end,window_end),window_start=$2,window_end=$3 WHERE id=$1",
              [change.id, change.after.start, change.after.end],
            );
        }
        sendData(ctx.res, {
          calendar:
            "Monday–Friday; calendar-day waiting periods; holidays not configured",
          changes,
          fingerprint,
          applied: body.apply,
          dispatch: "ST appointments require separate review and publishing.",
        });
      } catch {
        throw new ApiError(
          "conflict",
          "Unable to propose this move; check activity status and dependencies.",
        );
      }
    }),
  );
  async function prepare(ctx: StaffContext) {
    requireCapability(ctx.staff.role, "advance_stage");
    const projectId = parseUuidParam(ctx.req.params.id, "Project"),
      jobLinkId = parseUuidParam(ctx.req.params.jobId, "Job");
    await loadVisibleProject(ctx, projectId, "id");
    const { rows } = await ctx.db.query<{
      external_job_id: string;
      external_system_id: string;
    }>(
      "SELECT j.external_job_id,j.external_system_id FROM projects.project_job_links j JOIN projects.external_systems e ON e.id=j.external_system_id AND e.tenant_id=j.tenant_id WHERE j.id=$1 AND j.project_id=$2 AND e.active AND e.adapter_key='servicetitan'",
      [jobLinkId, projectId],
    );
    if (!rows[0]) throw notFound("Job link not found");
    const c = sources.serviceTitan;
    if (
      !c ||
      c.tenantId !== ctx.staff.tenantId ||
      c.externalSystemId !== rows[0].external_system_id ||
      !c.writesEnabled ||
      !c.client.rescheduleAppointment
    )
      throw new ApiError(
        "conflict",
        "ST schedule publishing is not enabled for this project.",
      );
    return { projectId, jobLinkId, c, jobId: rows[0].external_job_id };
  }
  router.post(
    "/projects/:id/jobs/:jobId/dispatch/publish",
    staffExternalRoute(
      deps,
      async (ctx) => {
        const p = await prepare(ctx);
        const b = parseBody(
          z
            .object({
              request_key: z.string().uuid(),
              technician_ids: z
                .array(z.string().regex(/^\d+$/))
                .max(50)
                .optional(),
              appointment_id: z.string().regex(/^\d+$/),
              expected_modified_on: z.string().min(1),
              start: z.string().datetime({ offset: true }),
              end: z.string().datetime({ offset: true }),
              arrivalWindowStart: z
                .string()
                .datetime({ offset: true })
                .nullable(),
              arrivalWindowEnd: z
                .string()
                .datetime({ offset: true })
                .nullable(),
            })
            .strict()
            .refine(
              (x) => Date.parse(x.end) > Date.parse(x.start),
              "End must follow start",
            )
            .refine(
              (x) =>
                (x.arrivalWindowStart === null &&
                  x.arrivalWindowEnd === null) ||
                (x.arrivalWindowStart !== null &&
                  x.arrivalWindowEnd !== null &&
                  Date.parse(x.arrivalWindowEnd) >=
                    Date.parse(x.arrivalWindowStart)),
              "Arrival window must be a valid pair",
            ),
          ctx.req.body,
        );
        const prior = await ctx.db.query(
          "SELECT id FROM projects.dispatch_changes WHERE request_key=$1",
          [b.request_key],
        );
        if (prior.rows.length)
          throw new ApiError(
            "conflict",
            "This publish request has already been recorded. Refresh dispatch before retrying.",
          );
        const { rows } = await ctx.db.query<{ id: string }>(
          `INSERT INTO projects.dispatch_changes(tenant_id,project_id,job_link_id,appointment_id,request_key,requested_by,state,request) VALUES($1,$2,$3,$4,$5,$6,'publishing',$7::jsonb) RETURNING id`,
          [
            ctx.staff.tenantId,
            p.projectId,
            p.jobLinkId,
            b.appointment_id,
            b.request_key,
            ctx.staff.staffId,
            JSON.stringify(b),
          ],
        );
        return { ...p, b, operationId: rows[0]!.id };
      },
      async (p) => {
        try {
          return {
            ok: true as const,
            snapshot: await p.c.client.rescheduleAppointment!(
              p.jobId,
              p.b.appointment_id,
              p.b.expected_modified_on,
              {
                start: p.b.start,
                end: p.b.end,
                arrivalWindowStart: p.b.arrivalWindowStart,
                arrivalWindowEnd: p.b.arrivalWindowEnd,
                technicianIds: p.b.technician_ids,
              },
            ),
          };
        } catch (error) {
          return {
            ok: false as const,
            uncertain: error instanceof ServiceTitanWriteUncertainError,
            message:
              error instanceof ServiceTitanReadError
                ? error.message
                : "ST read failed before publishing.",
          };
        }
      },
      async (ctx, p, result) => {
        await ctx.db.query(
          "UPDATE projects.dispatch_changes SET state=$2,result=$3::jsonb,updated_at=now() WHERE id=$1",
          [
            p.operationId,
            result.ok ? "confirmed" : result.uncertain ? "uncertain" : "failed",
            JSON.stringify(
              result.ok
                ? { confirmedAt: result.snapshot.observedAt }
                : {
                    message:
                      "ST did not confirm the requested change. Review dispatch before another attempt.",
                  },
            ),
          ],
        );
        if (result.ok)
          await ctx.db.query(
            `INSERT INTO projects.dispatch_snapshots(tenant_id,project_id,job_link_id,connection_key,observed_at,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(job_link_id) DO UPDATE SET connection_key=excluded.connection_key,observed_at=excluded.observed_at,payload=excluded.payload WHERE dispatch_snapshots.observed_at<excluded.observed_at`,
            [
              ctx.staff.tenantId,
              p.projectId,
              p.jobLinkId,
              p.c.key,
              result.snapshot.observedAt,
              JSON.stringify(result.snapshot),
            ],
          );
        sendData(ctx.res, {
          operationId: p.operationId,
          state: result.ok
            ? "confirmed"
            : result.uncertain
              ? "uncertain"
              : "failed",
          message: result.ok
            ? "ST confirmed the new appointment times."
            : result.message,
        });
      },
    ),
  );
  return router;
}
