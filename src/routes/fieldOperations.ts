import { Router } from 'express';
import { z } from 'zod';
import { sendData } from '../http/envelope.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireCapability } from '../http/capabilities.js';
import { staffRoute, type StaffContext, type StaffRouterDeps } from '../http/staffSession.js';
import {
  loadVisibleProject,
  parseBody,
  parseUuidParam,
  requireOwnedRow,
  requireStaffOfTenant,
} from './shared.js';

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
    message: 'A permit marked not required needs a reason',
    path: ['not_required_reason'],
  });

const milestoneSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'complete', 'not_applicable', 'failed']),
  due_on: z.string().date().nullish(),
  note: z.string().nullish(),
});

const scheduleItemSchema = z.object({
  title: z.string().min(1),
  cost_code_id: z.string().uuid().nullish(),
  vendor_id: z.string().uuid().nullish(),
  staff_id: z.string().uuid().nullish(),
  window_start: z.string().date(),
  window_end: z.string().date(),
  status: z.enum(['proposed', 'confirmed', 'in_progress', 'complete', 'cancelled']).default(
    'proposed',
  ),
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
    '/projects/:id/permits',
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
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
    '/projects/:id/permits',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'advance_stage');
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
      const body = parseBody(createPermitSchema, ctx.req.body);
      await requireOwnedRow(ctx.db, 'jurisdictions', body.jurisdiction_id, 'jurisdiction_id');
      await requireOwnedRow(ctx.db, 'vendors', body.pulled_by_vendor_id, 'pulled_by_vendor_id');

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
        { id: permitId, milestones_created: seeded.rowCount || seeded.rows.length },
        undefined,
        201,
      );
    }),
  );

  router.patch(
    '/permits/:id',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'advance_stage');
      const permitId = parseUuidParam(ctx.req.params.id, 'Permit');
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
      const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.permits SET ${sets} WHERE id = $1
         RETURNING id, permit_type, permit_number, applied_on, issued_on, fee_amount`,
        [permitId, ...entries.map(([, v]) => v)],
      );
      sendData(ctx.res, rows[0]);
    }),
  );

  router.patch(
    '/permit-milestones/:id',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'advance_stage');
      const milestoneId = parseUuidParam(ctx.req.params.id, 'Milestone');
      const body = parseBody(milestoneSchema, ctx.req.body);

      const existing = await ctx.db.query<{ permit_id: string }>(
        `SELECT permit_id FROM projects.permit_milestones WHERE id = $1`,
        [milestoneId],
      );
      if (!existing.rows[0]) throw notFound('Milestone not found');
      await loadVisiblePermit(ctx, existing.rows[0].permit_id);

      // A failed inspection is a status, not a delete. The re-inspection is
      // the same milestone changing state, and the failure stays on the record
      // because that is the part anyone will later need to explain.
      const completing = body.status === 'complete';
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
    '/exceptions/permits',
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
    '/projects/:id/schedule',
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT s.id, s.title, s.window_start, s.window_end, s.status::text AS status,
                s.confirmed_at, s.confirmed_by_portal, s.depends_on,
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
      sendData(ctx.res, rows);
    }),
  );

  router.post(
    '/projects/:id/schedule',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'advance_stage');
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
      const body = parseBody(scheduleItemSchema, ctx.req.body);
      await requireOwnedRow(ctx.db, 'vendors', body.vendor_id, 'vendor_id');
      await requireOwnedRow(ctx.db, 'cost_codes', body.cost_code_id, 'cost_code_id');
      await requireStaffOfTenant(ctx.db, body.staff_id, 'staff_id');

      if (body.window_end < body.window_start) {
        throw new ApiError('validation_failed', 'The window ends before it starts.', [
          { field: 'window_end', message: 'Must not be before window_start' },
        ]);
      }

      // The database trigger blocks confirming an ineligible vendor and the
      // error handler maps it to 409 compliance_blocked. Not duplicated here:
      // the trigger is the control, and a second copy in the handler is a
      // second copy that will disagree.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `INSERT INTO projects.schedule_items
           (tenant_id, project_id, title, cost_code_id, vendor_id, staff_id,
            window_start, window_end, status, depends_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::projects.sched_status,$10)
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
          body.depends_on ?? null,
        ],
      );
      sendData(ctx.res, rows[0], undefined, 201);
    }),
  );

  router.patch(
    '/schedule/:id',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'advance_stage');
      const itemId = parseUuidParam(ctx.req.params.id, 'Schedule item');
      const existing = await ctx.db.query<{ project_id: string }>(
        `SELECT project_id FROM projects.schedule_items WHERE id = $1`,
        [itemId],
      );
      if (!existing.rows[0]) throw notFound('Schedule item not found');
      await loadVisibleProject(ctx, existing.rows[0].project_id, 'id');

      const body = parseBody(
        z.object({
          title: z.string().min(1).optional(),
          window_start: z.string().date().optional(),
          window_end: z.string().date().optional(),
          status: z
            .enum(['proposed', 'confirmed', 'in_progress', 'complete', 'cancelled'])
            .optional(),
          vendor_id: z.string().uuid().nullish(),
        }),
        ctx.req.body,
      );
      await requireOwnedRow(ctx.db, 'vendors', body.vendor_id, 'vendor_id');

      const entries = Object.entries(body).filter(([, v]) => v !== undefined);
      if (entries.length === 0) throw new ApiError('validation_failed', 'Nothing to change.');

      const sets = entries
        .map(([k], i) =>
          k === 'status'
            ? `status = $${i + 2}::projects.sched_status`
            : `${k} = $${i + 2}`,
        )
        .join(', ');
      const confirming = body.status === 'confirmed' ? ', confirmed_at = now()' : '';

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.schedule_items SET ${sets}${confirming} WHERE id = $1
         RETURNING id, title, window_start, window_end, status::text AS status,
                   confirmed_at, vendor_id`,
        [itemId, ...entries.map(([, v]) => v)],
      );
      sendData(ctx.res, rows[0]);
    }),
  );

  // --------------------------------------------------------- daily logs ----
  router.get(
    '/projects/:id/daily-logs',
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
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
    '/projects/:id/daily-logs',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'write_daily_log');
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
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
    '/exceptions/daily-logs',
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
    '/jurisdictions',
    staffRoute(deps, async (ctx) => {
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT id, name, portal_url, contact_phone, typical_review_days,
                inspection_cutoff_time, notes
           FROM projects.jurisdictions ORDER BY name`,
      );
      sendData(ctx.res, rows);
    }),
  );

  router.post(
    '/jurisdictions',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'manage_vendors');
      const body = parseBody(
        z.object({
          name: z.string().min(1),
          portal_url: z.string().nullish(),
          contact_phone: z.string().nullish(),
          typical_review_days: z.number().int().min(0).nullish(),
          notes: z.string().nullish(),
        }),
        ctx.req.body,
      );
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `INSERT INTO projects.jurisdictions
           (tenant_id, name, portal_url, contact_phone, typical_review_days, notes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, typical_review_days`,
        [
          ctx.staff.tenantId,
          body.name,
          body.portal_url ?? null,
          body.contact_phone ?? null,
          body.typical_review_days ?? null,
          body.notes ?? null,
        ],
      );
      sendData(ctx.res, rows[0], undefined, 201);
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------

async function loadVisiblePermit(
  ctx: StaffContext,
  permitId: string,
): Promise<Record<string, unknown>> {
  const { rows } = await ctx.db.query<{ project_id: string } & Record<string, unknown>>(
    `SELECT id, project_id, permit_type, permit_number, applied_on, issued_on, fee_amount
       FROM projects.permits WHERE id = $1`,
    [permitId],
  );
  const permit = rows[0];
  if (!permit) throw notFound('Permit not found');
  await loadVisibleProject(ctx, permit.project_id, 'id');
  return permit;
}
