import { Router } from 'express';
import { z } from 'zod';
import { sendData } from '../http/envelope.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireCapability } from '../http/capabilities.js';
import { staffRoute, type StaffContext, type StaffRouterDeps } from '../http/staffSession.js';
import { loadVisibleProject, num, parseBody, parseUuidParam, requireOwnedRow } from './shared.js';
import { applyApprovedChangeOrder, applyChangeOrderToPurchaseOrders } from '../domain/changeOrders.js';
import { serviceTitanOwnsRevenue } from '../domain/localInvoices.js';

const lineSchema = z.object({
  cost_code_id: z.string().uuid(),
  cost_type: z.enum(['L', 'M', 'S', 'O']),
  // Signed. A change order that removes scope carries negative lines, and a
  // credit that cannot be recorded is a credit somebody argues about later.
  amount: z.number().finite(),
  description: z.string().nullish(),
  po_id: z.string().uuid().nullish(),
});

const createSchema = z.object({
  description: z.string().min(1),
  customer_amount: z.number().finite(),
  schedule_impact_days: z.number().int().default(0),
  external_estimate_ref: z.string().nullish(),
  lines: z.array(lineSchema).default([]),
});

const approveSchema = z.object({
  // "Record written customer approval" (§3.5). The date the customer actually
  // agreed, which is rarely the date somebody got round to typing it in.
  customer_approved_at: z.string().datetime().or(z.string().date()).nullish(),
});

