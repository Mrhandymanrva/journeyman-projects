import { Router } from 'express';
import { sendData } from '../http/envelope.js';
import { requireCapability } from '../http/capabilities.js';
import { staffRoute, type StaffRouterDeps } from '../http/staffSession.js';
import { loadVisibleProject, num, parseUuidParam } from './shared.js';

/**
 * The project statement: what the customer has been committed to, what has been
 * billed, what is held back, and what is left.
 *
 * Mason, August 2026: change orders are invoiced separately from the draw
 * schedule but add to the total contract value and show on the project invoice
 * and statement. So this is the one place the two revenue streams are added up.
 *
 * It reports no margin and no cost. A statement is the customer-facing view of
 * a project's money, and the moment cost codes appear on it somebody will send
 * it to a customer with the job's margin printed at the bottom.
 */
export function statementRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    '/projects/:id/statement',
    staffRoute(deps, async (ctx) => {
      // Not gated on view_margin — an office user issues invoices and needs to
      // see what has been billed. It carries no cost, so there is no margin to
      // leak by showing it.
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      const project = await loadVisibleProject<{
        project_number: string;
        name: string;
        currency: string;
        contract_value: string;
      }>(ctx, projectId, 'project_number, name, currency, contract_value');

      // Invoiced is measured by what has been APPLIED to each draw, not by
      // whether a single invoice number happens to be stamped on it. A
      // milestone satisfied by nine technician visits is nine applications,
      // and the scalar only ever held the first.
      const draws = await ctx.db.query<{
        id: string;
        sequence_number: number;
        label: string;
        trigger_milestone: string;
        amount: string;
        status: string;
        is_retainage: boolean;
        external_invoice_number: string | null;
        external_invoice_verified_at: string | null;
        applied_amount: string;
        invoice_count: string;
      }>(
        `SELECT d.id, d.sequence_number, d.label, d.trigger_milestone, d.amount,
                d.status::text AS status, d.is_retainage,
                d.external_invoice_number, d.external_invoice_verified_at,
                v.applied_amount, v.invoice_count
           FROM projects.draws d
           JOIN projects.v_draw_application v ON v.draw_id = d.id
          WHERE d.project_id = $1 ORDER BY d.sequence_number`,
        [projectId],
      );

      const changeOrders = await ctx.db.query<{
        id: string;
        co_number: number;
        description: string;
        customer_amount: string;
        status: string;
        customer_approved_at: string | null;
        external_estimate_ref: string | null;
      }>(
        `SELECT id, co_number, description, customer_amount, status::text AS status,
                customer_approved_at, external_estimate_ref
           FROM projects.change_orders
          WHERE project_id = $1 AND status = 'approved'
          ORDER BY co_number`,
        [projectId],
      );

      const original = num(project.contract_value) ?? 0;
      const approvedChanges = changeOrders.rows.reduce(
        (sum, co) => sum + (num(co.customer_amount) ?? 0),
        0,
      );

      const drawRows = draws.rows.map((d) => ({
        id: d.id,
        sequence_number: d.sequence_number,
        label: d.label,
        trigger_milestone: d.trigger_milestone,
        amount: num(d.amount) ?? 0,
        status: d.status,
        is_retainage: d.is_retainage,
        applied_amount: num(d.applied_amount) ?? 0,
        invoice_count: Number(d.invoice_count ?? 0),
        external_invoice_number: d.external_invoice_number,
        // Invoiced means an invoice number is recorded against it. Whether that
        // number was verified against the revenue system is reported
        // separately, because "we think we billed it" and "we know we billed
        // it" are different states and a statement should not blur them.
        invoiced: (num(d.applied_amount) ?? 0) > 0,
        verified: Boolean(d.external_invoice_verified_at),
      }));

      const scheduled = drawRows.reduce((s, d) => s + d.amount, 0);
      // Sum of what has actually been applied, so a part-billed milestone
      // reports the part rather than all or nothing.
      const invoiced = drawRows.reduce((s, d) => s + d.applied_amount, 0);
      const retainageHeld = drawRows
        .filter((d) => d.is_retainage)
        .reduce((s, d) => s + (d.amount - d.applied_amount), 0);
      const earnedNotInvoiced = drawRows
        .filter((d) => d.status === 'earned' || d.status === 'approved')
        .reduce((s, d) => s + (d.amount - d.applied_amount), 0);

      sendData(ctx.res, {
        project_number: project.project_number,
        name: project.name,
        currency: project.currency,

        original_contract: round2(original),
        approved_change_orders: round2(approvedChanges),
        revised_contract: round2(original + approvedChanges),

        // The draw schedule is a percentage of the ORIGINAL contract and does
        // not reopen when a change order is approved. So on a project with
        // change orders these two deliberately disagree, and the gap is the
        // change orders — which is why it is reported rather than hidden.
        draw_schedule_total: round2(scheduled),
        change_orders_invoiced_separately: round2(approvedChanges),

        invoiced_to_date: round2(invoiced),
        retainage_held: round2(retainageHeld),
        earned_not_yet_invoiced: round2(earnedNotInvoiced),
        remaining_to_invoice: round2(original + approvedChanges - invoiced),

        draws: drawRows,
        change_orders: changeOrders.rows.map((co) => ({
          id: co.id,
          co_number: co.co_number,
          description: co.description,
          customer_amount: num(co.customer_amount),
          approved_at: co.customer_approved_at,
          external_estimate_ref: co.external_estimate_ref,
          // Invoiced separately from the draw schedule. Nothing tracks whether
          // that has happened yet — see docs/INTEGRATION_DECISIONS.md.
          invoiced: null,
        })),
      });
    }),
  );

  router.get(
    '/projects/:id/export/statement',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'export_cost_data');
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      const project = await loadVisibleProject<{ project_number: string }>(
        ctx,
        projectId,
        'project_number',
      );
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT sequence_number, label, trigger_milestone, amount,
                status::text AS status, is_retainage, external_invoice_number,
                external_invoice_recorded_at
           FROM projects.draws WHERE project_id = $1 ORDER BY sequence_number`,
        [projectId],
      );
      const { toCsv } = await import('../http/csv.js');
      ctx.res
        .status(200)
        .type('text/csv')
        .setHeader(
          'Content-Disposition',
          `attachment; filename="statement-${project.project_number}.csv"`,
        );
      ctx.res.send(
        toCsv(
          [
            'sequence_number',
            'label',
            'trigger_milestone',
            'amount',
            'status',
            'is_retainage',
            'external_invoice_number',
            'external_invoice_recorded_at',
          ],
          rows,
        ),
      );
    }),
  );

  return router;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
