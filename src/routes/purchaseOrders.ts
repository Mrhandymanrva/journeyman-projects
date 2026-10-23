import {prepareBillAccounting} from "./accounting.js";
import type {AccountingGateway} from "../adapters/quickbooks.js";
import { AccountingFailure } from "../adapters/quickbooks.js";
import { Router } from 'express';
import { z } from 'zod';
import { sendData } from '../http/envelope.js';
import { ApiError, notFound } from '../http/errors.js';
import { can, requireCapability } from '../http/capabilities.js';
import { staffExternalRoute, staffRoute, type StaffContext, type StaffRouterDeps } from '../http/staffSession.js';
import { grossFromPercent, roundMoney } from '../domain/poMath.js';
import { assertReadyToIssue, assertSubcontractCompliance } from '../domain/vendorCompliance.js';
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
    kind: z.enum(['subcontract', 'material']).optional(),
    agreement_document_id: z.string().uuid().nullish(),
    agreement_signed_at: z.string().datetime().nullish(),
    st_job_id: z.number().int().positive().nullish(),
    st_project_id: z.number().int().positive().nullish(),
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
  status: z.enum(['draft', 'issued', 'partially_billed', 'closed', 'void']).optional(),
  kind: z.enum(['subcontract', 'material']).optional(),
  agreement_document_id: z.string().uuid().nullish(),
  agreement_signed_at: z.string().datetime().nullish(),
  st_job_id: z.number().int().positive().nullish(),
  st_project_id: z.number().int().positive().nullish(),
  project_id: z.string().uuid().optional(),
});

const billLineSchema = z
  .object({
    po_line_id: z.string().uuid(),
    pct_complete_to_date: z.number().min(0).max(100).optional(),
    gross_amount: z.number().optional(),
  })
  .refine((line) => (line.pct_complete_to_date === undefined) !== (line.gross_amount === undefined), {
    message: 'Give pct_complete_to_date or gross_amount on each line, not both',
  });

const createBillSchema = z
  .object({
    vendor_invoice_number: z.string().min(1).max(21),
    invoice_date: z.string().date().optional(),
    due_date: z.string().date().optional(),
    description: z.string().max(4000).default(''),
    amount: z.number().min(0).optional(),
    retention_held: z.number().min(0).optional(),
    file_key: z.string().nullish(),
    lines: z.array(billLineSchema).min(1).max(25).optional(),
    override_zero_po: z.boolean().optional(),
  })
  .refine((bill) => Boolean(bill.lines) || bill.amount !== undefined, {
    message: 'Provide lines, or an amount for a single-line purchase order',
  });

const lineWriteSchema = z.object({
  cost_code_id: z.string().uuid(),
  cost_type: z.enum(['L', 'M', 'S', 'O']),
  description: z.string().default(''),
  original_amount: z.number().min(0),
  budget_line_id: z.string().uuid().nullish(),
});