export function changeOrderRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    '/projects/:id/change-orders',
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT co.id, co.co_number, co.description, co.customer_amount, co.cost_amount,
                co.schedule_impact_days, co.status::text AS status, co.sent_at,
                co.customer_approved_at, co.approved_by, co.external_estimate_ref,
                s.full_name AS approved_by_name
           FROM projects.change_orders co
           LEFT JOIN projects.staff s ON s.id = co.approved_by
          WHERE co.project_id = $1
          ORDER BY co.co_number`,
        [projectId],
      );

      const lines = await ctx.db.query<Record<string, unknown>>(
        `SELECT l.id, l.change_order_id, l.cost_code_id, cc.code, cc.description AS cost_code_description,
                l.cost_type::text AS cost_type, l.amount, l.description, l.po_id
           FROM projects.change_order_lines l
           JOIN projects.change_orders co ON co.id = l.change_order_id
           JOIN projects.cost_codes cc ON cc.id = l.cost_code_id
          WHERE co.project_id = $1
          ORDER BY cc.sort_order`,
        [projectId],
      );

      const settings = await threshold(ctx);

      sendData(ctx.res, {
        approval_threshold: settings,
        local_invoices_allowed: !(await serviceTitanOwnsRevenue(ctx.db)),
        change_orders: rows.map((co) => ({
          ...co,
          customer_amount: num(co.customer_amount),
          cost_amount: num(co.cost_amount),
          lines: lines.rows
            .filter((l) => l.change_order_id === co.id)
            .map((l) => ({ ...l, amount: num(l.amount) })),
        })),
      });
    }),
  );

  router.post(
    '/projects/:id/change-orders',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'send_change_order');
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
      const body = parseBody(createSchema, ctx.req.body);

      for (const line of body.lines) {
        await requireOwnedRow(ctx.db, 'cost_codes', line.cost_code_id, 'lines[].cost_code_id');
      }

      // co_number is per project and sequential. Taken from the table rather
      // than a counter, so a deleted draft leaves a gap rather than letting the
      // next one reuse a number that has already been in front of a customer.
      const next = await ctx.db.query<{ n: number }>(
        `SELECT COALESCE(MAX(co_number), 0) + 1 AS n
           FROM projects.change_orders WHERE project_id = $1`,
        [projectId],
      );

      const costAmount = body.lines.reduce((sum, l) => sum + l.amount, 0);

      const { rows } = await ctx.db.query<{ id: string }>(
        `INSERT INTO projects.change_orders
           (tenant_id, project_id, co_number, description, customer_amount, cost_amount,
            schedule_impact_days, external_estimate_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          ctx.staff.tenantId,
          projectId,
          next.rows[0]!.n,
          body.description,
          body.customer_amount,
          costAmount,
          body.schedule_impact_days,
          body.external_estimate_ref ?? null,
        ],
      );
      const changeOrderId = rows[0]!.id;

      for (const line of body.lines) {
        await assertPoOnProject(ctx, projectId, line.po_id);
        await ctx.db.query(
          `INSERT INTO projects.change_order_lines
             (tenant_id, change_order_id, cost_code_id, cost_type, amount, description, po_id)
           VALUES ($1,$2,$3,$4::projects.cost_type,$5,$6,$7)`,
          [
            ctx.staff.tenantId,
            changeOrderId,
            line.cost_code_id,
            line.cost_type,
            line.amount,
            line.description ?? null,
            line.po_id ?? null,
          ],
        );
      }

      sendData(
        ctx.res,
        {
          id: changeOrderId,
          co_number: next.rows[0]!.n,
          status: 'draft',
          customer_amount: body.customer_amount,
          cost_amount: costAmount,
          margin_on_this_change:
            body.customer_amount === 0
              ? null
              : round4((body.customer_amount - costAmount) / body.customer_amount),
          // Not a warning yet. A change order with no cost lines is normal
          // while it is being priced; it only matters at approval, where the
          // cost has nowhere to go.
          lines_created: body.lines.length,
        },
        undefined,
        201,
      );
    }),
  );

  router.patch(
    '/change-orders/:id',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'send_change_order');
      const coId = parseUuidParam(ctx.req.params.id, 'Change order');
      const co = await loadVisibleChangeOrder(ctx, coId);

      if (co.status !== 'draft') {
        throw new ApiError(
          'conflict',
          `This change order has been ${co.status}. Amending it after it went to the ` +
            `customer would change what they agreed to — raise another one.`,
          { status: co.status },
        );
      }

      const body = parseBody(createSchema.partial(), ctx.req.body);
      const entries = Object.entries({
        description: body.description,
        customer_amount: body.customer_amount,
        schedule_impact_days: body.schedule_impact_days,
        external_estimate_ref: body.external_estimate_ref,
      }).filter(([, v]) => v !== undefined);

      if (body.lines) {
        await ctx.db.query(`DELETE FROM projects.change_order_lines WHERE change_order_id = $1`, [
          coId,
        ]);
        for (const line of body.lines) {
          await requireOwnedRow(ctx.db, 'cost_codes', line.cost_code_id, 'lines[].cost_code_id');
          await assertPoOnProject(ctx, co.project_id, line.po_id);
          await ctx.db.query(
            `INSERT INTO projects.change_order_lines
               (tenant_id, change_order_id, cost_code_id, cost_type, amount, description, po_id)
             VALUES ($1,$2,$3,$4::projects.cost_type,$5,$6,$7)`,
            [
              ctx.staff.tenantId,
              coId,
              line.cost_code_id,
              line.cost_type,
              line.amount,
              line.description ?? null,
              line.po_id ?? null,
            ],
          );
        }
        entries.push(['cost_amount', body.lines.reduce((s, l) => s + l.amount, 0)]);
      }

      if (entries.length > 0) {
        const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
        await ctx.db.query(`UPDATE projects.change_orders SET ${sets} WHERE id = $1`, [
          coId,
          ...entries.map(([, v]) => v),
        ]);
      }

      sendData(ctx.res, await loadVisibleChangeOrder(ctx, coId));
    }),
  );

  router.post(
    '/change-orders/:id/send',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'send_change_order');
      const coId = parseUuidParam(ctx.req.params.id, 'Change order');
      const co = await loadVisibleChangeOrder(ctx, coId);

      if (co.status !== 'draft') {
        throw new ApiError('conflict', `This change order is already ${co.status}.`);
      }

      // "Send" records that it went out. Customer invoices are created in
      // ServiceTitan only. This call does not write an invoice to ServiceTitan
      // or QuickBooks. See docs/INTEGRATION_DECISIONS.md.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.change_orders SET status = 'sent', sent_at = now()
          WHERE id = $1
          RETURNING id, co_number, status::text AS status, sent_at, customer_amount`,
        [coId],
      );
      sendData(ctx.res, { ...rows[0], customer_amount: num(rows[0]!.customer_amount) });
    }),
  );

  router.post(
    '/change-orders/:id/approve',
    staffRoute(deps, async (ctx) => {
      const coId = parseUuidParam(ctx.req.params.id, 'Change order');
      const co = await loadVisibleChangeOrder(ctx, coId);
      const body = parseBody(approveSchema, ctx.req.body);

      if (co.status === 'approved') {
        const limit = await threshold(ctx);
        const amount = num(co.customer_amount) ?? 0;
        if (amount > limit) requireCapability(ctx.staff.role, 'approve_change_order_over_threshold');
        else requireCapability(ctx.staff.role, 'send_change_order');
        const poEffect = await applyChangeOrderToPurchaseOrders(
          ctx.db,
          ctx.staff.tenantId,
          co.project_id,
          coId,
          ctx.staff.staffId,
        );
        sendData(ctx.res, {
          id: co.id,
          co_number: co.co_number,
          status: co.status,
          customer_amount: num(co.customer_amount),
          cost_amount: num(co.cost_amount),
          budget_lines_created: 0,
          budget_lines_updated: 0,
          scheduled_end: null,
          po_lines_applied: poEffect.linesApplied,
          po_lines_already_applied: poEffect.linesAlreadyApplied,
          revenue_effect: 'revised_contract, computed from approved change orders',
        });
        return;
      }
      if (co.status === 'void' || co.status === 'rejected') {
        throw new ApiError('conflict', `That change order was ${co.status}.`);
      }
      if (co.status !== 'sent') {
        throw new ApiError(
          'conflict',
          'Send the change order to the customer before recording their approval.',
          { status: co.status },
        );
      }

      const limit = await threshold(ctx);
      const amount = num(co.customer_amount) ?? 0;
      if (amount > limit) {
        // Above the threshold this is owner or manager only. Checked here
        // rather than as a plain capability because the capability depends on
        // the amount, and a role table cannot express that.
        requireCapability(ctx.staff.role, 'approve_change_order_over_threshold');
      } else {
        requireCapability(ctx.staff.role, 'send_change_order');
      }

      const lineCount = await ctx.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.change_order_lines WHERE change_order_id = $1`,
        [coId],
      );

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.change_orders
            SET status = 'approved', approved_by = $2,
                customer_approved_at = COALESCE($3::timestamptz, now())
          WHERE id = $1 AND status = 'sent'
          RETURNING id, co_number, status::text AS status, customer_amount, cost_amount,
                    schedule_impact_days, customer_approved_at`,
        [coId, ctx.staff.staffId, body.customer_approved_at ?? null],
      );
      if (!rows[0]) {
        throw new ApiError('conflict', 'That change order is already approved.');
      }

      const effect = await applyApprovedChangeOrder(
        ctx.db,
        ctx.staff.tenantId,
        co.project_id,
        coId,
      );
      const poEffect = await applyChangeOrderToPurchaseOrders(
        ctx.db,
        ctx.staff.tenantId,
        co.project_id,
        coId,
        ctx.staff.staffId,
      );

      sendData(ctx.res, {
        ...rows[0],
        customer_amount: num(rows[0]!.customer_amount),
        cost_amount: num(rows[0]!.cost_amount),
        budget_lines_created: effect.budgetLinesCreated,
        budget_lines_updated: effect.budgetLinesUpdated,
        scheduled_end: effect.scheduleEndMovedTo,
        po_lines_applied: poEffect.linesApplied,
        po_lines_already_applied: poEffect.linesAlreadyApplied,
        // The revenue side needs no write: v_project_margin already adds every
        // approved change order to revised_contract. Said out loud because
        // adding it to contract_value as well is the obvious mistake.
        revenue_effect: 'revised_contract, computed from approved change orders',
        warning:
          Number(lineCount.rows[0]?.n ?? 0) === 0 && (num(co.cost_amount) ?? 0) !== 0
            ? {
                code: 'no_cost_lines',
                message:
                  'This change order carries a cost but no cost code lines, so none of ' +
                  'that cost reached the budget. It will show as margin that is not there.',
              }
            : null,
      });
    }),
  );

  router.post(
    '/change-orders/:id/reject',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'send_change_order');
      const coId = parseUuidParam(ctx.req.params.id, 'Change order');
      const co = await loadVisibleChangeOrder(ctx, coId);
      if (co.status === 'approved') {
        throw new ApiError(
          'conflict',
          'That change order is approved and its cost is in the budget. Raise a ' +
            'reversing change order rather than rejecting this one.',
        );
      }
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.change_orders SET status = 'rejected' WHERE id = $1
         RETURNING id, co_number, status::text AS status`,
        [coId],
      );
      sendData(ctx.res, rows[0]);
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------

