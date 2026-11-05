import {scheduleSnapshot,cascadeSchedule} from "../domain/scheduleCascade.js";
import {
  planningFields,
  validatePlanning,
  savePlanning,
  enrichSchedule,
} from "../domain/planning.js";
import { Router } from "express";
import { z } from "zod";
import { sendData } from "../http/envelope.js";
import { ApiError, notFound } from "../http/errors.js";
import { requireCapability } from "../http/capabilities.js";
import {
  importPermitOffices,
  parsePermitOfficeCsv,
  parsePermitOfficeJson,
} from "../domain/permitOffices.js";
import {
  staffRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import {
  loadVisibleProject,
  parseBody,
  parseUuidParam,
  requireOwnedRow,
  requireStaffOfTenant,
} from "./shared.js";

/**
 * Permits, schedule and daily logs — §3.7. Grouped because the console reads
 * all three as one picture of what is happening on site this week, and
 * splitting them into three files would spread four small handlers each.
 */

const createPermitSchema = z
  .object({
    jurisdiction_id: z.string().uuid(),
    permit_type: z.string().min(1),
    permit_number: z.string().nullish(),
    pulled_by_vendor_id: z.string().uuid().nullish(),
    applied_on: z.string().date().nullish(),
    not_required: z.boolean().default(false),
    not_required_reason: z.string().nullish(),
  })
  .refine((v) => !v.not_required || Boolean(v.not_required_reason), {
    message: "A permit marked not required needs a reason",
    path: ["not_required_reason"],
  });

const milestoneSchema = z.object({
  status: z.enum([
    "pending",
    "in_progress",
    "complete",
    "not_applicable",
    "failed",
  ]),
  due_on: z.string().date().nullish(),
  note: z.string().nullish(),
});

const scheduleItemSchema = z.object({
  ...planningFields,
  title: z.string().min(1),
  cost_code_id: z.string().uuid().nullish(),
  vendor_id: z.string().uuid().nullish(),
  staff_id: z.string().uuid().nullish(),
  window_start: z.string().date(),
  window_end: z.string().date(),
  status: z
    .enum(["proposed", "confirmed", "in_progress", "complete", "cancelled"])
    .default("proposed"),
  depends_on: z.string().uuid().nullish(),
});

const dailyLogSchema = z.object({
  log_date: z.string().date(),
  crew_on_site: z.string().nullish(),
  vendors_on_site: z.array(z.string().uuid()).default([]),
  work_completed: z.string().nullish(),
  delays: z.string().nullish(),
  delay_cause: z.string().nullish(),
  deliveries: z.string().nullish(),
  inspections: z.string().nullish(),
  client_interaction: z.string().nullish(),
  safety_note: z.string().nullish(),
  weather: z.string().nullish(),
});

export function fieldOperationRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  // ------------------------------------------------------------ permits ----
  router.get(
    "/projects/:id/permits",
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT p.id, p.permit_type, p.permit_number, p.applied_on, p.issued_on,
                p.fee_amount, p.not_required, p.not_required_reason,
                j.name AS jurisdiction, j.portal_url, j.typical_review_days
           FROM projects.permits p
           JOIN projects.jurisdictions j ON j.id = p.jurisdiction_id
          WHERE p.project_id = $1
          ORDER BY p.applied_on NULLS LAST`,
        [projectId],
      );

      const milestones = await ctx.db.query<Record<string, unknown>>(
        `SELECT m.id, m.permit_id, m.sequence_number, m.name, m.owner_role::text AS owner_role,
                m.due_on, m.status::text AS status, m.completed_at, m.note,
                (m.due_on IS NOT NULL AND m.due_on < CURRENT_DATE
                 AND m.status IN ('pending','in_progress')) AS overdue
           FROM projects.permit_milestones m
           JOIN projects.permits p ON p.id = m.permit_id
          WHERE p.project_id = $1
          ORDER BY m.sequence_number`,
        [projectId],
      );

      sendData(
        ctx.res,
        rows.map((permit) => ({
          ...permit,
          milestones: milestones.rows.filter((m) => m.permit_id === permit.id),
        })),
      );
    }),
  );

  router.post(
    "/projects/:id/permits",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "advance_stage");
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      const body = parseBody(createPermitSchema, ctx.req.body);
      await requireOwnedRow(
        ctx.db,
        "jurisdictions",
        body.jurisdiction_id,
        "jurisdiction_id",
      );
      await requireOwnedRow(
        ctx.db,
        "vendors",
        body.pulled_by_vendor_id,
        "pulled_by_vendor_id",
      );

      const { rows } = await ctx.db.query<{ id: string }>(
        `INSERT INTO projects.permits
           (tenant_id, project_id, jurisdiction_id, permit_type, permit_number,
            pulled_by_vendor_id, applied_on, not_required, not_required_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          ctx.staff.tenantId,
          projectId,
          body.jurisdiction_id,
          body.permit_type,
          body.permit_number ?? null,
          body.pulled_by_vendor_id ?? null,
          body.applied_on ?? null,
          body.not_required,
          body.not_required_reason ?? null,
        ],
      );
      const permitId = rows[0]!.id;

      // Milestones are seeded from the tenant's template, offsets applied to
      // the application date where the template gives one. A permit without
      // its chain is the thing the chain exists to prevent.
      const seeded = await ctx.db.query<{ n: string }>(
        `INSERT INTO projects.permit_milestones
           (tenant_id, permit_id, sequence_number, name, owner_role, due_on)
         SELECT t.tenant_id, $1, t.sequence_number, t.name, t.owner_role,
                CASE WHEN t.offset_days IS NULL OR $2::date IS NULL THEN NULL
                     ELSE $2::date + t.offset_days END
           FROM projects.permit_milestone_templates t
          WHERE t.tenant_id = $3
          ORDER BY t.sequence_number
         RETURNING 1 AS n`,
        [permitId, body.applied_on ?? null, ctx.staff.tenantId],
      );

      sendData(
        ctx.res,
        {
          id: permitId,
          milestones_created: seeded.rowCount || seeded.rows.length,
        },
        undefined,
        201,
      );
    }),
  );

  router.patch(
    "/permits/:id",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "advance_stage");
      const permitId = parseUuidParam(ctx.req.params.id, "Permit");
      const permit = await loadVisiblePermit(ctx, permitId);
      const body = parseBody(
        z.object({
          permit_number: z.string().nullish(),
          issued_on: z.string().date().nullish(),
          fee_amount: z.number().min(0).nullish(),
        }),
        ctx.req.body,
      );
      const entries = Object.entries(body).filter(([, v]) => v !== undefined);
      if (entries.length === 0) {
        sendData(ctx.res, permit);
        return;
      }
      const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(", ");
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.permits SET ${sets} WHERE id = $1
         RETURNING id, permit_type, permit_number, applied_on, issued_on, fee_amount`,
        [permitId, ...entries.map(([, v]) => v)],
      );
      sendData(ctx.res, rows[0]);
    }),
  );

  router.patch(
    "/permit-milestones/:id",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "advance_stage");
      const milestoneId = parseUuidParam(ctx.req.params.id, "Milestone");
      const body = parseBody(milestoneSchema, ctx.req.body);

      const existing = await ctx.db.query<{ permit_id: string }>(
        `SELECT permit_id FROM projects.permit_milestones WHERE id = $1`,
        [milestoneId],
      );
      if (!existing.rows[0]) throw notFound("Milestone not found");
      await loadVisiblePermit(ctx, existing.rows[0].permit_id);

      // A failed inspection is a status, not a delete. The re-inspection is
      // the same milestone changing state, and the failure stays on the record
      // because that is the part anyone will later need to explain.
      const completing = body.status === "complete";
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.permit_milestones
            SET status = $2::projects.milestone_status,
                due_on = COALESCE($3::date, due_on),
                note = COALESCE($4, note),
                completed_at = CASE WHEN $5 THEN now() ELSE NULL END,
                completed_by = CASE WHEN $5 THEN $6::uuid ELSE NULL END
          WHERE id = $1
          RETURNING id, sequence_number, name, status::text AS status, due_on,
                    completed_at, note`,
        [
          milestoneId,
          body.status,
          body.due_on ?? null,
          body.note ?? null,
          completing,
          ctx.staff.staffId,
        ],
      );
      sendData(ctx.res, rows[0]);
    }),
  );

  router.get(
    "/exceptions/permits",
    staffRoute(deps, async (ctx) => {
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT id, project_id, project_number, jurisdiction, milestone, due_on, days_overdue
           FROM projects.v_permit_exceptions ORDER BY days_overdue DESC`,
      );
      sendData(ctx.res, rows);
    }),
  );

  // ----------------------------------------------------------- schedule ----
  router.get(
    "/projects/:id/schedule",
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT s.id, s.title, s.window_start, s.window_end, s.status::text AS status,
                s.confirmed_at, s.confirmed_by_portal, s.depends_on, s.phase, s.trade, s.activity_type, s.job_link_id,
                s.vendor_id, v.legal_name AS vendor_name,
                s.staff_id, st.full_name AS staff_name,
                s.cost_code_id, cc.code AS cost_code,
                COALESCE(e.schedulable, true) AS vendor_schedulable,
                e.expired_count, e.missing_count, e.next_expiry
           FROM projects.schedule_items s
           LEFT JOIN projects.vendors v  ON v.id = s.vendor_id
           LEFT JOIN projects.staff st   ON st.id = s.staff_id
           LEFT JOIN projects.cost_codes cc ON cc.id = s.cost_code_id
           LEFT JOIN projects.v_vendor_eligibility e ON e.vendor_id = s.vendor_id
          WHERE s.project_id = $1
          ORDER BY s.window_start, s.title`,
        [projectId],
      );
      sendData(ctx.res, await enrichSchedule(ctx, rows));
    }),
  );

  router.post(
    "/projects/:id/schedule",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "advance_stage");
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      const body = parseBody(scheduleItemSchema, ctx.req.body);
      const dependencies = await validatePlanning(ctx, projectId, body);
      await requireOwnedRow(ctx.db, "vendors", body.vendor_id, "vendor_id");
      await requireOwnedRow(
        ctx.db,
        "cost_codes",
        body.cost_code_id,
        "cost_code_id",
      );
      await requireStaffOfTenant(ctx.db, body.staff_id, "staff_id");

      if (body.window_end < body.window_start) {
        throw new ApiError(
          "validation_failed",
          "The window ends before it starts.",
          [{ field: "window_end", message: "Must not be before window_start" }],
        );
      }

      // The database trigger blocks confirming an ineligible vendor and the
      // error handler maps it to 409 compliance_blocked. Not duplicated here:
      // the trigger is the control, and a second copy in the handler is a
      // second copy that will disagree.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `INSERT INTO projects.schedule_items
           (tenant_id, project_id, title, cost_code_id, vendor_id, staff_id,
            window_start, window_end, status, depends_on, phase, job_link_id, trade, activity_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::projects.sched_status,$10,$11,$12,$13,$14)
         RETURNING id, title, window_start, window_end, status::text AS status`,
        [
          ctx.staff.tenantId,
          projectId,
          body.title,
          body.cost_code_id ?? null,
          body.vendor_id ?? null,
          body.staff_id ?? null,
          body.window_start,
          body.window_end,
          body.status,
          null,
          body.phase ?? null,
          body.job_link_id ?? null,
          body.trade ?? null,
          body.activity_type ?? null,
        ],
      );
      await savePlanning(
        ctx,
        projectId,
        String(rows[0]!.id),
        body.resource_ids,
        dependencies,
      );
      sendData(ctx.res, rows[0], undefined, 201);
    }),
  );

  router.patch(
    "/schedule/:id",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "advance_stage");
      const itemId = parseUuidParam(ctx.req.params.id, "Schedule item");
      const existing = await ctx.db.query<{
        project_id: string;
        window_start: string;
        window_end: string;
      }>(
        `SELECT project_id, window_start, window_end FROM projects.schedule_items WHERE id = $1`,
        [itemId],
      );
      if (!existing.rows[0]) throw notFound("Schedule item not found");
      await loadVisibleProject(ctx, existing.rows[0].project_id, "id");

      const body = parseBody(
        z.object({
          ...planningFields,
          depends_on: z.string().uuid().nullish(),
          title: z.string().min(1).optional(),
          expected_window_start: z.string().date().optional(),
          expected_window_end: z.string().date().optional(),
          window_start: z.string().date().optional(),
          window_end: z.string().date().optional(),
          status: z
            .enum([
              "proposed",
              "confirmed",
              "in_progress",
              "complete",
              "cancelled",
            ])
            .optional(),
          vendor_id: z.string().uuid().nullish(),
        }),
        ctx.req.body,
      );
      await requireOwnedRow(ctx.db, "vendors", body.vendor_id, "vendor_id");

      const dependencies = await validatePlanning(
        ctx,
        existing.rows[0].project_id,
        body,
        itemId,
      );
      const beforeSchedule = await scheduleSnapshot(ctx.db, existing.rows[0].project_id);
      const latest = beforeSchedule.find(r=>r.id===itemId)!;
      if((body.expected_window_start && body.expected_window_start!==latest.window_start)||(body.expected_window_end && body.expected_window_end!==latest.window_end)) throw new ApiError("conflict","This activity changed. Refresh the schedule before moving it.");
      existing.rows[0].window_start=latest.window_start;existing.rows[0].window_end=latest.window_end;
      if (
        (body.window_start ?? existing.rows[0].window_start) >
        (body.window_end ?? existing.rows[0].window_end)
      ) {
        throw new ApiError(
          "validation_failed",
          "The window ends before it starts.",
        );
      }
      const {
        expected_window_start, expected_window_end,
        resource_ids,
        dependencies: ignored,
        depends_on,
        ...columns
      } = body;
      const entries = Object.entries(columns).filter(
        ([, v]) => v !== undefined,
      );
      if (
        entries.length === 0 &&
        resource_ids === undefined &&
        dependencies === undefined
      )
        throw new ApiError("validation_failed", "Nothing to change.");
      // Lock the schedule row before replacing assignments, serializing changes
      // with confirmation and keeping compliance checks in the same transaction.
      await ctx.db.query(
        "SELECT id FROM projects.schedule_items WHERE id = $1 FOR UPDATE",
        [itemId],
      );
      if (!entries.length) {
        await savePlanning(
          ctx,
          existing.rows[0].project_id,
          itemId,
          resource_ids,
          dependencies,
        );
        const shifted = await cascadeSchedule(ctx.db, existing.rows[0].project_id, beforeSchedule, itemId);
        sendData(ctx.res, { id: itemId, shifted });
        return;
      }

      const sets = entries
        .map(([k], i) =>
          k === "status"
            ? `status = $${i + 2}::projects.sched_status`
            : `${k} = $${i + 2}`,
        )
        .join(", ");
      const confirming =
        body.status === "confirmed" ? ", confirmed_at = now()" : "";

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.schedule_items SET ${sets}${confirming} WHERE id = $1
         RETURNING id, title, window_start, window_end, status::text AS status,
                   confirmed_at, vendor_id`,
        [itemId, ...entries.map(([, v]) => v)],
      );
      await savePlanning(
        ctx,
        existing.rows[0].project_id,
        itemId,
        resource_ids,
        dependencies,
      );
      const shifted = (body.window_start || body.window_end || dependencies !== undefined) ? await cascadeSchedule(ctx.db, existing.rows[0].project_id, beforeSchedule, itemId) : [];
      sendData(ctx.res, {...rows[0], ...shifted.find(r=>r.id===itemId), shifted});
    }),
  );

  // --------------------------------------------------------- daily logs ----
  router.get(
    "/projects/:id/daily-logs",
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT l.id, l.log_date, l.crew_on_site, l.vendors_on_site, l.work_completed,
                l.delays, l.delay_cause, l.deliveries, l.inspections,
                l.client_interaction, l.safety_note, l.weather,
                s.full_name AS author
           FROM projects.daily_logs l
           JOIN projects.staff s ON s.id = l.author_id
          WHERE l.project_id = $1
          ORDER BY l.log_date DESC
          LIMIT 60`,
        [projectId],
      );
      sendData(ctx.res, rows);
    }),
  );

  router.post(
    "/projects/:id/daily-logs",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "write_daily_log");
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      const body = parseBody(dailyLogSchema, ctx.req.body);

      // One per project per date; the unique constraint produces the 409.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `INSERT INTO projects.daily_logs
           (tenant_id, project_id, log_date, author_id, crew_on_site, vendors_on_site,
            work_completed, delays, delay_cause, deliveries, inspections,
            client_interaction, safety_note, weather)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id, log_date, work_completed`,
        [
          ctx.staff.tenantId,
          projectId,
          body.log_date,
          ctx.staff.staffId,
          body.crew_on_site ?? null,
          body.vendors_on_site,
          body.work_completed ?? null,
          body.delays ?? null,
          body.delay_cause ?? null,
          body.deliveries ?? null,
          body.inspections ?? null,
          body.client_interaction ?? null,
          body.safety_note ?? null,
          body.weather ?? null,
        ],
      );
      sendData(ctx.res, rows[0], undefined, 201);
    }),
  );

  router.get(
    "/exceptions/daily-logs",
    staffRoute(deps, async (ctx) => {
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT project_id, project_number, name, pm_id
           FROM projects.v_missing_daily_logs ORDER BY project_number`,
      );
      sendData(ctx.res, rows);
    }),
  );

  // -------------------------------------------------------- jurisdictions --
  router.get(
    "/jurisdictions",
    staffRoute(deps, async (ctx) => {
      const { rows } = await ctx.db.query<{ id: string }>(
        `SELECT ${OFFICE_COLUMNS} FROM projects.jurisdictions ORDER BY name, state`,
      );
      sendData(ctx.res, await withContacts(ctx, rows));
    }),
  );

  router.post(
    "/jurisdictions/import",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_permit_offices");
      const offices =
        typeof ctx.req.body === "string"
          ? parsePermitOfficeCsv(ctx.req.body)
          : parsePermitOfficeJson(ctx.req.body);
      if (offices.length === 0) {
        throw new ApiError("validation_failed", "The import file has no offices.");
      }
      sendData(
        ctx.res,
        await importPermitOffices(ctx.db, ctx.staff.tenantId, offices),
      );
    }),
  );

  router.post(
    "/jurisdictions",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_permit_offices");
      const body = parseBody(officeWriteSchema, ctx.req.body);
      const { rows } = await ctx.db.query<{ id: string }>(
        `INSERT INTO projects.jurisdictions
           (tenant_id, name, state, office_name, address_line1, address_line2, office_city,
            postal_code, contact_phone, website_url, portal_url, work_requiring_permit,
            required_documents, plan_requirements, fee_notes, fee_schedule_url,
            typical_review_days, inspection_method, inspection_phone, inspection_url,
            notes, last_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         RETURNING id`,
        officeValues(ctx.staff.tenantId, body),
      );
      sendData(ctx.res, await loadOffice(ctx, rows[0]!.id), undefined, 201);
    }),
  );

  router.get(
    "/jurisdictions/:id",
    staffRoute(deps, async (ctx) => {
      const id = parseUuidParam(ctx.req.params.id, "Permit office");
      sendData(ctx.res, await loadOffice(ctx, id));
    }),
  );

  router.patch(
    "/jurisdictions/:id",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_permit_offices");
      const id = parseUuidParam(ctx.req.params.id, "Permit office");
      await loadOffice(ctx, id);
      const body = parseBody(officePatchSchema, ctx.req.body);
      const entries = Object.entries(patchColumns(body)).filter(([, value]) => value !== undefined);
      if (entries.length) {
        const sets = entries.map(([column], index) => `${column} = $${index + 2}`).join(", ");
        await ctx.db.query(
          `UPDATE projects.jurisdictions SET ${sets} WHERE id = $1`,
          [id, ...entries.map(([, value]) => value)],
        );
      }
      sendData(ctx.res, await loadOffice(ctx, id));
    }),
  );

  router.post(
    "/jurisdictions/:id/contacts",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_permit_offices");
      const id = parseUuidParam(ctx.req.params.id, "Permit office");
      await loadOffice(ctx, id);
      const body = parseBody(contactWriteSchema, ctx.req.body);
      const { rows } = await ctx.db.query<{ id: string }>(
        `INSERT INTO projects.jurisdiction_contacts
           (tenant_id, jurisdiction_id, name, title, phone, email, notes, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
           (SELECT coalesce(max(sort_order), -1) + 1 FROM projects.jurisdiction_contacts WHERE jurisdiction_id = $2))
         RETURNING id`,
        [
          ctx.staff.tenantId,
          id,
          body.name,
          body.title ?? body.role ?? null,
          body.phone ?? null,
          body.email ?? null,
          body.notes ?? null,
        ],
      );
      sendData(ctx.res, await loadContact(ctx, rows[0]!.id), undefined, 201);
    }),
  );

  router.patch(
    "/jurisdiction-contacts/:id",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_permit_offices");
      const id = parseUuidParam(ctx.req.params.id, "Contact");
      await loadContact(ctx, id);
      const body = parseBody(contactPatchSchema, ctx.req.body);
      const entries = Object.entries(contactColumns(body)).filter(([, value]) => value !== undefined);
      if (entries.length) {
        const sets = entries.map(([column], index) => `${column} = $${index + 2}`).join(", ");
        await ctx.db.query(
          `UPDATE projects.jurisdiction_contacts SET ${sets} WHERE id = $1`,
          [id, ...entries.map(([, value]) => value)],
        );
      }
      sendData(ctx.res, await loadContact(ctx, id));
    }),
  );

  router.delete(
    "/jurisdiction-contacts/:id",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_permit_offices");
      const id = parseUuidParam(ctx.req.params.id, "Contact");
      await loadContact(ctx, id);
      await ctx.db.query(`DELETE FROM projects.jurisdiction_contacts WHERE id = $1`, [id]);
      sendData(ctx.res, { id, deleted: true });
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------

const OFFICE_COLUMNS = `id, name, state, office_name, address_line1, address_line2, office_city,
  postal_code, contact_phone, website_url, portal_url, work_requiring_permit, required_documents,
  plan_requirements, fee_notes, fee_schedule_url, typical_review_days, inspection_method,
  inspection_phone, inspection_url, notes, last_verified::text AS last_verified,
  inspection_cutoff_time`;

const clearable = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => {
      if (value == null) return value;
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    });

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => /^https?:\/\//i.test(value), "Use an http or https URL");