export function purchaseOrderRoutes(deps: StaffRouterDeps, accounting?: AccountingGateway): Router {
  const router = Router();

  router.get(
    '/projects/:id/purchase-orders',
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT po.id, po.po_number, po.status::text AS status, po.amount,
                po.kind::text AS kind,
                po.cost_code_id, cc.code AS cost_code, cc.description AS cost_code_description,
                po.cost_type::text AS cost_type, po.vendor_id,
                COALESCE(v.legal_name, po.supplier_name) AS vendor,
                po.scope_text, po.exclusions, po.window_start, po.window_end,
                po.issued_at,
                COALESCE(b.billed, 0) AS billed,
                po.amount - COALESCE(b.billed, 0) AS open_amount
           FROM projects.purchase_orders po
           LEFT JOIN projects.cost_codes cc ON cc.id = po.cost_code_id
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

      const kind = body.kind ?? (body.vendor_id ? 'subcontract' : 'material');
      await assertStLinks(ctx, projectId, body.st_job_id, body.st_project_id);
      const agreementWarning = body.issue
        ? await assertReadyToIssue(ctx.db, {
            kind,
            vendorId: body.vendor_id ?? null,
            agreementDocumentId: body.agreement_document_id ?? null,
            agreementSignedAt: body.agreement_signed_at ?? null,
            lineCount: 1,
            createdAt: new Date(),
          })
        : null;
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `INSERT INTO projects.purchase_orders
           (tenant_id, project_id, po_number, vendor_id, supplier_name, cost_code_id,
            cost_type, amount, scope_text, exclusions, window_start, window_end,
            status, issued_by, issued_at, kind,
            agreement_document_id, agreement_signed_at, st_job_id, st_project_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::projects.cost_type,$8,$9,$10,$11,$12,
                 $13::projects.po_status, $14, $15, $16::projects.po_kind,
                 $17,$18,$19,$20)
         RETURNING id, po_number, status::text AS status, amount, scope_text,
                   exclusions, window_start, window_end, issued_at, kind::text AS kind`,
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
          kind,
          body.agreement_document_id ?? null,
          body.agreement_signed_at ?? null,
          body.st_job_id ?? null,
          body.st_project_id ?? null,
        ],
      );
      // The header amount is derived from lines. One line keeps the create
      // payload the console and the existing tests already send.
      await ctx.db.query(
        `INSERT INTO projects.po_lines
           (tenant_id, po_id, line_no, cost_code_id, cost_type, description, original_amount, budget_line_id)
         VALUES ($1,$2,1,$3,$4::projects.cost_type,'',$5,
           (SELECT id FROM projects.budget_lines
             WHERE project_id = $6 AND cost_code_id = $3 AND cost_type = $4::projects.cost_type
             LIMIT 1))`,
        [
          ctx.staff.tenantId,
          rows[0]!.id,
          body.cost_code_id,
          body.cost_type,
          body.amount,
          projectId,
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
          agreement_warning: agreementWarning,
        },
        undefined,
        201,
      );
    }),
  );

  router.patch(
    '/purchase-orders/:id',
    staffRoute(deps, async (ctx) => {
      const poId = parseUuidParam(ctx.req.params.id, 'Purchase order');
      const po = await loadVisiblePo(ctx, poId);
      const body = parseBody(patchPoSchema, ctx.req.body);
      const edited = (Object.keys(body) as Array<keyof typeof body>).filter((key) => body[key] !== undefined);
      const reclassifyOnly =
        edited.length > 0 && edited.every((key) => key === 'kind' || key === 'project_id');
      if (reclassifyOnly) {
        if (!can(ctx.staff.role, 'issue_purchase_order') && !can(ctx.staff.role, 'approve_vendor_bill')) {
          throw new ApiError(
            'forbidden',
            `Your role (${ctx.staff.role}) cannot mark a purchase order as a material purchase or move it to another project.`,
            { role: ctx.staff.role },
          );
        }
      } else {
        requireCapability(ctx.staff.role, 'issue_purchase_order');
      }

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

      if (body.status && body.status !== 'void' && po.status !== 'draft' && body.status !== po.status && body.status !== 'closed' && body.status !== 'partially_billed') {
        throw new ApiError('conflict', 'An issued purchase order cannot return to draft.');
      }
      if (po.status !== 'draft') {
        const locked = ['amount', 'scope_text', 'exclusions', 'window_start', 'window_end'] as const;
        if (locked.some((key) => body[key] !== undefined)) {
          throw new ApiError(
            'conflict',
            'An issued purchase order can change its kind, its project, its status, and its ServiceTitan or agreement links. Amounts change through an approved change order.',
          );
        }
      }
      let agreementWarning: { message: string } | null = null;
      if (body.status === 'issued' && po.status === 'draft') {
        const count = await ctx.db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM projects.po_lines WHERE po_id = $1`,
          [poId],
        );
        agreementWarning = await assertReadyToIssue(ctx.db, {
          kind: body.kind ?? po.kind,
          vendorId: po.vendor_id,
          agreementDocumentId: body.agreement_document_id ?? po.agreement_document_id,
          agreementSignedAt: body.agreement_signed_at ?? po.agreement_signed_at,
          lineCount: Number(count.rows[0]?.n ?? 0),
          createdAt: po.created_at,
        });
      }
      await assertStLinks(
        ctx,
        po.project_id,
        body.st_job_id === undefined ? null : body.st_job_id,
        body.st_project_id === undefined ? null : body.st_project_id,
      );

      if (body.amount !== undefined && po.status === 'draft') {
        const lines = await ctx.db.query<{ id: string; n: string }>(
          `SELECT id, count(*) OVER ()::text AS n FROM projects.po_lines WHERE po_id = $1`,
          [poId],
        );
        const lineCount = Number(lines.rows[0]?.n ?? 0);
        if (lineCount !== 1) {
          throw new ApiError(
            'conflict',
            lineCount === 0
              ? 'Add a line before setting the header amount.'
              : 'This purchase order has more than one line. Edit the lines instead of the header amount.',
          );
        }
        await ctx.db.query(
          `UPDATE projects.po_lines SET original_amount = $2 WHERE id = $1`,
          [lines.rows[0]!.id, body.amount],
        );
      }

      const fields: string[] = [];
      const values: unknown[] = [];
      const set = (sql: string, value: unknown) => {
        values.push(value);
        fields.push(sql.replace('$?', `$${values.length + 1}`));
      };
      if (body.amount !== undefined) set('amount = $?', body.amount);
      if (body.scope_text !== undefined) set('scope_text = $?', body.scope_text);
      if (body.exclusions !== undefined) set('exclusions = $?', body.exclusions);
      if (body.window_start !== undefined) set('window_start = $?', body.window_start);
      if (body.window_end !== undefined) set('window_end = $?', body.window_end);
      if (body.status !== undefined) set('status = $?::projects.po_status', body.status);
      if (body.kind !== undefined) set('kind = $?::projects.po_kind', body.kind);
      if (body.agreement_document_id !== undefined) set('agreement_document_id = $?', body.agreement_document_id);
      if (body.agreement_signed_at !== undefined) set('agreement_signed_at = $?', body.agreement_signed_at);
      if (body.st_job_id !== undefined) set('st_job_id = $?', body.st_job_id);
      if (body.st_project_id !== undefined) set('st_project_id = $?', body.st_project_id);
      if (body.project_id !== undefined && body.project_id !== po.project_id) {
        await loadVisibleProject(ctx, body.project_id, 'id');
        set('project_id = $?', body.project_id);
        await ctx.db.query(
          `UPDATE projects.po_lines SET budget_line_id = NULL WHERE po_id = $1`,
          [poId],
        );
      }
      if (body.status === 'issued' && po.status === 'draft') {
        set('issued_by = $?', ctx.staff.staffId);
        fields.push('issued_at = now()');
      }
      if (fields.length === 0) {
        sendData(ctx.res, presentPo(po));
        return;
      }

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.purchase_orders SET ${fields.join(', ')}
          WHERE id = $1
          RETURNING id, po_number, status::text AS status, amount, kind::text AS kind,
                    project_id, scope_text, exclusions, window_start, window_end, issued_at, vendor_id`,
        [poId, ...values],
      );
      sendData(ctx.res, { ...presentPo(rows[0]!), agreement_warning: agreementWarning });
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
                received_at, approved_by, approved_at, paid_at, file_key, exported_at, invoice_date, due_date,
                description, qbo_id, qbo_balance, source, qbo_txn_type
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
      if (body.invoice_date && body.due_date && body.due_date < body.invoice_date) {
        throw new ApiError('validation_failed', 'The due date cannot be before the invoice date.');
      }
      if (po.status === 'void') {
        throw new ApiError('conflict', 'Cannot bill against a void purchase order.');
      }

      const poLines = await ctx.db.query<PoLineRow>(
        `SELECT id, line_no, current_amount::text AS current_amount
           FROM projects.po_lines WHERE po_id = $1 ORDER BY line_no`,
        [poId],
      );
      const planned = await planBillLines(ctx, po, poLines.rows, body);
      const inserted = await ctx.db.query<{ id: string }>(
        `INSERT INTO projects.vendor_bills
           (tenant_id, po_id, vendor_invoice_number, amount, retention_held, file_key, invoice_date, due_date, description)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::date,CURRENT_DATE),COALESCE($8::date,$7::date,CURRENT_DATE),$9)
         RETURNING id`,
        [
          ctx.staff.tenantId,
          poId,
          body.vendor_invoice_number,
          planned.headerAmount,
          planned.headerRetainage,
          body.file_key ?? null,
          body.invoice_date ?? null,
          body.due_date ?? null,
          body.description,
        ],
      );
      const billId = inserted.rows[0]!.id;
      for (const line of planned.lines) {
        await ctx.db.query(
          `INSERT INTO projects.bill_lines
             (tenant_id, bill_id, po_line_id, pct_complete_to_date, gross_amount)
           VALUES ($1,$2,$3,$4,$5)`,
          [ctx.staff.tenantId, billId, line.poLineId, line.pct, line.gross],
        );
      }
      const bill = await ctx.db.query<Record<string, unknown>>(
        `SELECT id, vendor_invoice_number, amount, retention_held,
                status::text AS status, received_at
           FROM projects.vendor_bills WHERE id = $1`,
        [billId],
      );
      const totals = await ctx.db.query<{ billed: string | null }>(
        `SELECT sum(amount)::text AS billed FROM projects.vendor_bills
          WHERE po_id = $1 AND status <> 'rejected'`,
        [poId],
      );
      const billed = num(totals.rows[0]?.billed) ?? 0;
      const poAmount = num(po.amount) ?? 0;
      // A subcontract that runs past a line is refused above. A material
      // purchase still records the overrun: the payment already happened.
      const warn = po.kind === 'material' && billed > poAmount;
      sendData(
        ctx.res,
        {
          ...presentMoney(bill.rows[0]!, ['amount', 'retention_held']),
          po_amount: poAmount,
          billed_to_date: billed,
          lines: planned.lines.map((line) => ({
            po_line_id: line.poLineId,
            pct_complete_to_date: line.pct,
            gross_amount: line.gross,
          })),
          warning: warn
            ? {
                code: 'exceeds_purchase_order',
                message:
                  `Billed to date is ${billed.toFixed(2)} against a purchase order of ` +
                  `${poAmount.toFixed(2)}. Recorded anyway — amend the PO or raise a ` +
                  `change order.`,
                over_by: roundMoney(billed - poAmount),
              }
            : null,
        },
        undefined,
        201,
      );
    }),
  );

  router.get(
    '/purchase-orders/:id/lines',
    staffRoute(deps, async (ctx) => {
      const poId = parseUuidParam(ctx.req.params.id, 'Purchase order');
      await loadVisiblePo(ctx, poId);
      sendData(ctx.res, await listPoLines(ctx, poId));
    }),
  );

  router.post(
    '/purchase-orders/:id/lines',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'issue_purchase_order');
      const poId = parseUuidParam(ctx.req.params.id, 'Purchase order');
      const po = await loadVisiblePo(ctx, poId);
      const body = parseBody(lineWriteSchema, ctx.req.body);
      assertDraft(po);
      await requireOwnedRow(ctx.db, 'cost_codes', body.cost_code_id, 'cost_code_id', 'AND active');
      if (body.budget_line_id) await assertBudgetLine(ctx, po.project_id, body.budget_line_id);
      const next = await ctx.db.query<{ n: string }>(
        `SELECT COALESCE(MAX(line_no), 0)::text AS n FROM projects.po_lines WHERE po_id = $1`,
        [poId],
      );
      const { rows } = await ctx.db.query<{ id: string }>(
        `INSERT INTO projects.po_lines
           (tenant_id, po_id, line_no, cost_code_id, cost_type, description, original_amount, budget_line_id)
         VALUES ($1,$2,$3,$4,$5::projects.cost_type,$6,$7,$8)
         RETURNING id`,
        [
          ctx.staff.tenantId,
          poId,
          Number(next.rows[0]?.n ?? 0) + 1,
          body.cost_code_id,
          body.cost_type,
          body.description,
          body.original_amount,
          body.budget_line_id ?? null,
        ],
      );
      const lines = await listPoLines(ctx, poId);
      sendData(ctx.res, lines.find((line) => line.id === rows[0]!.id) ?? rows[0], undefined, 201);
    }),
  );

  router.patch(
    '/po-lines/:lineId',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'issue_purchase_order');
      const lineId = parseUuidParam(ctx.req.params.lineId, 'Purchase order line');
      const line = await loadVisibleLine(ctx, lineId);
      const body = parseBody(lineWriteSchema.partial(), ctx.req.body);
      assertDraft(line);
      if (body.cost_code_id) await requireOwnedRow(ctx.db, 'cost_codes', body.cost_code_id, 'cost_code_id', 'AND active');
      if (body.budget_line_id) await assertBudgetLine(ctx, line.project_id, body.budget_line_id);
      const fields: string[] = [];
      const values: unknown[] = [];
      const set = (sql: string, value: unknown) => {
        values.push(value);
        fields.push(sql.replace('$?', `$${values.length + 1}`));
      };
      if (body.cost_code_id !== undefined) set('cost_code_id = $?', body.cost_code_id);
      if (body.cost_type !== undefined) set('cost_type = $?::projects.cost_type', body.cost_type);
      if (body.description !== undefined) set('description = $?', body.description);
      if (body.original_amount !== undefined) set('original_amount = $?', body.original_amount);
      if (body.budget_line_id !== undefined) set('budget_line_id = $?', body.budget_line_id);
      if (fields.length) {
        await ctx.db.query(
          `UPDATE projects.po_lines SET ${fields.join(', ')} WHERE id = $1`,
          [lineId, ...values],
        );
      }
      const lines = await listPoLines(ctx, line.po_id);
      sendData(ctx.res, lines.find((row) => row.id === lineId) ?? { id: lineId });
    }),
  );

  router.delete(
    '/po-lines/:lineId',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'issue_purchase_order');
      const lineId = parseUuidParam(ctx.req.params.lineId, 'Purchase order line');
      const line = await loadVisibleLine(ctx, lineId);
      assertDraft(line);
      const billed = await ctx.db.query(
        `SELECT 1 FROM projects.bill_lines WHERE po_line_id = $1 LIMIT 1`,
        [lineId],
      );
      if (billed.rows.length) {
        throw new ApiError('conflict', 'This line has bills against it and cannot be deleted.');
      }
      await ctx.db.query(`DELETE FROM projects.po_lines WHERE id = $1`, [lineId]);
      sendData(ctx.res, { id: lineId, deleted: true });
    }),
  );

  router.get(
    '/purchase-orders/:id/qbo-candidates',
    staffExternalRoute(
      deps,
      async (ctx) => prepareQboRead(ctx, accounting, parseUuidParam(ctx.req.params.id, 'Purchase order')),
      async (prepared) => readBridge(accounting!, prepared),
      async (ctx, prepared, result) => {
        if (!result.ok) throw bridgeRejection(prepared.action, result.message);
        sendData(ctx.res, { transactions: normalizePayables(result.result) });
      },
    ),
  );

  router.post(
    '/bills/:id/link-qbo',
    staffExternalRoute(
      deps,
      async (ctx) => {
        requireCapability(ctx.staff.role, 'approve_vendor_bill');
        const billId = parseUuidParam(ctx.req.params.id, 'Vendor bill');
        const body = parseBody(
          z.object({
            qbo_txn_type: z.enum(['Bill', 'Purchase']),
            qbo_id: z.string().min(1).max(40),
          }),
          ctx.req.body,
        );
        const bill = await ctx.db.query<{
          id: string;
          po_id: string;
          project_id: string;
          amount: string;
          status: string;
          qbo_id: string | null;
          source: string;
        }>(
          `SELECT b.id, b.po_id, po.project_id, b.amount::text AS amount, b.status::text AS status,
                  b.qbo_id, b.source
             FROM projects.vendor_bills b
             JOIN projects.purchase_orders po ON po.id = b.po_id
            WHERE b.id = $1`,
          [billId],
        );
        const row = bill.rows[0];
        if (!row) throw notFound('Vendor bill not found');
        await loadVisibleProject(ctx, row.project_id, 'id');
        if (row.status === 'rejected') {
          throw new ApiError('conflict', 'A rejected bill cannot be linked to QuickBooks.');
        }
        if (row.qbo_id && row.qbo_id !== body.qbo_id) {
          throw new ApiError('conflict', 'This bill is already linked to a different QuickBooks transaction.');
        }
        if (!accounting || accounting.tenantId !== ctx.staff.tenantId) {
          throw new ApiError('conflict', 'QuickBooks connector is not configured.');
        }
        const config = await ctx.db.query<{ realm: string }>(
          `SELECT realm FROM projects.accounting_config`,
        );
        return {
          billId,
          gross: num(row.amount) ?? 0,
          already: row.qbo_id === body.qbo_id && row.source === 'qbo_link',
          qboId: body.qbo_id,
          txnType: body.qbo_txn_type,
          action: body.qbo_txn_type === 'Purchase' ? 'purchase' : 'bill',
          realm: config.rows[0]?.realm ?? null,
          vendorQboId: null as string | null,
        };
      },
      async (prepared) => (prepared.already ? { ok: true as const, result: null, skipped: true } : readBridge(accounting!, prepared)),
      async (ctx, prepared, result) => {
        if (prepared.already || result.skipped) {
          const current = await ctx.db.query<Record<string, unknown>>(
            `SELECT id, status::text AS status, qbo_id, qbo_txn_type, source, amount
               FROM projects.vendor_bills WHERE id = $1`,
            [prepared.billId],
          );
          sendData(ctx.res, presentMoney(current.rows[0] ?? { id: prepared.billId }, ['amount']));
          return;
        }
        if (!result.ok) throw bridgeRejection(prepared.action, result.message);
        const txn = result.result?.Purchase ?? result.result?.Bill;
        if (!txn || String(txn.Id) !== prepared.qboId) {
          throw new ApiError(
            'conflict',
            'QuickBooks did not return that transaction. Check the id and try again.',
          );
        }
        const total = Number(txn.TotalAmt);
        if (!Number.isFinite(total) || Math.abs(total - prepared.gross) > 0.005) {
          throw new ApiError(
            'conflict',
            `That QuickBooks ${prepared.txnType} is ${Number.isFinite(total) ? total.toFixed(2) : 'an unknown amount'}, and this bill is ${prepared.gross.toFixed(2)}.`,
          );
        }
        const balance = Number(txn.Balance ?? 0);
        const paid = prepared.txnType === 'Purchase' || balance === 0;
        const { rows } = await ctx.db.query<Record<string, unknown>>(
          `UPDATE projects.vendor_bills
              SET source = 'qbo_link', qbo_id = $2, qbo_txn_type = $3, qbo_balance = $4,
                  qbo_checked_at = now(), qbo_message = NULL,
                  status = CASE WHEN $5 THEN 'paid'::projects.bill_status ELSE 'approved'::projects.bill_status END,
                  paid_at = CASE WHEN $5 THEN COALESCE(paid_at, now()) ELSE paid_at END
            WHERE id = $1
            RETURNING id, status::text AS status, qbo_id, qbo_txn_type, source, amount, qbo_balance`,
          [prepared.billId, prepared.qboId, prepared.txnType, Number.isFinite(balance) ? balance : null, paid],
        );
        sendData(ctx.res, presentMoney(rows[0]!, ['amount', 'qbo_balance']));
      },
    ),
  );

  router.post(
    '/bills/:id/approve',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'approve_vendor_bill');
      const billId = parseUuidParam(ctx.req.params.id, 'Vendor bill');

      await prepareBillAccounting(ctx,billId,accounting);
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
      const existing=await ctx.db.query<{po_id:string}>(`SELECT po_id FROM projects.vendor_bills WHERE id=$1 FOR UPDATE`,[billId]);
      if(!existing.rows[0])throw notFound('Vendor bill not found');
      await loadVisiblePo(ctx,existing.rows[0].po_id);
      if((await ctx.db.query(`SELECT id FROM projects.accounting_queue WHERE kind='bill' AND record_id=$1`,[billId])).rows.length)throw new ApiError('conflict','This bill has been approved for QuickBooks. Resolve a cancellation in QuickBooks before changing the PM record.');
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
  po_number: string;
  kind: string;
  agreement_document_id: string | null;
  agreement_signed_at: string | null;
  cost_code_id: string | null;
  cost_type: string | null;
  created_at: string | Date;
}

