import { Router } from 'express';
import { z } from 'zod';
import { sendData } from '../http/envelope.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireCapability } from '../http/capabilities.js';
import { staffRoute, type StaffContext, type StaffRouterDeps } from '../http/staffSession.js';
import {
  loadVisibleProject,
  num,
  parseBody,
  parseUuidParam,
  requireOwnedRow,
} from './shared.js';

const createPoSchema = z
  .object({
    po_number: z.string().min(1).max(64),
    vendor_id: z.string().uuid().nullish(),
    supplier_name: z.string().min(1).nullish(),
    cost_code_id: z.string().uuid(),
    cost_type: z.enum(['L', 'M', 'S', 'O']),
    amount: z.number().min(0),
    scope_text: z.string().min(1),
    exclusions: z.string().nullish(),
    window_start: z.string().date().nullish(),
    window_end: z.string().date().nullish(),
    issue: z.boolean().default(false),
  })
  .refine((v) => Boolean(v.vendor_id) || Boolean(v.supplier_name), {
    message: 'Provide vendor_id, or supplier_name for a counter purchase',
    path: ['vendor_id'],
  });

const patchPoSchema = z.object({
  amount: z.number().min(0).optional(),
  scope_text: z.string().min(1).optional(),
  exclusions: z.string().nullish(),
  window_start: z.string().date().nullish(),
  window_end: z.string().date().nullish(),
  status: z.enum(['draft', 'issued', 'void']).optional(),
});

const createBillSchema = z.object({
  vendor_invoice_number: z.string().min(1),
  amount: z.number().min(0),
  retention_held: z.number().min(0).default(0),
  file_key: z.string().nullish(),
});