const optionalUrl = z.union([httpUrl, z.null()]).optional();

const stateSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, "Use a two-letter state"));

const officeFields = {
  office_name: clearable(200),
  address_line1: clearable(200),
  address_line2: clearable(200),
  office_city: clearable(200),
  postal_code: clearable(20),
  contact_phone: clearable(80),
  website_url: optionalUrl,
  portal_url: optionalUrl,
  work_requiring_permit: clearable(4000),
  required_documents: clearable(4000),
  plan_requirements: clearable(4000),
  fee_notes: clearable(4000),
  fee_schedule_url: optionalUrl,
  typical_review_days: z.number().int().min(0).max(3650).nullable().optional(),
  inspection_method: z
    .enum(["phone", "portal", "email", "in_person", "other"])
    .nullable()
    .optional(),
  inspection_phone: clearable(80),
  inspection_url: optionalUrl,
  notes: clearable(2000),
  last_verified: z.string().date().nullable().optional(),
};

const officeWriteSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    state: stateSchema,
    ...officeFields,
  })
  .strict();

const officePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    state: stateSchema.optional(),
    ...officeFields,
  })
  .strict();

const contactFields = {
  title: clearable(200),
  role: clearable(200),
  phone: clearable(80),
  email: clearable(200),
  notes: clearable(2000),
};

const contactWriteSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    ...contactFields,
  })
  .strict();

const contactPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    ...contactFields,
  })
  .strict();

type OfficeWrite = z.infer<typeof officeWriteSchema>;

function officeValues(tenantId: string, body: OfficeWrite): unknown[] {
  return [
    tenantId,
    body.name,
    body.state,
    body.office_name ?? null,
    body.address_line1 ?? null,
    body.address_line2 ?? null,
    body.office_city ?? null,
    body.postal_code ?? null,
    body.contact_phone ?? null,
    body.website_url ?? null,
    body.portal_url ?? null,
    body.work_requiring_permit ?? null,
    body.required_documents ?? null,
    body.plan_requirements ?? null,
    body.fee_notes ?? null,
    body.fee_schedule_url ?? null,
    body.typical_review_days ?? null,
    body.inspection_method ?? null,
    body.inspection_phone ?? null,
    body.inspection_url ?? null,
    body.notes ?? null,
    body.last_verified ?? null,
  ];
}

function patchColumns(body: z.infer<typeof officePatchSchema>): Record<string, unknown> {
  return {
    name: body.name,
    state: body.state,
    office_name: body.office_name,
    address_line1: body.address_line1,
    address_line2: body.address_line2,
    office_city: body.office_city,
    postal_code: body.postal_code,
    contact_phone: body.contact_phone,
    website_url: body.website_url,
    portal_url: body.portal_url,
    work_requiring_permit: body.work_requiring_permit,
    required_documents: body.required_documents,
    plan_requirements: body.plan_requirements,
    fee_notes: body.fee_notes,
    fee_schedule_url: body.fee_schedule_url,
    typical_review_days: body.typical_review_days,
    inspection_method: body.inspection_method,
    inspection_phone: body.inspection_phone,
    inspection_url: body.inspection_url,
    notes: body.notes,
    last_verified: body.last_verified,
  };
}