interface PoLineRow {
  id: string;
  line_no: number;
  current_amount: string;
}

interface PlannedLine {
  poLineId: string;
  pct: number | null;
  gross: number;
}

/**
 * A PO is reachable only through a project the caller can see. RLS gives the
 * tenancy; the join to loadVisibleProject gives the business unit scoping,
 * which RLS deliberately does not do.
 */
async function loadVisiblePo(ctx: StaffContext, poId: string): Promise<PoRow> {
  const { rows } = await ctx.db.query<PoRow>(
    `SELECT id, project_id, po_number, status::text AS status, amount::text AS amount,
            vendor_id, kind::text AS kind,
            agreement_document_id, agreement_signed_at::text AS agreement_signed_at,
            cost_code_id, cost_type::text AS cost_type, created_at,
            scope_text, exclusions, window_start, window_end, issued_at
       FROM projects.purchase_orders WHERE id = $1`,
    [poId],
  );
  const po = rows[0];
  if (!po) throw notFound('Purchase order not found');
  await loadVisibleProject(ctx, po.project_id, 'id');
  return po;
}

async function loadVisibleLine(ctx: StaffContext, lineId: string): Promise<PoRow & { po_id: string }> {
  const { rows } = await ctx.db.query<{ po_id: string }>(
    `SELECT po_id FROM projects.po_lines WHERE id = $1`,
    [lineId],
  );
  const line = rows[0];
  if (!line) throw notFound('Purchase order line not found');
  const po = await loadVisiblePo(ctx, line.po_id);
  return { ...po, po_id: line.po_id };
}

