import { Router } from 'express';
import { z } from 'zod';
import { sendData } from '../http/envelope.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireCapability } from '../http/capabilities.js';
import { staffRoute, type StaffContext, type StaffRouterDeps } from '../http/staffSession.js';
import { loadVisibleProject, num, parseBody, parseUuidParam } from './shared.js';

/**
 * The consolidated invoice the customer receives.
 *
 * Distinct from the technician invoices in external_invoices, which evidence
 * the work behind a draw and are never sent to anyone. Billing versus detail —
 * see db/007_project_invoices.sql.
 */

const issueSchema = z.object({
  issued_on: z.string().date().optional(),
  due_on: z.string().date().nullish(),
  description: z.string().min(1).optional(),
  note: z.string().nullish(),
});

const externalRefSchema = z.object({
  external_ref: z.string().trim().min(1),
});

export function projectInvoiceRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    '/projects/:id/invoices',
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT i.id, i.invoice_number, i.amount, i.description, i.issued_on, i.due_on,
                i.status::text AS status, i.sent_at, i.paid_on,
                i.external_ref, i.external_recorded_at,
                i.draw_id, i.change_order_id,
                d.label AS draw_label, co.co_number
           FROM projects.project_invoices i
           LEFT JOIN projects.draws d ON d.id = i.draw_id
           LEFT JOIN projects.change_orders co ON co.id = i.change_order_id
          WHERE i.project_id = $1
          ORDER BY i.sequence_number`,
        [projectId],
      );
      sendData(
        ctx.res,
        rows.map((r) => ({ ...r, amount: num(r.amount) })),
      );
    }),
  );

  router.post(
    '/draws/:id/invoice',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'record_external_invoice');
      const drawId = parseUuidParam(ctx.req.params.id, 'Draw');
      const body = parseBody(issueSchema, ctx.req.body);

      const draw = await ctx.db.query<{
        id: string;
        project_id: string;
        label: string;
        trigger_milestone: string;
        amount: string;
        status: string;
      }>(
        `SELECT id, project_id, label, trigger_milestone, amount, status::text AS status
           FROM projects.draws WHERE id = $1`,
        [drawId],
      );
      const row = draw.rows[0];
      if (!row) throw notFound('Draw not found');
      await loadVisibleProject(ctx, row.project_id, 'id');

      // A draw is billed once the milestone is reached and somebody with the
      // authority has approved the amount. Invoicing an unapproved draw is how
      // a customer gets asked for money nobody signed off.
      if (row.status === 'scheduled' || row.status === 'earned') {
        throw new ApiError(
          'conflict',
          row.status === 'scheduled'
            ? 'Mark the milestone reached and approve the draw before invoicing it.'
            : 'Approve the draw before invoicing it.',
          { status: row.status },
        );
      }

      const invoice = await issue(ctx, {
        projectId: row.project_id,
        drawId,
        changeOrderId: null,
        amount: num(row.amount) ?? 0,
        description: body.description ?? `${row.label} — ${row.trigger_milestone}`,
        issuedOn: body.issued_on,
        dueOn: body.due_on ?? null,
        note: body.note ?? null,
      });

      // Now it is invoiced: the customer has been asked for the money. Not
      // when technician detail was matched to it.
      await ctx.db.query(
        `UPDATE projects.draws SET status = 'invoiced' WHERE id = $1 AND status <> 'paid'`,
        [drawId],
      );

      sendData(ctx.res, invoice, undefined, 201);
    }),
  );

  router.post(
    '/change-orders/:id/invoice',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'record_external_invoice');
      const coId = parseUuidParam(ctx.req.params.id, 'Change order');
      const body = parseBody(issueSchema, ctx.req.body);

      const co = await ctx.db.query<{
        id: string;
        project_id: string;
        co_number: number;
        description: string;
        customer_amount: string;
        status: string;
      }>(
        `SELECT id, project_id, co_number, description, customer_amount,
                status::text AS status
           FROM projects.change_orders WHERE id = $1`,
        [coId],
      );
      const row = co.rows[0];
      if (!row) throw notFound('Change order not found');
      await loadVisibleProject(ctx, row.project_id, 'id');

      if (row.status !== 'approved') {
        throw new ApiError(
          'conflict',
          'Only an approved change order can be invoiced — the customer has to have agreed to it first.',
          { status: row.status },
        );
      }

      const invoice = await issue(ctx, {
        projectId: row.project_id,
        drawId: null,
        changeOrderId: coId,
        amount: num(row.customer_amount) ?? 0,
        description: body.description ?? `Change order ${row.co_number} — ${row.description}`,
        issuedOn: body.issued_on,
        dueOn: body.due_on ?? null,
        note: body.note ?? null,
      });
      sendData(ctx.res, invoice, undefined, 201);
    }),
  );

  /**
   * The document. Header, the one line the customer is being billed for, and
   * the technician detail behind it — which is available but is not what they
   * are paying against.
   */
  router.get(
    '/invoices/:id',
    staffRoute(deps, async (ctx) => {
      const invoiceId = parseUuidParam(ctx.req.params.id, 'Invoice');
      const invoice = await loadInvoice(ctx, invoiceId);

      const project = await loadVisibleProject<Record<string, unknown>>(
        ctx,
        invoice.project_id,
        'project_number, name, address_line1, city, region, postal_code, currency',
      );

      const detail = invoice.draw_id
        ? await ctx.db.query<Record<string, unknown>>(
            `SELECT ei.external_invoice_number, ei.invoiced_on, ei.description,
                    a.amount_applied
               FROM projects.draw_invoice_applications a
               JOIN projects.external_invoices ei ON ei.id = a.external_invoice_id
              WHERE a.draw_id = $1
              ORDER BY ei.invoiced_on NULLS LAST, ei.external_invoice_number`,
            [invoice.draw_id],
          )
        : { rows: [] as Record<string, unknown>[] };

      sendData(ctx.res, {
        invoice_number: invoice.invoice_number,
        status: invoice.status,
        issued_on: invoice.issued_on,
        due_on: invoice.due_on,
        amount: num(invoice.amount),
        description: invoice.description,
        external_ref: invoice.external_ref,
        project: {
          ...project,
          contract_value: undefined,
        },
        // Present so the office can answer "what is this for", and never a
        // price list. No cost, no margin, no cost codes — the same rule the
        // statement follows.
        supporting_detail: detail.rows.map((d) => ({
          reference: d.external_invoice_number,
          date: d.invoiced_on,
          description: d.description,
          amount: num(d.amount_applied),
        })),
        supporting_total: detail.rows.reduce((s, d) => s + (num(d.amount_applied) ?? 0), 0),
      });
    }),
  );

  router.post(
    '/invoices/:id/send',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'record_external_invoice');
      const invoiceId = parseUuidParam(ctx.req.params.id, 'Invoice');
      const invoice = await loadInvoice(ctx, invoiceId);
      if (invoice.status === 'void') {
        throw new ApiError('conflict', 'That invoice was voided.');
      }
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.project_invoices SET status = 'sent', sent_at = now()
          WHERE id = $1 AND status <> 'paid'
          RETURNING id, invoice_number, status::text AS status, sent_at`,
        [invoiceId],
      );
      sendData(ctx.res, rows[0] ?? invoice);
    }),
  );

  router.post(
    '/invoices/:id/external-ref',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'record_external_invoice');
      const invoiceId = parseUuidParam(ctx.req.params.id, 'Invoice');
      const invoice = await loadInvoice(ctx, invoiceId);
      const body = parseBody(externalRefSchema, ctx.req.body);

      if (invoice.external_ref) {
        throw new ApiError(
          'draw_already_invoiced',
          `That invoice is already recorded as ${invoice.external_ref}.`,
          { external_ref: invoice.external_ref },
        );
      }
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.project_invoices
            SET external_ref = $2, external_recorded_at = now()
          WHERE id = $1
          RETURNING id, invoice_number, external_ref, external_recorded_at`,
        [invoiceId, body.external_ref],
      );
      sendData(ctx.res, rows[0]);
    }),
  );

  router.post(
    '/invoices/:id/void',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'record_external_invoice');
      const invoiceId = parseUuidParam(ctx.req.params.id, 'Invoice');
      const invoice = await loadInvoice(ctx, invoiceId);
      if (invoice.status === 'paid') {
        throw new ApiError('conflict', 'A paid invoice cannot be voided.');
      }

      await ctx.db.query(
        `UPDATE projects.project_invoices SET status = 'void' WHERE id = $1`,
        [invoiceId],
      );
      // The draw goes back to approved so it can be reissued. Voiding the
      // paperwork does not un-earn the milestone.
      if (invoice.draw_id) {
        await ctx.db.query(
          `UPDATE projects.draws SET status = 'approved' WHERE id = $1 AND status = 'invoiced'`,
          [invoice.draw_id],
        );
      }
      sendData(ctx.res, { id: invoiceId, status: 'void' });
    }),
  );

  router.get(
    '/exceptions/unrecorded-invoices',
    staffRoute(deps, async (ctx) => {
      // Issued to the customer, absent from the books.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT project_invoice_id, invoice_number, project_id, project_number,
                project_name, amount, issued_on, days_since_issued
           FROM projects.v_unrecorded_invoices
          ORDER BY days_since_issued DESC`,
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