function contactColumns(body: {
  name?: string;
  title?: string | null;
  role?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
}): Record<string, unknown> {
  const title = body.title !== undefined ? body.title : body.role;
  return {
    name: body.name,
    title,
    phone: body.phone,
    email: body.email,
    notes: body.notes,
  };
}

async function withContacts<T extends { id: string }>(
  ctx: StaffContext,
  offices: T[],
): Promise<Array<T & { contacts: ContactRow[] }>> {
  if (offices.length === 0) return [];
  const contacts = await ctx.db.query<ContactRow & { jurisdiction_id: string }>(
    `SELECT id, jurisdiction_id, name, title, phone, email, notes, sort_order
       FROM projects.jurisdiction_contacts
      WHERE jurisdiction_id = ANY($1::uuid[])
      ORDER BY sort_order, name, id`,
    [offices.map((office) => office.id)],
  );
  const byOffice = new Map<string, ContactRow[]>();
  for (const contact of contacts.rows) {
    const list = byOffice.get(contact.jurisdiction_id) ?? [];
    list.push({
      id: contact.id,
      name: contact.name,
      title: contact.title,
      phone: contact.phone,
      email: contact.email,
      notes: contact.notes,
      sort_order: contact.sort_order,
    });
    byOffice.set(contact.jurisdiction_id, list);
  }
  return offices.map((office) => ({
    ...office,
    contacts: byOffice.get(office.id) ?? [],
  }));
}