async function assertBudgetLine(ctx: StaffContext, projectId: string, budgetLineId: string): Promise<void> {
  const row = await ctx.db.query(
    `SELECT 1 FROM projects.budget_lines WHERE id = $1 AND project_id = $2`,
    [budgetLineId, projectId],
  );
  if (!row.rows[0]) throw notFound('Budget line not found');
}

function assertDraft(po: { status: string }): void {
  if (po.status !== 'draft') {
    throw new ApiError(
      'conflict',
      'Lines can be edited while the purchase order is a draft. After issue, amounts change through an approved change order.',
    );
  }
}

async function assertStLinks(
  ctx: StaffContext,
  projectId: string,
  stJobId: number | null | undefined,
  stProjectId: number | null | undefined,
): Promise<void> {
  if (stJobId != null) {
    const job = await ctx.db.query(
      `SELECT 1 FROM projects.project_job_links
        WHERE project_id = $1 AND external_job_id = $2`,
      [projectId, String(stJobId)],
    );
    if (!job.rows[0]) {
      throw new ApiError('conflict', 'That ServiceTitan job is not linked to this project.');
    }
  }
  if (stProjectId != null) {
    const project = await ctx.db.query(
      `SELECT 1 FROM projects.st_project_connections
        WHERE project_id = $1 AND external_project_id = $2`,
      [projectId, String(stProjectId)],
    );
    if (!project.rows[0]) {
      throw new ApiError('conflict', 'That ServiceTitan project is not connected to this project.');
    }
  }
}