export function purchaseOrderRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    '/projects/:id/purchase-orders',
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT po.id, po.po_number, po.status::text AS status, po.amount,
                po.cost_code_id, cc.code AS cost_code, cc.description AS cost_code_description,
                po.cost_type::text AS cost_type, po.vendor_id,
                COALESCE(v.legal_name, po.supplier_name) AS vendor,
                po.scope_text, po.exclusions, po.window_start, po.window_end,
                po.issued_at,
                COALESCE(b.billed, 0) AS billed,
                po.amount - COALESCE(b.billed, 0) AS open_amount
           FROM projects.purchase_orders po
           JOIN projects.cost_codes cc ON cc.id = po.cost_code_id
           LEFT JOIN projects.vendors v ON v.id = po.vendor_id
           LEFT JOIN LATERAL (
             SELECT sum(vb.amount) AS billed FROM projects.vendor_bills vb
              WHERE vb.po_id = po.id AND vb.status IN ('approved','paid')
           ) b ON true
          WHERE po.project_id = $1
          ORDER BY po.po_number`,
        [projectId],
      );
      sendData(
        ctx.res,
        rows.map((r) => ({
          ...r,
          amount: num(r.amount),
          billed: num(r.billed),
          open_amount: num(r.open_amount),
        })),
      );
    }),
  );

  router.post(
    '/projects/:id/purchase-orders',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'issue_purchase_order');
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
      const body = parseBody(createPoSchema, ctx.req.body);

      await requireOwnedRow(ctx.db, 'cost_codes', body.cost_code_id, 'cost_code_id', 'AND active');
      await requireOwnedRow(ctx.db, 'vendors', body.vendor_id, 'vendor_id');

      // "Vendor must be eligible" (§3.5). Checked here rather than left to the
      // schedule trigger, because a PO is a commitment of money — issuing one
      // to a vendor who cannot legally be put on site is the expensive half of
      // the mistake, and it happens days before anyone tries to schedule them.
      if (body.vendor_id && body.issue) {
        await assertVendorSchedulable(ctx, body.vendor_id);
      }

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `INSERT INTO projects.purchase_orders
           (tenant_id, project_id, po_number, vendor_id, supplier_name, cost_code_id,
            cost_type, amount, scope_text, exclusions, window_start, window_end,
            status, issued_by, issued_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::projects.cost_type,$8,$9,$10,$11,$12,
                 $13::projects.po_status, $14, $15)
         RETURNING id, po_number, status::text AS status, amount, scope_text,
                   exclusions, window_start, window_end, issued_at`,
        [
          ctx.staff.tenantId,
          projectId,
          body.po_number,
          body.vendor_id ?? null,
          body.supplier_name ?? null,
          body.cost_code_id,
          body.cost_type,
          body.amount,
          body.scope_text,
          body.exclusions ?? null,
          body.window_start ?? null,
          body.window_end ?? null,
          body.issue ? 'issued' : 'draft',
          body.issue ? ctx.staff.staffId : null,
          body.issue ? new Date().toISOString() : null,
        ],
      );
      // v_cost_position matches a commitment to a budget line on cost code AND
      // cost type. A purchase order raised against a code that is budgeted
      // under a different type joins to nothing: it does not appear as
      // committed, it does not appear as a variance, and the money is simply
      // absent from the only number this module exists to produce.
      //
      // Not a rejection — committing before budgeting is legitimate, and a
      // refusal here would push the cost outside the system entirely. A named
      // warning, like the overbilling one.
      const budgeted = await ctx.db.query<{ cost_type: string }>(
        `SELECT cost_type::text AS cost_type FROM projects.budget_lines
          WHERE project_id = $1 AND cost_code_id = $2`,
        [projectId, body.cost_code_id],
      );
      const matches = budgeted.rows.some((r) => r.cost_type === body.cost_type);

      sendData(
        ctx.res,
        {
          ...rows[0],
          amount: num(rows[0]!.amount),
          warning: matches
            ? null
            : {
                code: 'no_matching_budget_line',
                message:
                  budgeted.rows.length > 0
                    ? `This cost code is budgeted as ${budgeted.rows
                        .map((r) => r.cost_type)
                        .join('/')}, not ${body.cost_type}. The commitment will not show ` +
                      `against the budget line until the two agree.`
                    : `Nothing is budgeted against this cost code, so the commitment ` +
                      `will not appear in the cost position.`,
                budgeted_as: budgeted.rows.map((r) => r.cost_type),
              },
        },
        undefined,
        201,
      );
    }),
  );

  router.patch(
    '/purchase-orders/:id',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'issue_purchase_order');
      const poId = parseUuidParam(ctx.req.params.id, 'Purchase order');
      const po = await loadVisiblePo(ctx, poId);
      const body = parseBody(patchPoSchema, ctx.req.body);

      if (po.status === 'void') {
        throw new ApiError('conflict', 'A void purchase order cannot be amended.');
      }

      if (body.status === 'void') {
        // "Void only when no approved bill exists" (§3.5). Voiding a PO that
        // has been billed detaches an approved cost from its commitment, and
        // the cost position view stops adding up.
        const billed = await ctx.db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM projects.vendor_bills
            WHERE po_id = $1 AND status IN ('approved','paid')`,
          [poId],
        );
        if (Number(billed.rows[0]?.n ?? 0) > 0) {
          throw new ApiError(
            'conflict',
            'This purchase order has approved bills against it and cannot be voided.',
            { approved_bills: Number(billed.rows[0]!.n) },
          );
        }
      }

      if (body.status === 'issued' && po.status === 'draft' && po.vendor_id) {
        await assertVendorSchedulable(ctx, po.vendor_id);
      }

      const assignable: Record<string, unknown> = {
        amount: body.amount,
        scope_text: body.scope_text,
        exclusions: body.exclusions,
        window_start: body.window_start,
        window_end: body.window_end,
        status: body.status,
      };
      const entries = Object.entries(assignable).filter(([, v]) => v !== undefined);
      if (entries.length === 0) {
        sendData(ctx.res, { ...po, amount: num(po.amount) });
        return;
      }

      const sets = entries.map(([k], i) =>
        k === 'status' ? `status = $${i + 2}::projects.po_status` : `${k} = $${i + 2}`,
      );
      if (body.status === 'issued' && po.status === 'draft') {
        sets.push(`issued_by = '${ctx.staff.staffId}'`, `issued_at = now()`);
      }

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.purchase_orders SET ${sets.join(', ')}
          WHERE id = $1
          RETURNING id, po_number, status::text AS status, amount, scope_text,
                    exclusions, window_start, window_end, issued_at, vendor_id`,
        [poId, ...entries.map(([, v]) => v)],
      );
      sendData(ctx.res, { ...rows[0], amount: num(rows[0]!.amount) });
    }),
  );

  // ---------------------------------------------------------------- bills ---
  router.get(
    '/purchase-orders/:id/bills',
    staffRoute(deps, async (ctx) => {
      const poId = parseUuidParam(ctx.req.params.id, 'Purchase order');
      await loadVisiblePo(ctx, poId);
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT id, vendor_invoice_number, amount, retention_held, status::text AS status,
                received_at, approved_by, approved_at, paid_at, file_key, exported_at
           FROM projects.vendor_bills WHERE po_id = $1 ORDER BY received_at`,
        [poId],
      );
      sendData(
        ctx.res,
        rows.map((r) => ({
          ...r,
          amount: num(r.amount),
          retention_held: num(r.retention_held),
        })),
      );
    }),
  );

  router.post(
    '/purchase-orders/:id/bills',
    staffRoute(deps, async (ctx) => {
      // Recording a bill is not approving one. Anyone who can issue a PO can
      // record what arrived; approving it for payment is the bookkeeper's.
      requireCapability(ctx.staff.role, 'issue_purchase_order');
      const poId = parseUuidParam(ctx.req.params.id, 'Purchase order');
      const po = await loadVisiblePo(ctx, poId);
      const body = parseBody(createBillSchema, ctx.req.body);

      if (po.status === 'void') {
        throw new ApiError('conflict', 'Cannot bill against a void purchase order.');
      }

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `INSERT INTO projects.vendor_bills
           (tenant_id, po_id, vendor_invoice_number, amount, retention_held, file_key)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, vendor_invoice_number, amount, retention_held,
                   status::text AS status, received_at`,
        [
          ctx.staff.tenantId,
          poId,
          body.vendor_invoice_number,
          body.amount,
          body.retention_held,
          body.file_key ?? null,
        ],
      );

      // "Warn when cumulative exceeds PO" (§3.5) — a warning, not a rejection.
      // Overbilling is usually a real overrun or an unpriced change, and both
      // need recording before they can be argued about. Refusing the bill just
      // moves the number into an email.
      const totals = await ctx.db.query<{ billed: string | null }>(
        `SELECT sum(amount)::text AS billed FROM projects.vendor_bills
          WHERE po_id = $1 AND status <> 'rejected'`,
        [poId],
      );
      const billed = num(totals.rows[0]?.billed) ?? 0;
      const poAmount = num(po.amount) ?? 0;

      sendData(
        ctx.res,
        {
          ...rows[0],
          amount: num(rows[0]!.amount),
          retention_held: num(rows[0]!.retention_held),
          po_amount: poAmount,
          billed_to_date: billed,
          warning:
            billed > poAmount
              ? {
                  code: 'exceeds_purchase_order',
                  message:
                    `Billed to date is ${billed.toFixed(2)} against a purchase order of ` +
                    `${poAmount.toFixed(2)}. Recorded anyway — amend the PO or raise a ` +
                    `change order.`,
                  over_by: Math.round((billed - poAmount) * 100) / 100,
                }
              : null,
        },
        undefined,
        201,
      );
    }),
  );

  router.post(
    '/bills/:id/approve',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'approve_vendor_bill');
      const billId = parseUuidParam(ctx.req.params.id, 'Vendor bill');

      const existing = await ctx.db.query<{ status: string }>(
        `SELECT status::text AS status FROM projects.vendor_bills WHERE id = $1`,
        [billId],
      );
      if (!existing.rows[0]) throw notFound('Vendor bill not found');
      if (existing.rows[0].status === 'paid') {
        throw new ApiError('conflict', 'That bill is already marked paid.');
      }

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.vendor_bills
            SET status = 'approved', approved_by = $2, approved_at = now()
          WHERE id = $1
          RETURNING id, vendor_invoice_number, amount, status::text AS status,
                    approved_by, approved_at`,
        [billId, ctx.staff.staffId],
      );
      sendData(ctx.res, { ...rows[0], amount: num(rows[0]!.amount) });
    }),
  );

  router.post(
    '/bills/:id/reject',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'approve_vendor_bill');
      const billId = parseUuidParam(ctx.req.params.id, 'Vendor bill');
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.vendor_bills
            SET status = 'rejected', approved_by = NULL, approved_at = NULL
          WHERE id = $1 AND status <> 'paid'
          RETURNING id, vendor_invoice_number, status::text AS status`,
        [billId],
      );
      if (!rows[0]) throw notFound('Vendor bill not found');
      sendData(ctx.res, rows[0]);
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------