async function loadOffice(ctx: StaffContext, id: string) {
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT ${OFFICE_COLUMNS} FROM projects.jurisdictions WHERE id = $1`,
    [id],
  );
  const office = rows[0];
  if (!office) throw notFound("Permit office not found");
  const [withPeople] = await withContacts(ctx, [office]);
  return withPeople!;
}

interface ContactRow {
  id: string;
  name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  sort_order: number;
}

async function loadContact(ctx: StaffContext, id: string): Promise<ContactRow> {
  const { rows } = await ctx.db.query<ContactRow>(
    `SELECT id, name, title, phone, email, notes, sort_order
       FROM projects.jurisdiction_contacts WHERE id = $1`,
    [id],
  );
  const contact = rows[0];
  if (!contact) throw notFound("Contact not found");
  return contact;
}

async function loadVisiblePermit(
  ctx: StaffContext,
  permitId: string,
): Promise<Record<string, unknown>> {
  const { rows } = await ctx.db.query<
    { project_id: string } & Record<string, unknown>
  >(
    `SELECT id, project_id, permit_type, permit_number, applied_on, issued_on, fee_amount
       FROM projects.permits WHERE id = $1`,
    [permitId],
  );
  const permit = rows[0];
  if (!permit) throw notFound("Permit not found");
  await loadVisibleProject(ctx, permit.project_id, "id");
  return permit;
}