function presentPo(po: Record<string, unknown>) {
  return presentMoney(po, ['amount']);
}

function presentMoney(row: Record<string, unknown>, keys: string[]) {
  const copy: Record<string, unknown> = { ...row };
  for (const key of keys) if (key in copy) copy[key] = num(copy[key]);
  return copy;
}

async function listPoLines(ctx: StaffContext, poId: string) {
  const { rows } = await ctx.db.query<Record<string, unknown>>(
    `SELECT l.id, l.line_no, l.cost_code_id, cc.code AS cost_code,
            cc.description AS cost_code_description, l.cost_type::text AS cost_type,
            l.description, l.original_amount, l.change_amount, l.current_amount,
            COALESCE(b.gross, 0) AS billed_gross
       FROM projects.po_lines l
       LEFT JOIN projects.cost_codes cc ON cc.id = l.cost_code_id
       LEFT JOIN LATERAL (
         SELECT SUM(bl.gross_amount) AS gross
           FROM projects.bill_lines bl
           JOIN projects.vendor_bills vb ON vb.id = bl.bill_id
          WHERE bl.po_line_id = l.id AND vb.status <> 'rejected'
       ) b ON true
      WHERE l.po_id = $1
      ORDER BY l.line_no`,
    [poId],
  );
  return rows.map((row) =>
    presentMoney(row, ['original_amount', 'change_amount', 'current_amount', 'billed_gross']),
  );
}

