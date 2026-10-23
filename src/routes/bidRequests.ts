import { Router } from "express";
import { z } from "zod";
import {
  staffRoute,
  staffExternalRoute,
  type StaffRouterDeps,
  type StaffContext,
} from "../http/staffSession.js";
import { requireCapability, unitFilter } from "../http/capabilities.js";
import { ApiError, notFound } from "../http/errors.js";
import { sendData } from "../http/envelope.js";
import { parseBody, parseUuidParam, loadVisibleProject, requireOwnedRow, num } from "./shared.js";
import { assertVendorCompliant } from "../domain/vendorCompliance.js";
import { roundMoney } from "../domain/poMath.js";
import type { SqlClient } from "../db/database.js";
import {
  bidToken,
  tokenHash,
  mailEnabled,
  sendBid,
  type BidMailConfig,
} from "../adapters/bidMail.js";
import type { Database } from "../db/database.js";
const response = z
  .object({
    response_status: z.enum([
      "awaiting",
      "interested",
      "declined",
      "quoted",
      "awarded",
      "not_selected",
    ]),
    quote_amount: z.number().min(0).max(999999999999).nullable().optional(),
    response_notes: z.string().max(10000).nullable().optional(),
    available_from: z.string().date().nullable().optional(),
  })
  .strict();
