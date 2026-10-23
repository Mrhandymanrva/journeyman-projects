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
import { parseBody, parseUuidParam, loadVisibleProject } from "./shared.js";
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
        `SELECT r.id,r.vendor_id,r.email,r.delivery_status,r.response_status,r.quote_amount::text,r.response_notes,r.available_from,r.sent_at,r.responded_at,r.last_error,r.history,v.legal_name,v.trades FROM projects.bid_recipients r JOIN projects.vendors v ON v.id=r.vendor_id WHERE r.request_id=$1 ORDER BY v.legal_name`,
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
          })
          .refine(
            (x) => x.response_status !== "quoted" || x.quote_amount != null,
            "A quoted amount is required",
          ),
        req.body,
      );
      await client.query(
        `UPDATE projects.bid_recipients SET response_status=$2,quote_amount=$3,response_notes=$4,available_from=$5,responded_at=now(),history=history||$6::jsonb WHERE id=$1`,
        [
          row.id,
          b.response_status,
          b.quote_amount ?? null,
          b.response_notes ?? null,
          b.available_from ?? null,
          JSON.stringify([
            {
              at: new Date().toISOString(),
              actor: "subcontractor response link",
              ...b,
            },
          ]),
        ],
      );
      return { saved: true };
    })
      .then((data) => sendData(res, data))
      .catch(next);
  });
  return router;
}