async function planBillLines(
  ctx: StaffContext,
  po: PoRow,
  poLines: PoLineRow[],
  body: {
    amount?: number;
    retention_held?: number;
    lines?: Array<{ po_line_id: string; pct_complete_to_date?: number; gross_amount?: number }>;
    override_zero_po?: boolean;
  },
): Promise<{ lines: PlannedLine[]; headerAmount: number; headerRetainage: number }> {
  const byId = new Map(poLines.map((line) => [line.id, line]));
  let requested: Array<{ poLineId: string; pct: number | null; gross: number | null }> = [];

  if (body.lines) {
    const seen = new Set<string>();
    for (const line of body.lines) {
      if (seen.has(line.po_line_id)) {
        throw new ApiError('validation_failed', 'Each purchase order line can appear once on a bill.');
      }
      seen.add(line.po_line_id);
      const match = byId.get(line.po_line_id);
      if (!match) throw new ApiError('conflict', 'That line is not on this purchase order.');
      requested.push({
        poLineId: line.po_line_id,
        pct: line.pct_complete_to_date ?? null,
        gross: line.gross_amount ?? null,
      });
    }
  } else if (poLines.length === 0) {
    const amount = body.amount ?? 0;
    const held = body.retention_held ?? 0;
    if (held > amount) {
      throw new ApiError('validation_failed', 'Retention cannot exceed the bill.');
    }
    if (po.kind === 'subcontract' && (num(po.amount) ?? 0) === 0 && !body.override_zero_po) {
      throw new ApiError(
        'conflict',
        'A subcontract with no committed amount cannot be billed. Pass override_zero_po to record it anyway.',
        { code: 'zero_purchase_order' },
      );
    }
    return { lines: [], headerAmount: amount, headerRetainage: held };
  } else if (poLines.length === 1) {
    requested = [{ poLineId: poLines[0]!.id, pct: null, gross: body.amount ?? 0 }];
  } else {
    throw new ApiError(
      'validation_failed',
      'This purchase order has more than one line. Bill each line instead of a single amount.',
    );
  }

  if (po.kind === 'subcontract' && (num(po.amount) ?? 0) === 0 && !body.override_zero_po) {
    throw new ApiError(
      'conflict',
      'A subcontract with no committed amount cannot be billed. Pass override_zero_po to record it anyway.',
      { code: 'zero_purchase_order' },
    );
  }

  const mayAdjust = can(ctx.staff.role, 'approve_vendor_bill');
  const lines: PlannedLine[] = [];
  for (const request of requested) {
    const poLine = byId.get(request.poLineId)!;
    const prior = await ctx.db.query<{ prior_gross: string; prior_pct: string | null }>(
      `SELECT COALESCE(SUM(bl.gross_amount), 0)::text AS prior_gross,
              MAX(bl.pct_complete_to_date)::text AS prior_pct
         FROM projects.bill_lines bl
         JOIN projects.vendor_bills vb ON vb.id = bl.bill_id
        WHERE bl.po_line_id = $1 AND vb.status <> 'rejected'`,
      [request.poLineId],
    );
    const priorGross = num(prior.rows[0]?.prior_gross) ?? 0;
    const priorPct = prior.rows[0]?.prior_pct == null ? null : num(prior.rows[0]?.prior_pct);
    const current = num(poLine.current_amount) ?? 0;
    const gross = request.pct == null ? roundMoney(request.gross ?? 0) : grossFromPercent(current, request.pct, priorGross);
    if (request.pct != null && priorPct != null && request.pct < priorPct && !mayAdjust) {
      throw new ApiError(
        'conflict',
        'Percent complete cannot go down. A manager records that as a credit bill.',
      );
    }
    if (gross < 0 && !mayAdjust) {
      throw new ApiError(
        'conflict',
        'A credit against a purchase order line has to be recorded by a manager.',
      );
    }
    const next = roundMoney(priorGross + gross);
    if (po.kind === 'subcontract' && !body.override_zero_po && next > current + 0.001) {
      throw new ApiError(
        'conflict',
        `Line ${poLine.line_no} would be billed ${next.toFixed(2)} against ${current.toFixed(2)}.`,
        { code: 'exceeds_po_line', po_line_id: poLine.id, over_by: roundMoney(next - current) },
      );
    }
    lines.push({
      poLineId: request.poLineId,
      pct: request.pct,
      gross,
    });
  }
  return {
    lines,
    headerAmount: 0,
    headerRetainage: 0,
  };
}