async function request(ctx: StaffContext, id: string) {
  const r = await ctx.db.query<{
    id: string;
    project_id: string;
    subject: string;
    scope: string;
    due_on: string | null;
    window_start: string | null;
    window_end: string | null;
    closed_at: string | null;
  }>("SELECT b.*,p.currency FROM projects.bid_requests b JOIN projects.projects p ON p.id=b.project_id WHERE b.id=$1", [id]);
  if (!r.rows[0]) throw notFound("Bid request not found");
  await loadVisibleProject(ctx, r.rows[0].project_id, "id");
  return r.rows[0];
}
export function bidRequestRoutes(
  deps: StaffRouterDeps,
  config?: BidMailConfig,
) {
  const router = Router();
  const configured = (ctx: StaffContext) =>
    config?.tenantId === ctx.staff.tenantId ? config : undefined;
  router.get(
    "/bid-requests",
    staffRoute(deps, async (ctx) => {
      const unit = unitFilter(
        ctx.staff.businessUnitId,
        ctx.settings.enforceBusinessUnitScoping,
      );
      const r = await ctx.db.query(
        `SELECT b.*,p.name AS project_name,p.currency,(SELECT count(*) FROM projects.bid_recipients r WHERE r.request_id=b.id)::int AS recipient_count,(SELECT count(*) FROM projects.bid_recipients r WHERE r.request_id=b.id AND r.response_status<>'awaiting')::int AS response_count FROM projects.bid_requests b JOIN projects.projects p ON p.id=b.project_id WHERE ($1::uuid IS NULL OR p.business_unit_id=$1) ORDER BY b.created_at DESC`,
        [unit],
      );
      sendData(ctx.res, {
        requests: r.rows,
        emailConfigured: mailEnabled(configured(ctx)),
        linksConfigured: Boolean(configured(ctx)),
        sender: configured(ctx)?.from ?? null,
      });
    }),
  );
  router.post(
    "/bid-requests",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "send_change_order");
      const b = parseBody(
        z
          .object({
            project_id: z.string().uuid(),
            subject: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[^\r\n]+$/),
            scope: z.string().min(1).max(20000),
            due_on: z.string().date().nullish(),
            window_start: z.string().date().nullish(),
            window_end: z.string().date().nullish(),
            vendor_ids: z.array(z.string().uuid()).min(1).max(50),
          })
          .strict()
          .refine(
            (x) =>
              !x.window_start ||
              !x.window_end ||
              x.window_end >= x.window_start,
            "Work window is inverted",
          ),
        ctx.req.body,
      );
      await loadVisibleProject(ctx, b.project_id, "id");
      const ids = [...new Set(b.vendor_ids)];
      const vendors = await ctx.db.query<{ id: string; email: string }>(
        "SELECT id,email FROM projects.vendors WHERE id=ANY($1::uuid[])",
        [ids],
      );
      if (vendors.rows.length !== ids.length)
        throw notFound("Subcontractor not found");
      const r = await ctx.db.query<{ id: string }>(
        `INSERT INTO projects.bid_requests(tenant_id,project_id,subject,scope,due_on,window_start,window_end,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          ctx.staff.tenantId,
          b.project_id,
          b.subject,
          b.scope,
          b.due_on ?? null,
          b.window_start ?? null,
          b.window_end ?? null,
          ctx.staff.staffId,
        ],
      );
      for (const v of vendors.rows)
        await ctx.db.query(
          "INSERT INTO projects.bid_recipients(tenant_id,request_id,vendor_id,email) VALUES($1,$2,$3,$4)",
          [ctx.staff.tenantId, r.rows[0]!.id, v.id, v.email],
        );
      sendData(ctx.res, r.rows[0], undefined, 201);
    }),
  );
  router.get(
    "/bid-requests/:id",
    staffRoute(deps, async (ctx) => {
      const id = parseUuidParam(ctx.req.params.id, "Bid request"),
        b = await request(ctx, id);
      const r = await ctx.db.query(
        `SELECT r.id,r.vendor_id,r.email,r.delivery_status,r.response_status,r.quote_amount::text,r.response_notes,r.available_from,r.sent_at,r.responded_at,r.last_error,r.history,r.awarded_po_id,v.legal_name,v.trades FROM projects.bid_recipients r JOIN projects.vendors v ON v.id=r.vendor_id WHERE r.request_id=$1 ORDER BY v.legal_name`,
        [id],
      );
      sendData(ctx.res, {
        ...b,
        recipients: r.rows,
        emailConfigured: mailEnabled(configured(ctx)),
        linksConfigured: Boolean(configured(ctx)),
        sender: configured(ctx)?.from ?? null,
      });
    }),
  );
  router.patch(
    "/bid-requests/:id/recipients/:recipientId",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "send_change_order");
      const id = parseUuidParam(ctx.req.params.id, "Bid request"),
        recipient = parseUuidParam(ctx.req.params.recipientId, "Recipient");
      await request(ctx, id);
      const b = parseBody(response, ctx.req.body);
      if (b.response_status === "awarded") {
        throw new ApiError(
          "conflict",
          "Award the recipient with POST /bid-requests/:id/recipients/:recipientId/award. That creates the draft purchase order.",
        );
      }
      const r = await ctx.db.query(
        `UPDATE projects.bid_recipients SET response_status=$3,quote_amount=$4,response_notes=$5,available_from=$6,responded_at=now(),history=history||$7::jsonb WHERE id=$1 AND request_id=$2 RETURNING id`,
        [
          recipient,
          id,
          b.response_status,
          b.quote_amount ?? null,
          b.response_notes ?? null,
          b.available_from ?? null,
          JSON.stringify([
            { at: new Date().toISOString(), actor: ctx.staff.staffId, ...b },
          ]),
        ],
      );
      if (!r.rows.length) throw notFound("Recipient not found");
      sendData(ctx.res, r.rows[0]);
    }),
  );
  router.post(
    "/bid-requests/:id/close",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "send_change_order");
      const id = parseUuidParam(ctx.req.params.id, "Bid request");
      await request(ctx, id);
      await ctx.db.query(
        "UPDATE projects.bid_requests SET closed_at=now() WHERE id=$1",
        [id],
      );
      sendData(ctx.res, { closed: true });
    }),
  );
  router.get(
    "/bid-requests/:id/lines",
    staffRoute(deps, async (ctx) => {
      const id = parseUuidParam(ctx.req.params.id, "Bid request");
      const bid = await request(ctx, id);
      if (ctx.req.query.seed === "budget") {
        const seed = await ctx.db.query(
          `SELECT b.id AS budget_line_id, b.cost_code_id, b.cost_type::text AS cost_type,
                  cc.code AS cost_code, cc.description
             FROM projects.budget_lines b
             JOIN projects.cost_codes cc ON cc.id = b.cost_code_id
            WHERE b.project_id = $1
            ORDER BY cc.sort_order, b.cost_type`,
          [bid.project_id],
        );
        sendData(ctx.res, { lines: await listBidLines(ctx, id), seed: seed.rows });
        return;
      }
      sendData(ctx.res, { lines: await listBidLines(ctx, id) });
    }),
  );
  router.put(
    "/bid-requests/:id/lines",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "issue_purchase_order");
      const id = parseUuidParam(ctx.req.params.id, "Bid request");
      const bid = await request(ctx, id);
      if (bid.closed_at) throw new ApiError("conflict", "This bid request is closed.");
      const body = parseBody(
        z.object({
          lines: z
            .array(
              z.object({
                cost_code_id: z.string().uuid(),
                cost_type: z.enum(["L", "M", "S", "O"]).default("S"),
                description: z.string().max(2000).optional(),
                budget_line_id: z.string().uuid().nullish(),
              }),
            )
            .max(200),
        }),
        ctx.req.body,
      );
      let lines = body.lines;
      if (ctx.req.query.seed === "budget") {
        const seed = await ctx.db.query<{
          budget_line_id: string;
          cost_code_id: string;
          cost_type: "L" | "M" | "S" | "O";
          description: string;
        }>(
          `SELECT b.id AS budget_line_id, b.cost_code_id, b.cost_type::text AS cost_type, cc.description
             FROM projects.budget_lines b
             JOIN projects.cost_codes cc ON cc.id = b.cost_code_id
            WHERE b.project_id = $1
            ORDER BY cc.sort_order, b.cost_type`,
          [bid.project_id],
        );
        lines = seed.rows;
      }
      await ctx.db.query(`DELETE FROM projects.bid_request_lines WHERE bid_request_id = $1`, [id]);
      let n = 0;
      for (const line of lines) {
        await requireOwnedRow(ctx.db, "cost_codes", line.cost_code_id, "cost_code_id", "AND active");
        n += 1;
        await ctx.db.query(
          `INSERT INTO projects.bid_request_lines
             (tenant_id, bid_request_id, line_no, cost_code_id, cost_type, budget_line_id, description)
           VALUES ($1,$2,$3,$4,$5::projects.cost_type,$6,$7)`,
          [
            ctx.staff.tenantId,
            id,
            n,
            line.cost_code_id,
            line.cost_type,
            line.budget_line_id ?? null,
            line.description ?? "",
          ],
        );
      }
      sendData(ctx.res, { lines: await listBidLines(ctx, id) });
    }),
  );
  router.put(
    "/bid-requests/:id/recipients/:recipientId/quote-lines",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "issue_purchase_order");
      const id = parseUuidParam(ctx.req.params.id, "Bid request");
      const recipientId = parseUuidParam(ctx.req.params.recipientId, "Recipient");
      await request(ctx, id);
      const body = parseBody(
        z.object({
          lines: z.array(
            z.object({
              bid_request_line_id: z.string().uuid(),
              amount: z.number().min(0),
              note: z.string().max(2000).nullish(),
            }),
          ),
        }),
        ctx.req.body,
      );
      await replaceQuoteLines(ctx.db, ctx.staff.tenantId, id, recipientId, body.lines);
      sendData(ctx.res, { saved: true });
    }),
  );
  router.get(
    "/bid-requests/:id/leveling",
    staffRoute(deps, async (ctx) => {
      const id = parseUuidParam(ctx.req.params.id, "Bid request");
      await request(ctx, id);
      const lines = await ctx.db.query<{
        id: string;
        line_no: number;
        cost_code_id: string;
        cost_code: string;
        description: string;
        cost_type: string;
        budget_amount: string | null;
      }>(
        `SELECT l.id, l.line_no, l.cost_code_id, cc.code AS cost_code, l.description,
                l.cost_type::text AS cost_type, bl.budget_amount::text AS budget_amount
           FROM projects.bid_request_lines l
           JOIN projects.cost_codes cc ON cc.id = l.cost_code_id
           LEFT JOIN projects.budget_lines bl ON bl.id = l.budget_line_id
          WHERE l.bid_request_id = $1
          ORDER BY l.line_no`,
        [id],
      );
      const recipients = await ctx.db.query<{
        id: string;
        vendor_id: string;
        legal_name: string;
        quote_amount: string | null;
        response_status: string;
        schedulable: boolean | null;
        missing_count: string | null;
        expired_count: string | null;
      }>(
        `SELECT r.id, r.vendor_id, v.legal_name, r.quote_amount::text AS quote_amount,
                r.response_status, e.schedulable, e.missing_count::text AS missing_count,
                e.expired_count::text AS expired_count
           FROM projects.bid_recipients r
           JOIN projects.vendors v ON v.id = r.vendor_id
           LEFT JOIN projects.v_vendor_eligibility e ON e.vendor_id = r.vendor_id
          WHERE r.request_id = $1
          ORDER BY v.legal_name`,
        [id],
      );
      const quotes = await ctx.db.query<{
        bid_recipient_id: string;
        bid_request_line_id: string;
        amount: string;
      }>(
        `SELECT q.bid_recipient_id, q.bid_request_line_id, q.amount::text AS amount
           FROM projects.bid_quote_lines q
           JOIN projects.bid_recipients r ON r.id = q.bid_recipient_id
          WHERE r.request_id = $1`,
        [id],
      );
      const byLine = new Map<string, Map<string, number>>();
      for (const quote of quotes.rows) {
        const row = byLine.get(quote.bid_request_line_id) ?? new Map<string, number>();
        row.set(quote.bid_recipient_id, Number(quote.amount));
        byLine.set(quote.bid_request_line_id, row);
      }
      sendData(ctx.res, {
        lines: lines.rows.map((line) => {
          const amounts = byLine.get(line.id) ?? new Map<string, number>();
          const quoted = [...amounts.values()];
          const budget = line.budget_amount == null ? null : Number(line.budget_amount);
          const low = quoted.length ? Math.min(...quoted) : null;
          return {
            id: line.id,
            line_no: line.line_no,
            cost_code_id: line.cost_code_id,
            cost_code: line.cost_code,
            cost_type: line.cost_type,
            description: line.description,
            budget_amount: budget,
            low_amount: low,
            variance_vs_budget: budget == null || low == null ? null : roundMoney(low - budget),
            quotes: recipients.rows.map((recipient) => ({
              recipient_id: recipient.id,
              amount: amounts.has(recipient.id) ? amounts.get(recipient.id) : null,
              missing: !amounts.has(recipient.id),
            })),
          };
        }),
        recipients: recipients.rows.map((recipient) => {
          const quotedLines = lines.rows.filter((line) => byLine.get(line.id)?.has(recipient.id));
          const total = lines.rows.reduce(
            (sum, line) => sum + (byLine.get(line.id)?.get(recipient.id) ?? 0),
            0,
          );
          return {
            id: recipient.id,
            vendor_id: recipient.vendor_id,
            legal_name: recipient.legal_name,
            response_status: recipient.response_status,
            quote_amount: recipient.quote_amount == null ? null : Number(recipient.quote_amount),
            total: lines.rows.length ? roundMoney(total) : recipient.quote_amount == null ? null : Number(recipient.quote_amount),
            missing_lines: lines.rows.length - quotedLines.length,
            schedulable: recipient.schedulable === true,
            missing_count: Number(recipient.missing_count ?? 0),
            expired_count: Number(recipient.expired_count ?? 0),
          };
        }),
      });
    }),
  );
  router.post(
    "/bid-requests/:id/recipients/:recipientId/award",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "issue_purchase_order");
      const id = parseUuidParam(ctx.req.params.id, "Bid request");
      const recipientId = parseUuidParam(ctx.req.params.recipientId, "Recipient");
      const bid = await request(ctx, id);
      const recipient = await ctx.db.query<{
        id: string;
        vendor_id: string;
        quote_amount: string | null;
        awarded_po_id: string | null;
        response_status: string;
      }>(
        `SELECT id, vendor_id, quote_amount::text AS quote_amount, awarded_po_id, response_status
           FROM projects.bid_recipients WHERE id = $1 AND request_id = $2`,
        [recipientId, id],
      );
      const row = recipient.rows[0];
      if (!row) throw notFound("Recipient not found");
      if (row.awarded_po_id) {
        const existing = await ctx.db.query(
          `SELECT id, po_number, status::text AS status, amount FROM projects.purchase_orders WHERE id = $1`,
          [row.awarded_po_id],
        );
        sendData(ctx.res, { ...existing.rows[0], amount: num(existing.rows[0]?.amount), idempotent: true });
        return;
      }
      if (bid.closed_at) throw new ApiError("conflict", "This bid request is already closed.");
      const body = parseBody(
        z.object({
          po_number: z.string().min(1).max(64),
          scope_text: z.string().min(1).optional(),
          cost_code_id: z.string().uuid().optional(),
          cost_type: z.enum(["L", "M", "S", "O"]).optional(),
        }),
        ctx.req.body,
      );
      await assertVendorCompliant(ctx.db, row.vendor_id, "award");
      const requestLines = await listBidLines(ctx, id);
      let poLines: Array<{
        cost_code_id: string;
        cost_type: string;
        description: string;
        amount: number;
        budget_line_id: string | null;
      }>;
      if (requestLines.length === 0) {
        if (!body.cost_code_id) {
          throw new ApiError(
            "validation_failed",
            "Choose a cost code. This bid request has no lines, so the draft purchase order needs one.",
          );
        }
        if (row.quote_amount == null) {
          throw new ApiError("conflict", "Record a quote amount before awarding this recipient.");
        }
        await requireOwnedRow(ctx.db, "cost_codes", body.cost_code_id, "cost_code_id", "AND active");
        poLines = [
          {
            cost_code_id: body.cost_code_id,
            cost_type: body.cost_type ?? "S",
            description: "",
            amount: Number(row.quote_amount),
            budget_line_id: null,
          },
        ];
      } else {
        const quotes = await ctx.db.query<{ bid_request_line_id: string; amount: string }>(
          `SELECT bid_request_line_id, amount::text AS amount
             FROM projects.bid_quote_lines WHERE bid_recipient_id = $1`,
          [recipientId],
        );
        const amounts = new Map(quotes.rows.map((quote) => [quote.bid_request_line_id, Number(quote.amount)]));
        const missing = requestLines.filter((line) => !amounts.has(String(line.id)));
        if (missing.length) {
          throw new ApiError(
            "conflict",
            "Every bid line needs a quote before this recipient can be awarded.",
            { missing_line_ids: missing.map((line) => line.id) },
          );
        }
        poLines = requestLines.map((line) => ({
          cost_code_id: String(line.cost_code_id),
          cost_type: String(line.cost_type),
          description: String(line.description ?? ""),
          amount: amounts.get(String(line.id)) ?? 0,
          budget_line_id: (line.budget_line_id as string | null) ?? null,
        }));
      }
      const first = poLines[0]!;
      const created = await ctx.db.query<{ id: string; po_number: string; status: string; amount: string }>(
        `INSERT INTO projects.purchase_orders
           (tenant_id, project_id, po_number, vendor_id, cost_code_id, cost_type, amount, scope_text,
            status, kind, source_bid_recipient_id)
         VALUES ($1,$2,$3,$4,$5,$6::projects.cost_type,0,$7,'draft','subcontract',$8)
         RETURNING id, po_number, status::text AS status, amount::text AS amount`,
        [
          ctx.staff.tenantId,
          bid.project_id,
          body.po_number,
          row.vendor_id,
          first.cost_code_id,
          first.cost_type,
          body.scope_text ?? bid.scope,
          recipientId,
        ],
      );
      const po = created.rows[0]!;
      let lineNo = 0;
      for (const line of poLines) {
        lineNo += 1;
        await ctx.db.query(
          `INSERT INTO projects.po_lines
             (tenant_id, po_id, line_no, cost_code_id, cost_type, description, original_amount, budget_line_id)
           VALUES ($1,$2,$3,$4,$5::projects.cost_type,$6,$7,$8)`,
          [
            ctx.staff.tenantId,
            po.id,
            lineNo,
            line.cost_code_id,
            line.cost_type,
            line.description,
            line.amount,
            line.budget_line_id,
          ],
        );
      }
      await ctx.db.query(
        `UPDATE projects.bid_recipients
            SET response_status = CASE WHEN id = $2 THEN 'awarded' ELSE 'not_selected' END,
                awarded_po_id = CASE WHEN id = $2 THEN $3 ELSE awarded_po_id END
          WHERE request_id = $1 AND response_status <> 'awarded'`,
        [id, recipientId, po.id],
      );
      await ctx.db.query(`UPDATE projects.bid_requests SET closed_at = now() WHERE id = $1`, [id]);
      const stored = await ctx.db.query<{ amount: string }>(
        `SELECT amount::text AS amount FROM projects.purchase_orders WHERE id = $1`,
        [po.id],
      );
      sendData(
        ctx.res,
        {
          id: po.id,
          po_number: po.po_number,
          status: "draft",
          amount: Number(stored.rows[0]?.amount ?? 0),
          idempotent: false,
        },
        undefined,
        201,
      );
    }),
  );
  async function prepare(ctx: StaffContext, sending: boolean) {
    requireCapability(ctx.staff.role, "send_change_order");
    const id = parseUuidParam(ctx.req.params.id, "Bid request"),
      b = await request(ctx, id),
      c = configured(ctx);
    if (!c)
      throw new ApiError("conflict", "Bid response links are not configured.");
    if (sending && !mailEnabled(c))
      throw new ApiError(
        "conflict",
        "Connect an email sender before sending. Use email drafts in the meantime.",
      );
    if (b.closed_at)
      throw new ApiError("conflict", "This bid request is closed.");
    await ctx.db.query(
      "SELECT id FROM projects.bid_requests WHERE id=$1 FOR UPDATE",
      [id],
    );
    const r = await ctx.db.query<{
      id: string;
      email: string;
      legal_name: string;
    }>(
      `SELECT r.id,r.email,v.legal_name FROM projects.bid_recipients r JOIN projects.vendors v ON v.id=r.vendor_id WHERE r.request_id=$1 AND r.delivery_status IN ('draft','prepared','failed') AND r.response_status='awaiting' ORDER BY v.legal_name`,
      [id],
    );
    const messages = [];
    for (const row of r.rows) {
      const token = bidToken(c, row.id);
      const url =
        c.origin +
        "/bid-response.html#" +
        new URLSearchParams({
          tenant: ctx.staff.tenantId,
          recipient: row.id,
          token,
        });
      const text =
        "Hello " +
        row.legal_name +
        ",\n\n" +
        b.scope +
        "\n\nQuote due: " +
        (b.due_on ?? "Please advise") +
        "\nWork window: " +
        (b.window_start ?? "To be confirmed") +
        " to " +
        (b.window_end ?? "To be confirmed") +
        "\n\nPlease submit your interest, availability and quote here:\n" +
        url +
        "\n\nThis is a request for a quote, not an authorization to begin work.";
      await ctx.db.query(
        `UPDATE projects.bid_recipients SET delivery_status=$2,token_hash=$3,token_expires_at=now()+interval '90 days',last_error=NULL WHERE id=$1`,
        [row.id, sending ? "sending" : "prepared", tokenHash(token)],
      );
      messages.push({
        id: row.id,
        to: row.email,
        subject: b.subject,
        text,
        key: "bid-" + row.id,
      });
    }
    return { c, messages };
  }
  router.post(
    "/bid-requests/:id/email-drafts",
    staffRoute(deps, async (ctx) => {
      const p = await prepare(ctx, false);
      ctx.res.setHeader("Cache-Control", "no-store");
      sendData(ctx.res, { messages: p.messages });
    }),
  );
  router.post(
    "/bid-requests/:id/recipients/:recipientId/mark-sent",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "send_change_order");
      const id = parseUuidParam(ctx.req.params.id, "Bid request"),
        rid = parseUuidParam(ctx.req.params.recipientId, "Recipient");
      await request(ctx, id);
      const r = await ctx.db.query(
        `UPDATE projects.bid_recipients SET delivery_status='sent',sent_at=now(),history=history||$3::jsonb WHERE id=$1 AND request_id=$2 AND delivery_status='prepared' RETURNING id`,
        [
          rid,
          id,
          JSON.stringify([
            {
              at: new Date().toISOString(),
              event: "Sent from mailbox; recorded by staff",
              actor: ctx.staff.staffId,
            },
          ]),
        ],
      );
      if (!r.rows.length)
        throw new ApiError("conflict", "Prepare an email draft first.");
      sendData(ctx.res, r.rows[0]);
    }),
  );
  router.post(
    "/bid-requests/:id/send",
    staffExternalRoute(
      deps,
      (ctx) => prepare(ctx, true),
      async (p) => {
        const results = [];
        for (const m of p.messages) {
          try {
            results.push({
              id: m.id,
              providerId: await sendBid(p.c, m),
              ok: true,
            });
          } catch {
            results.push({ id: m.id, providerId: null, ok: false });
          }
        }
        return results;
      },
      async (ctx, p, results) => {
        for (const r of results)
          await ctx.db.query(
            `UPDATE projects.bid_recipients SET delivery_status=$2,provider_id=$3,sent_at=CASE WHEN $4 THEN now() ELSE sent_at END,last_error=$5 WHERE id=$1`,
            [
              r.id,
              r.ok ? "sent" : "uncertain",
              r.providerId,
              r.ok,
              r.ok
                ? null
                : "Provider acceptance could not be confirmed; check the sending service before retrying.",
            ],
          );
        sendData(ctx.res, {
          sent: results.filter((r) => r.ok).length,
          uncertain: results.filter((r) => !r.ok).length,
        });
      },
    ),
  );
  return router;
}
export function bidResponseRoutes(db: Database) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  async function access(req: any, fn: (client: any, row: any) => Promise<any>) {
    const tenant = parseUuidParam(req.params.tenantId, "Request"),
      recipient = parseUuidParam(req.params.recipientId, "Request");
    const token = req.get("X-Bid-Token");
    if (typeof token !== "string" || !/^\w{64}$/.test(token))
      throw notFound("Bid link is invalid or expired");
    return db.withTenant(tenant, async (client) => {
      const r = await client.query(
        `SELECT r.id,r.request_id,r.response_status,r.quote_amount::text,r.response_notes,r.available_from,b.subject,b.scope,b.due_on,b.window_start,b.window_end,p.currency FROM projects.bid_recipients r JOIN projects.bid_requests b ON b.id=r.request_id JOIN projects.projects p ON p.id=b.project_id WHERE r.id=$1 AND r.token_hash=$2 AND r.token_expires_at>now() AND b.closed_at IS NULL AND r.delivery_status IN ('prepared','sending','sent','uncertain') FOR UPDATE OF r`,
        [recipient, tokenHash(token)],
      );
      if (!r.rows[0]) throw notFound("Bid link is invalid or expired");
      return fn(client, r.rows[0]);
    });
  }
  router.get("/:tenantId/:recipientId", (req, res, next) => {
    access(req, async (_db, row) => row)
      .then((data) => sendData(res, data))
      .catch(next);
  });
  router.post("/:tenantId/:recipientId", (req, res, next) => {
    access(req, async (client, row) => {
      if (["awarded", "not_selected"].includes(row.response_status))
        throw new ApiError("conflict", "This bid has already been decided.");
      const b = parseBody(
        response
          .extend({
            response_status: z.enum(["interested", "declined", "quoted"]),
            lines: z
              .array(
                z.object({
                  bid_request_line_id: z.string().uuid(),
                  amount: z.number().min(0),
                  note: z.string().max(2000).nullish(),
                }),
              )
              .optional(),
          })
          .refine(
            (x) =>
              x.response_status !== "quoted" ||
              x.quote_amount != null ||
              (x.lines?.length ?? 0) > 0,
            "A quoted amount is required",
          ),
        req.body,
      );
      const quoted = b.lines?.length
        ? roundMoney(b.lines.reduce((sum, line) => sum + line.amount, 0))
        : (b.quote_amount ?? null);
      await client.query(
        `UPDATE projects.bid_recipients SET response_status=$2,quote_amount=$3,response_notes=$4,available_from=$5,responded_at=now(),history=history||$6::jsonb WHERE id=$1`,
        [
          row.id,
          b.response_status,
          quoted,
          b.response_notes ?? null,
          b.available_from ?? null,
          JSON.stringify([
            {
              at: new Date().toISOString(),
              actor: "subcontractor response link",
              response_status: b.response_status,
              quote_amount: quoted,
            },
          ]),
        ],
      );
      if (b.lines) {
        await replaceQuoteLines(
          client,
          parseUuidParam(req.params.tenantId, "Request"),
          row.request_id,
          row.id,
          b.lines,
        );
      }
      return { saved: true };
    })
      .then((data) => sendData(res, data))
      .catch(next);
  });
  return router;
}

async function listBidLines(ctx: StaffContext, requestId: string) {
  const rows = await ctx.db.query(
    `SELECT l.id, l.line_no, l.cost_code_id, cc.code AS cost_code, l.cost_type::text AS cost_type,
            l.description, l.budget_line_id
       FROM projects.bid_request_lines l
       JOIN projects.cost_codes cc ON cc.id = l.cost_code_id
      WHERE l.bid_request_id = $1
      ORDER BY l.line_no`,
    [requestId],
  );
  return rows.rows;
}

async function replaceQuoteLines(
  db: SqlClient,
  tenantId: string,
  requestId: string,
  recipientId: string,
  lines: Array<{ bid_request_line_id: string; amount: number; note?: string | null }>,
) {
  const recipient = await db.query(
    `SELECT id FROM projects.bid_recipients WHERE id = $1 AND request_id = $2`,
    [recipientId, requestId],
  );
  if (!recipient.rows[0]) throw notFound("Recipient not found");
  await db.query(`DELETE FROM projects.bid_quote_lines WHERE bid_recipient_id = $1`, [recipientId]);
  for (const line of lines) {
    const match = await db.query(
      `SELECT id FROM projects.bid_request_lines WHERE id = $1 AND bid_request_id = $2`,
      [line.bid_request_line_id, requestId],
    );
    if (!match.rows[0]) {
      throw new ApiError("conflict", "That line is not on this bid request.");
    }
    await db.query(
      `INSERT INTO projects.bid_quote_lines
         (tenant_id, bid_recipient_id, bid_request_line_id, amount, note)
       VALUES ($1,$2,$3,$4,$5)`,
      [tenantId, recipientId, line.bid_request_line_id, line.amount, line.note ?? null],
    );
  }
  await db.query(
    `UPDATE projects.bid_recipients
        SET quote_amount = (SELECT COALESCE(SUM(amount), 0) FROM projects.bid_quote_lines WHERE bid_recipient_id = $1)
      WHERE id = $1`,
    [recipientId],
  );
}
