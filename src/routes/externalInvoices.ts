import { Router } from 'express';
import { z } from 'zod';
import { sendData } from '../http/envelope.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireCapability } from '../http/capabilities.js';
import { staffRoute, type StaffContext, type StaffRouterDeps } from '../http/staffSession.js';
import { loadVisibleProject, num, parseBody, parseUuidParam } from './shared.js';

/**
 * Consolidation. In-house technician invoices are generated in the revenue
 * system and nowhere else; this module tracks them and applies them to draws.
 *
 * The shape that matters: an invoice is recorded whether or not anyone has
 * decided what it is for. Refusing to record one until it has a draw is how
 * the ones nobody gets round to filing become invisible — and those are
 * precisely the ones worth finding.
 */

const recordSchema = z.object({
  external_invoice_number: z.string().trim().min(1),
  amount: z.number().finite(),
  project_id: z.string().uuid().nullish(),
  external_job_id: z.string().nullish(),
  external_invoice_id: z.string().nullish(),
  external_system_id: z.string().uuid().nullish(),
  invoiced_on: z.string().date().nullish(),
  paid_on: z.string().date().nullish(),
  description: z.string().nullish(),
});

const applySchema = z.object({
  draw_id: z.string().uuid(),
  // Optional: defaults to whatever of the invoice is still unapplied, which is
  // the answer nearly every time.
  amount_applied: z.number().finite().optional(),
  note: z.string().nullish(),
});