interface QboRead {
  action: string;
  qboId?: string;
  realm: string | null;
  vendorQboId: string | null;
}

async function prepareQboRead(
  ctx: StaffContext,
  accounting: AccountingGateway | undefined,
  poId: string,
): Promise<QboRead & { skipped?: boolean }> {
  requireCapability(ctx.staff.role, 'approve_vendor_bill');
  const po = await loadVisiblePo(ctx, poId);
  if (!accounting || accounting.tenantId !== ctx.staff.tenantId) {
    throw new ApiError('conflict', 'QuickBooks connector is not configured.');
  }
  let vendorQboId: string | null = null;
  if (po.vendor_id) {
    const vendor = await ctx.db.query<{ qbo_id: string | null }>(
      `SELECT qbo_id FROM projects.vendors WHERE id = $1`,
      [po.vendor_id],
    );
    vendorQboId = vendor.rows[0]?.qbo_id ?? null;
  }
  const config = await ctx.db.query<{ realm: string }>(`SELECT realm FROM projects.accounting_config`);
  return { action: 'payables', realm: config.rows[0]?.realm ?? null, vendorQboId };
}

async function readBridge(
  accounting: AccountingGateway,
  prepared: QboRead,
): Promise<{ ok: true; result: any; skipped?: boolean } | { ok: false; result?: any; message: string; skipped?: boolean }> {
  try {
    const response = await accounting.call({
      action: prepared.action,
      ...(prepared.qboId ? { id: prepared.qboId } : {}),
      ...(prepared.vendorQboId ? { vendorId: prepared.vendorQboId } : {}),
      ...(prepared.realm ? { expectedRealm: prepared.realm } : {}),
    });
    return { ok: true, result: response.result };
  } catch (error) {
    const message = error instanceof AccountingFailure
      ? error.message
      : 'QuickBooks did not return that transaction.';
    return { ok: false, message };
  }
}

function bridgeRejection(action: string, message: string): ApiError {
  return new ApiError(
    'conflict',
    `The QuickBooks bridge rejected the read-only '${action}' lookup, so nothing was linked or changed. ${message}`,
  );
}

function normalizePayables(result: any) {
  const take = (type: 'Bill' | 'Purchase') => {
    const raw = result?.[type] ?? result?.QueryResponse?.[type] ?? [];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.map((txn: any) => ({
      id: txn.Id == null ? null : String(txn.Id),
      txn_type: type,
      doc_number: txn.DocNumber ?? null,
      total: Number(txn.TotalAmt ?? 0),
      balance: txn.Balance == null ? null : Number(txn.Balance),
      txn_date: txn.TxnDate ?? null,
    }));
  };
  return [...take('Bill'), ...take('Purchase')];
}