interface InvoiceRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  invoice_number: string;
  status: string;
  amount: string;
  draw_id: string | null;
  external_ref: string | null;
}

async function loadInvoice(ctx: StaffContext, id: string): Promise<InvoiceRow> {
  const { rows } = await ctx.db.query<InvoiceRow>(
    `SELECT id, project_id, invoice_number, sequence_number, draw_id, change_order_id,
            amount, description, issued_on, due_on, status::text AS status,
            sent_at, paid_on, external_ref, external_recorded_at
       FROM projects.project_invoices WHERE id = $1`,
    [id],
  );
  const invoice = rows[0];
  if (!invoice) throw notFound('Invoice not found');
  await loadVisibleProject(ctx, invoice.project_id, 'id');
  return invoice;
}

async function issue(
  ctx: StaffContext,
  input: {
    projectId: string;
    drawId: string | null;
    changeOrderId: string | null;
    amount: number;
    description: string;
    issuedOn?: string | undefined;
    dueOn: string | null;
    note: string | null;
  },
): Promise<Record<string, unknown>> {
  const owner=await ctx.db.query("SELECT id FROM projects.external_systems WHERE active AND adapter_key='servicetitan' AND is_revenue_system_of_record");
  if(owner.rows.length)throw new ApiError('conflict','Customer invoices are issued in ServiceTitan. Record the ST invoice reference on the project draw.');
  const project = await ctx.db.query<{ project_number: string }>(
    `SELECT project_number FROM projects.projects WHERE id = $1`,
    [input.projectId],
  );

  // Numbered per project. A tenant-wide sequence needs locking to stay
  // gapless, and a gap in a customer-facing invoice number is a question
  // somebody has to answer.
  const next = await ctx.db.query<{ n: number }>(
    `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS n
       FROM projects.project_invoices WHERE project_id = $1`,
    [input.projectId],
  );
  const sequence = next.rows[0]!.n;
  const invoiceNumber = `${project.rows[0]!.project_number}-${String(sequence).padStart(2, '0')}`;

  const { rows } = await ctx.db.query<Record<string, unknown>>(
    `INSERT INTO projects.project_invoices
       (tenant_id, project_id, invoice_number, sequence_number, draw_id, change_order_id,
        amount, description, issued_on, due_on, note, issued_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::date, CURRENT_DATE),$10,$11,$12)
     RETURNING id, invoice_number, amount, description, issued_on, due_on,
               status::text AS status`,
    [
      ctx.staff.tenantId,
      input.projectId,
      invoiceNumber,
      sequence,
      input.drawId,
      input.changeOrderId,
      input.amount,
      input.description,
      input.issuedOn ?? null,
      input.dueOn,
      input.note,
      ctx.staff.staffId,
    ],
  );
  return { ...rows[0], amount: num(rows[0]!.amount) };
}
