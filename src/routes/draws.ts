import { Router } from 'express';
import { z } from 'zod';
import { sendData } from '../http/envelope.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireCapability } from '../http/capabilities.js';
import { staffRoute, type StaffContext, type StaffRouterDeps } from '../http/staffSession.js';
import { loadVisibleProject, num, parseBody, parseUuidParam } from './shared.js';
import { resolveAdapter } from '../adapters/externalSystem.js';

const drawScheduleSchema = z.object({
  draws: z
    .array(
      z.object({
        label: z.string().min(1),
        trigger_milestone: z.string().min(1),
        amount: z.number().positive(),
      }),
    )
    .min(1),
});

const externalInvoiceSchema = z.object({
  external_invoice_number: z.string().trim().min(1),
});

export function drawRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    '/projects/:id/draws',
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      const project = await loadVisibleProject<{ external_system_id: string | null }>(
        ctx,
        projectId,
        'id, external_system_id',
      );
      const adapter = await resolveAdapter(ctx.db, project.external_system_id);

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        // is_retainage and the applied total travel with the draw: the console
        // cannot mark money as held rather than merely unbilled without them,
        // and a milestone satisfied by nine technician visits has an applied
        // total the scalar invoice number never showed.
        `SELECT d.id, d.sequence_number, d.label, d.trigger_milestone, d.amount,
                d.status::text AS status, d.earned_at, d.approved_by, d.approved_at,
                d.external_invoice_number, d.external_invoice_recorded_at,
                d.external_invoice_verified_at, d.is_retainage,
                v.applied_amount, v.unapplied_amount, v.invoice_count
           FROM projects.draws d
           JOIN projects.v_draw_application v ON v.draw_id = d.id
          WHERE d.project_id = $1 ORDER BY d.sequence_number`,
        [projectId],
      );

      sendData(ctx.res, {
        // The client hides the verify action rather than offering something
        // that cannot work. A manual-adapter tenant sees false.
        revenue_system: adapter.displayName,
        verification_available: adapter.verifyInvoices,
        draws: rows.map(serialiseDraw),
      });
    }),
  );

  router.post(
    '/projects/:id/draws',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'edit_budget_before_freeze');
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
      const body = parseBody(drawScheduleSchema, ctx.req.body);

      // "Create or replace the schedule" (§3.6). Replace only touches draws
      // that have not been earned — a draw that has been approved or invoiced
      // is a revenue event, and rewriting the schedule must not silently
      // delete one.
      const committed = await ctx.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.draws
          WHERE project_id = $1 AND status <> 'scheduled'`,
        [projectId],
      );
      if (Number(committed.rows[0]?.n ?? 0) > 0) {
        throw new ApiError(
          'conflict',
          'This project has draws that are already earned or invoiced. ' +
            'Amend them individually rather than replacing the schedule.',
          { committed_draws: Number(committed.rows[0]!.n) },
        );
      }

      await ctx.db.query(`DELETE FROM projects.draws WHERE project_id = $1`, [projectId]);

      const created: Record<string, unknown>[] = [];
      let sequence = 1;
      for (const draw of body.draws) {
        const { rows } = await ctx.db.query<Record<string, unknown>>(
          `INSERT INTO projects.draws
             (tenant_id, project_id, sequence_number, label, trigger_milestone, amount)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id, sequence_number, label, trigger_milestone, amount,
                     status::text AS status`,
          [
            ctx.staff.tenantId,
            projectId,
            sequence++,
            draw.label,
            draw.trigger_milestone,
            draw.amount,
          ],
        );
        created.push(serialiseDraw(rows[0]!));
      }

      sendData(ctx.res, created, undefined, 201);
    }),
  );

  router.post(
    '/draws/:id/earn',
    staffRoute(deps, async (ctx) => {
      const drawId = parseUuidParam(ctx.req.params.id, 'Draw');
      const draw = await loadVisibleDraw(ctx, drawId);
      if (draw.status !== 'scheduled') {
        throw new ApiError('conflict', `That draw is already ${draw.status}.`);
      }
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.draws SET status = 'earned', earned_at = now()
          WHERE id = $1
          RETURNING id, label, amount, status::text AS status, earned_at`,
        [drawId],
      );
      sendData(ctx.res, serialiseDraw(rows[0]!));
    }),
  );

  router.post(
    '/draws/:id/approve',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'approve_draw');
      const drawId = parseUuidParam(ctx.req.params.id, 'Draw');
      const draw = await loadVisibleDraw(ctx, drawId);
      if (draw.status === 'scheduled') {
        throw new ApiError(
          'conflict',
          'Mark the milestone reached before approving the draw.',
          { status: draw.status },
        );
      }
      if (draw.status !== 'earned') {
        throw new ApiError('conflict', `That draw is already ${draw.status}.`);
      }
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.draws SET status = 'approved', approved_by = $2, approved_at = now()
          WHERE id = $1
          RETURNING id, label, amount, status::text AS status, approved_at`,
        [drawId, ctx.staff.staffId],
      );
      sendData(ctx.res, serialiseDraw(rows[0]!));
    }),
  );

  router.post(
    '/draws/:id/external-invoice',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'record_external_invoice');
      const drawId = parseUuidParam(ctx.req.params.id, 'Draw');
      const draw = await loadVisibleDraw(ctx, drawId);
      const body = parseBody(externalInvoiceSchema, ctx.req.body);

      if (draw.external_invoice_number) {
        throw new ApiError(
          'draw_already_invoiced',
          `That draw already records invoice ${draw.external_invoice_number}.`,
          { external_invoice_number: draw.external_invoice_number },
        );
      }

      // Shortcut for the common case: someone billed this draw in ServiceTitan,
      // and here is that invoice number. This stores the number on a local
      // project_invoices row. It does not create or write a customer invoice
      // to ServiceTitan or QuickBooks.
      //
      // Use POST /draws/:id/invoice and POST /invoices/:id/external-ref when
      // the local row and the recorded number happen at different times.
      const existing = await ctx.db.query<{ id: string }>(
        `SELECT id FROM projects.project_invoices
          WHERE draw_id = $1 AND status <> 'void'`,
        [drawId],
      );
      if (existing.rows[0]) {
        await ctx.db.query(
          `UPDATE projects.project_invoices
              SET external_ref = $2, external_recorded_at = now()
            WHERE id = $1 AND external_ref IS NULL`,
          [existing.rows[0].id, body.external_invoice_number],
        );
      } else {
        const project = await ctx.db.query<{ project_number: string }>(
          `SELECT project_number FROM projects.projects WHERE id = $1`,
          [draw.project_id],
        );
        const next = await ctx.db.query<{ n: number }>(
          `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS n
             FROM projects.project_invoices WHERE project_id = $1`,
          [draw.project_id],
        );
        const sequence = next.rows[0]!.n;
        await ctx.db.query(
          `INSERT INTO projects.project_invoices
             (tenant_id, project_id, invoice_number, sequence_number, draw_id, amount,
              description, external_ref, external_recorded_at, issued_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9)`,
          [
            ctx.staff.tenantId,
            draw.project_id,
            `${project.rows[0]!.project_number}-${String(sequence).padStart(2, '0')}`,
            sequence,
            drawId,
            num(draw.amount) ?? 0,
            `${draw.label ?? 'Draw'} — ${draw.trigger_milestone ?? ''}`.trim(),
            body.external_invoice_number,
            ctx.staff.staffId,
          ],
        );
      }

      // recorded_at, verified_at and status are all set by the database
      // trigger. Deliberately not repeated here — two implementations of a
      // stamp is one implementation that drifts.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.draws SET external_invoice_number = $2,
                external_invoice_recorded_by = $3
          WHERE id = $1
          RETURNING id, status::text AS status, amount, external_invoice_number,
                    external_invoice_recorded_at, external_invoice_verified_at`,
        [drawId, body.external_invoice_number, ctx.staff.staffId],
      );

      const project = await ctx.db.query<{ external_system_id: string | null }>(
        `SELECT external_system_id FROM projects.projects WHERE id = $1`,
        [draw.project_id],
      );
      const adapter = await resolveAdapter(ctx.db, project.rows[0]?.external_system_id ?? null);

      sendData(ctx.res, {
        ...serialiseDraw(rows[0]!),
        // Recording is a human assertion; verification is a separate call.
        verification_available: adapter.verifyInvoices,
      });
    }),
  );

  router.post(
    '/draws/:id/verify',
    staffRoute(deps, async (ctx) => {
      const drawId = parseUuidParam(ctx.req.params.id, 'Draw');
      const draw = await loadVisibleDraw(ctx, drawId);
      if (!draw.external_invoice_number) {
        throw new ApiError('conflict', 'No invoice number has been recorded for that draw.');
      }

      const project = await ctx.db.query<{
        external_system_id: string | null;
        external_job_id: string | null;
      }>(`SELECT external_system_id, external_job_id FROM projects.projects WHERE id = $1`, [
        draw.project_id,
      ]);
      const adapter = await resolveAdapter(ctx.db, project.rows[0]?.external_system_id ?? null);

      const result = await adapter.verifyInvoice({
        invoiceNumber: draw.external_invoice_number,
        externalJobId: project.rows[0]?.external_job_id ?? null,
        drawAmount: num(draw.amount) ?? 0,
      });

      // Only stamp verified_at when every check passed. A failed check is a
      // 200 with verified false, not an error — the mismatch is information
      // the office needs, not a system fault.
      if (result.verified) {
        await ctx.db.query(
          `UPDATE projects.draws SET external_invoice_verified_at = now() WHERE id = $1`,
          [drawId],
        );
      }

      sendData(ctx.res, {
        ...result,
        verification_available: adapter.verifyInvoices,
        revenue_system: adapter.displayName,
      });
    }),
  );

  router.get(
    '/exceptions/draws',
    staffRoute(deps, async (ctx) => {
      // The control this module exists to surface: the gap between a draw
      // being approved and the money actually being invoiced somewhere else.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT draw_id, project_id, project_number, project_name, label, amount,
                approved_at, days_since_approval
           FROM projects.v_draw_exceptions
          ORDER BY days_since_approval DESC`,
      );
      sendData(
        ctx.res,
        rows.map((r) => ({ ...r, amount: num(r.amount) })),
      );
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------

interface DrawRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  status: string;
  amount: string;
  external_invoice_number: string | null;
}

async function loadVisibleDraw(ctx: StaffContext, drawId: string): Promise<DrawRow> {
  const { rows } = await ctx.db.query<DrawRow>(
    `SELECT id, project_id, sequence_number, label, trigger_milestone, amount,
            status::text AS status, external_invoice_number
       FROM projects.draws WHERE id = $1`,
    [drawId],
  );
  const draw = rows[0];
  if (!draw) throw notFound('Draw not found');
  await loadVisibleProject(ctx, draw.project_id, 'id');
  return draw;
}

function serialiseDraw(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    amount: num(row.amount),
    ...(row.applied_amount === undefined
      ? {}
      : {
          applied_amount: num(row.applied_amount),
          unapplied_amount: num(row.unapplied_amount),
          invoice_count: Number(row.invoice_count ?? 0),
        }),
  };
}