export function externalInvoiceRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.post(
    '/external-invoices',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'record_external_invoice');
      const body = parseBody(recordSchema, ctx.req.body);

      if (body.project_id) await loadVisibleProject(ctx, body.project_id, 'id');

      // If it names a job but no project, try to place it. This is the path a
      // pulled invoice takes: the adapter knows the job id, not our project id.
      let projectId = body.project_id ?? null;
      if (!projectId && body.external_job_id) {
        const match = await ctx.db.query<{ id: string }>(
          `SELECT id FROM projects.projects WHERE external_job_id = $1`,
          [body.external_job_id],
        );
        projectId = match.rows[0]?.id ?? null;
      }

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `INSERT INTO projects.external_invoices
           (tenant_id, external_system_id, project_id, external_invoice_number,
            external_invoice_id, external_job_id, amount, invoiced_on, paid_on,
            description, source, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual',$11)
         RETURNING id, external_invoice_number, project_id, amount, invoiced_on, source`,
        [
          ctx.staff.tenantId,
          body.external_system_id ?? null,
          projectId,
          body.external_invoice_number,
          body.external_invoice_id ?? null,
          body.external_job_id ?? null,
          body.amount,
          body.invoiced_on ?? null,
          body.paid_on ?? null,
          body.description ?? null,
          ctx.staff.staffId,
        ],
      );

      sendData(
        ctx.res,
        {
          ...rows[0],
          amount: num(rows[0]!.amount),
          matched_to_project: Boolean(projectId),
          warning: projectId
            ? null
            : {
                code: 'unmatched_to_project',
                message:
                  'Recorded, but not matched to a project. It will show under ' +
                  'unapplied invoices until somebody says what it is for.',
              },
        },
        undefined,
        201,
      );
    }),
  );

  router.get(
    '/projects/:id/external-invoices',
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');

      const invoices = await ctx.db.query<Record<string, unknown>>(
        `SELECT i.id, i.external_invoice_number, i.amount, i.invoiced_on, i.paid_on,
                i.description, i.source, i.external_job_id,
                COALESCE(a.applied, 0) AS applied_amount,
                i.amount - COALESCE(a.applied, 0) AS unapplied_amount
           FROM projects.external_invoices i
           LEFT JOIN LATERAL (
             SELECT SUM(amount_applied) AS applied
               FROM projects.draw_invoice_applications x WHERE x.external_invoice_id = i.id
           ) a ON true
          WHERE i.project_id = $1
          ORDER BY i.invoiced_on NULLS LAST, i.external_invoice_number`,
        [projectId],
      );

      const draws = await ctx.db.query<Record<string, unknown>>(
        `SELECT draw_id, sequence_number, label, draw_amount, is_retainage,
                status::text AS status, applied_amount, unapplied_amount, invoice_count
           FROM projects.v_draw_application
          WHERE project_id = $1 ORDER BY sequence_number`,
        [projectId],
      );

      sendData(ctx.res, {
        invoices: invoices.rows.map((i) => ({
          ...i,
          amount: num(i.amount),
          applied_amount: num(i.applied_amount),
          unapplied_amount: num(i.unapplied_amount),
        })),
        draws: draws.rows.map((d) => ({
          ...d,
          draw_amount: num(d.draw_amount),
          applied_amount: num(d.applied_amount),
          unapplied_amount: num(d.unapplied_amount),
          invoice_count: Number(d.invoice_count),
        })),
      });
    }),
  );

  router.post(
    '/external-invoices/:id/apply',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'record_external_invoice');
      const invoiceId = parseUuidParam(ctx.req.params.id, 'Invoice');
      const body = parseBody(applySchema, ctx.req.body);

      const invoice = await loadInvoice(ctx, invoiceId);
      const draw = await ctx.db.query<{ id: string; project_id: string; amount: string }>(
        `SELECT id, project_id, amount FROM projects.draws WHERE id = $1`,
        [body.draw_id],
      );
      if (!draw.rows[0]) throw notFound('Draw not found');
      await loadVisibleProject(ctx, draw.rows[0].project_id, 'id');

      // An invoice belonging to one project cannot satisfy another project's
      // draw. Both are inside the tenant, so RLS does not catch this — it is a
      // correctness rule, not an isolation one.
      if (invoice.project_id && invoice.project_id !== draw.rows[0].project_id) {
        throw new ApiError(
          'conflict',
          'That invoice belongs to a different project.',
          { invoice_project_id: invoice.project_id, draw_project_id: draw.rows[0].project_id },
        );
      }

      const alreadyApplied = await ctx.db.query<{ applied: string | null }>(
        `SELECT SUM(amount_applied) AS applied FROM projects.draw_invoice_applications
          WHERE external_invoice_id = $1`,
        [invoiceId],
      );
      const remaining =
        (num(invoice.amount) ?? 0) - (num(alreadyApplied.rows[0]?.applied) ?? 0);
      const amount = body.amount_applied ?? remaining;

      if (amount === 0) {
        throw new ApiError('conflict', 'That invoice is already fully applied.');
      }
      if (Math.abs(amount) > Math.abs(remaining) + 0.005) {
        throw new ApiError(
          'conflict',
          `Only ${remaining.toFixed(2)} of that invoice is unapplied.`,
          { remaining, requested: amount },
        );
      }

      await ctx.db.query(
        `INSERT INTO projects.draw_invoice_applications
           (tenant_id, draw_id, external_invoice_id, amount_applied, applied_by, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ctx.staff.tenantId, body.draw_id, invoiceId, amount, ctx.staff.staffId, body.note ?? null],
      );

      // Attach the invoice to the project if it was floating, so it stops
      // appearing as unmatched.
      if (!invoice.project_id) {
        await ctx.db.query(`UPDATE projects.external_invoices SET project_id = $2 WHERE id = $1`, [
          invoiceId,
          draw.rows[0].project_id,
        ]);
      }

      const state = await ctx.db.query<{
        draw_amount: string;
        applied_amount: string;
        unapplied_amount: string;
      }>(
        `SELECT draw_amount, applied_amount, unapplied_amount
           FROM projects.v_draw_application WHERE draw_id = $1`,
        [body.draw_id],
      );
      const unapplied = num(state.rows[0]?.unapplied_amount) ?? 0;

      // A draw becomes invoiced when it is fully covered, not when the first
      // invoice lands on it. The scalar is stamped alongside for anything still
      // reading it — see db/006_external_invoices.sql.
      if (unapplied <= 0.005) {
        await ctx.db.query(
          `UPDATE projects.draws
              SET status = 'invoiced',
                  external_invoice_number = COALESCE(external_invoice_number, $2),
                  external_invoice_recorded_at = COALESCE(external_invoice_recorded_at, now())
            WHERE id = $1 AND status <> 'paid'`,
          [body.draw_id, invoice.external_invoice_number],
        );
      }

      sendData(ctx.res, {
        draw_id: body.draw_id,
        amount_applied: amount,
        draw_amount: num(state.rows[0]?.draw_amount),
        applied_to_draw: num(state.rows[0]?.applied_amount),
        still_unapplied_on_draw: unapplied,
        draw_fully_invoiced: unapplied <= 0.005,
      });
    }),
  );

  router.get(
    '/exceptions/unapplied-invoices',
    staffRoute(deps, async (ctx) => {
      // The leakage report. Money that moved in the revenue system and never
      // landed against a job — including invoices nobody has matched to a
      // project at all, which are the worst kind because nothing else would
      // ever surface them.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT external_invoice_id, external_invoice_number, external_job_id, amount,
                invoiced_on, source, project_id, project_number, project_name,
                unapplied_amount, unmatched_to_project, days_since_invoiced
           FROM projects.v_unapplied_invoices
          ORDER BY unmatched_to_project DESC, days_since_invoiced DESC NULLS LAST`,
      );
      sendData(
        ctx.res,
        rows.map((r) => ({
          ...r,
          amount: num(r.amount),
          unapplied_amount: num(r.unapplied_amount),
        })),
      );
    }),
  );

  return router;
}

interface InvoiceRow extends Record<string, unknown> {
  id: string;
  project_id: string | null;
  amount: string;
  external_invoice_number: string;
}

async function loadInvoice(ctx: StaffContext, id: string): Promise<InvoiceRow> {
  const { rows } = await ctx.db.query<InvoiceRow>(
    `SELECT id, project_id, amount, external_invoice_number
       FROM projects.external_invoices WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Invoice not found');
  return rows[0];
}