interface ChangeOrderRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  co_number: number;
  status: string;
  customer_amount: string;
  cost_amount: string;
}

async function assertPoOnProject(
  ctx: StaffContext,
  projectId: string,
  poId: string | null | undefined,
): Promise<void> {
  if (!poId) return;
  const po = await ctx.db.query(
    `SELECT id FROM projects.purchase_orders WHERE id = $1 AND project_id = $2`,
    [poId, projectId],
  );
  if (!po.rows[0]) throw notFound('Purchase order not found');
}

async function loadVisibleChangeOrder(
  ctx: StaffContext,
  coId: string,
): Promise<ChangeOrderRow> {
  const { rows } = await ctx.db.query<ChangeOrderRow>(
    `SELECT id, project_id, co_number, description, customer_amount, cost_amount,
            schedule_impact_days, status::text AS status, sent_at, customer_approved_at
       FROM projects.change_orders WHERE id = $1`,
    [coId],
  );
  const co = rows[0];
  if (!co) throw notFound('Change order not found');
  await loadVisibleProject(ctx, co.project_id, 'id');
  return co;
}

async function threshold(ctx: StaffContext): Promise<number> {
  const { rows } = await ctx.db.query<{ v: string }>(
    `SELECT change_order_approval_threshold AS v FROM projects.tenant_settings
      WHERE tenant_id = $1`,
    [ctx.staff.tenantId],
  );
  return num(rows[0]?.v) ?? 0;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