interface PoRow extends Record<string, unknown> {
  id: string;
  status: string;
  amount: string;
  vendor_id: string | null;
  project_id: string;
}

/**
 * A PO is reachable only through a project the caller can see. RLS gives the
 * tenancy; the join to loadVisibleProject gives the business unit scoping,
 * which RLS deliberately does not do.
 */
async function loadVisiblePo(ctx: StaffContext, poId: string): Promise<PoRow> {
  const { rows } = await ctx.db.query<PoRow>(
    `SELECT id, project_id, po_number, status::text AS status, amount, vendor_id,
            scope_text, exclusions, window_start, window_end, issued_at
       FROM projects.purchase_orders WHERE id = $1`,
    [poId],
  );
  const po = rows[0];
  if (!po) throw notFound('Purchase order not found');
  await loadVisibleProject(ctx, po.project_id, 'id');
  return po;
}

async function assertVendorSchedulable(ctx: StaffContext, vendorId: string): Promise<void> {
  const { rows } = await ctx.db.query<{
    legal_name: string;
    schedulable: boolean;
    expired_count: string;
    missing_count: string;
  }>(
    `SELECT legal_name, schedulable, expired_count::text AS expired_count,
            missing_count::text AS missing_count
       FROM projects.v_vendor_eligibility WHERE vendor_id = $1`,
    [vendorId],
  );
  const row = rows[0];
  // No row means the tenant has no required document kinds configured at all.
  // Fail closed: an eligibility check that passes because nothing was required
  // is not a check.
  if (!row || row.schedulable !== true) {
    const documents = await ctx.db.query<{ kind: string; state: string }>(
      `SELECT kind::text AS kind, state FROM projects.v_vendor_compliance
        WHERE vendor_id = $1 AND state <> 'valid'`,
      [vendorId],
    );
    throw new ApiError(
      'compliance_blocked',
      row
        ? `${row.legal_name} cannot be issued a purchase order: ` +
          `${row.missing_count} required document(s) missing, ${row.expired_count} expired.`
        : 'This vendor has no compliance record and cannot be issued a purchase order.',
      {
        vendor_id: vendorId,
        documents: documents.rows.map((d) => d.kind),
        states: documents.rows,
      },
    );
  }
}
