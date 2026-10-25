import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { PortfolioFeedConfig } from "../adapters/portfolioFeed.js";
import type { Database, SqlClient } from "../db/database.js";
import { presentFieldRelease } from "../domain/fieldRelease.js";
import { sendData } from "../http/envelope.js";
import { ApiError } from "../http/errors.js";

/**
 * GET /api/v1/portfolio/summary — one read-only document describing the state
 * of a tenant's project portfolio, for that tenant's owner dashboard.
 *
 * It sits outside the staff tree on purpose: there is no staff member behind
 * the call, so staffAuthentication has nothing to resolve. The tenant comes
 * from configuration (PM_PORTFOLIO_TENANT_ID) and the caller proves itself
 * with a bearer token (PM_PORTFOLIO_TOKEN). Everything is read inside
 * withTenant(), so RLS scopes every row exactly as it does for a signed-in
 * owner, and an unentitled tenant reads as empty rather than as a leak.
 */
const sha = (s: string) => createHash("sha256").update(s).digest();
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export function portfolioRoutes(
  database: Database,
  config: PortfolioFeedConfig,
): Router {
  const router = Router();
  const expected = sha(config.token);

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const header = req.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match || !timingSafeEqual(sha(match[1]!), expected)) {
      next(new ApiError("unauthenticated", "A portfolio feed token is required."));
      return;
    }
    next();
  });

  router.get("/summary", (_req, res, next) => {
    database
      .withTenant(config.tenantId, (db) => buildSummary(db, config.tenantId))
      .then((summary) => sendData(res, summary))
      .catch(next);
  });

  return router;
}

async function buildSummary(db: SqlClient, tenantId: string) {
  const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.query<R>(sql, params)).rows;

  const tenant = (
    await q<{ display_name: string }>(
      `SELECT display_name FROM projects.tenants WHERE id = $1`,
      [tenantId],
    )
  )[0];

  const projects = await q<{
    id: string; project_number: string; name: string; stage: string; city: string; region: string;
    contract_value: string; target_margin: string; scheduled_start: string | null; scheduled_end: string | null;
    actual_start: string | null; updated_at: string; pm: string | null;
    revised_contract: string | null; committed_cost: string | null; projected_cost: string | null;
    gates_awaiting: string; draws_waiting: string;
    field_released_at: unknown; field_release_note: string | null; field_released_by_name: string | null;
  }>(
    `SELECT p.id, p.project_number, p.name, p.stage::text AS stage, p.city, p.region,
            p.contract_value::text, p.target_margin::text,
            p.scheduled_start::text, p.scheduled_end::text, p.actual_start::text, p.updated_at::text,
            s.full_name AS pm,
            m.revised_contract::text, m.committed_cost::text, m.projected_cost::text,
            (SELECT count(*) FROM projects.stage_gates g WHERE g.project_id = p.id AND g.status = 'submitted')::text AS gates_awaiting,
            (SELECT count(*) FROM projects.draws d WHERE d.project_id = p.id AND d.status IN ('earned','approved'))::text AS draws_waiting,
            p.field_released_at, p.field_release_note, rel.full_name AS field_released_by_name
       FROM projects.projects p
       LEFT JOIN projects.staff s ON s.id = p.pm_id
       LEFT JOIN projects.staff rel ON rel.id = p.field_released_by
       LEFT JOIN projects.v_project_margin m ON m.project_id = p.id
      WHERE p.stage NOT IN ('complete','cancelled')
      ORDER BY p.updated_at DESC`,
  );

  const closed = (
    await q<{ n: string; value: string }>(
      `SELECT count(*)::text AS n, COALESCE(SUM(contract_value),0)::text AS value
         FROM projects.projects WHERE stage = 'complete' AND updated_at >= now() - interval '90 days'`,
    )
  )[0];

  const draws = await q<{
    project_number: string; project_name: string; label: string; amount: string; status: string;
    earned_at: string | null; approved_at: string | null; external_invoice_number: string | null;
  }>(
    `SELECT p.project_number, p.name AS project_name, d.label, d.amount::text, d.status::text AS status,
            d.earned_at::text, d.approved_at::text, d.external_invoice_number
       FROM projects.draws d JOIN projects.projects p ON p.id = d.project_id
      WHERE d.status IN ('earned','approved','invoiced')
      ORDER BY COALESCE(d.approved_at, d.earned_at) NULLS LAST`,
  );

  const budget = await q(
    `SELECT p.project_number, p.name AS project_name, b.cost_code, b.description,
            b.baseline::text, b.total_committed::text, b.variance::text, b.pct_over::text
       FROM projects.v_budget_exceptions b JOIN projects.projects p ON p.id = b.project_id
      WHERE p.stage NOT IN ('complete','cancelled')
      ORDER BY b.variance ASC`,
  );
  const permits = await q(
    `SELECT project_number, jurisdiction, milestone, due_on::text, days_overdue
       FROM projects.v_permit_exceptions ORDER BY days_overdue DESC`,
  );
  const missingLogs = await q(
    `SELECT project_number, name FROM projects.v_missing_daily_logs ORDER BY project_number`,
  );
  const unrecorded = await q(
    `SELECT invoice_number, project_number, project_name, amount::text, issued_on::text, days_since_issued
       FROM projects.v_unrecorded_invoices ORDER BY days_since_issued DESC`,
  );
  const unapplied = (
    await q<{ n: string; amount: string; unmatched: string }>(
      `SELECT count(*)::text AS n, COALESCE(SUM(unapplied_amount),0)::text AS amount,
              count(*) FILTER (WHERE unmatched_to_project)::text AS unmatched
         FROM projects.v_unapplied_invoices`,
    )
  )[0];
  const vendors = await q<{ legal_name: string; expired_count: string; missing_count: string; next_expiry: string | null }>(
    `SELECT legal_name, expired_count::text, missing_count::text, next_expiry::text
       FROM projects.v_vendor_eligibility WHERE NOT schedulable ORDER BY legal_name`,
  );
  const expiring = (
    await q<{ n: string }>(
      `SELECT count(DISTINCT vendor_id)::text AS n FROM projects.v_vendor_compliance WHERE state = 'expiring'`,
    )
  )[0];

  const pos = (
    await q<{ n: string; amount: string }>(
      `SELECT count(*)::text AS n, COALESCE(SUM(amount),0)::text AS amount
         FROM projects.purchase_orders WHERE status IN ('issued','partially_billed')`,
    )
  )[0];
  const bills = (
    await q<{ n: string; amount: string }>(
      `SELECT count(*)::text AS n, COALESCE(SUM(b.amount),0)::text AS amount
         FROM projects.vendor_bills b
         JOIN projects.purchase_orders po ON po.id = b.po_id
        WHERE b.status = 'received' AND b.source = 'journeyman' AND po.kind = 'subcontract'`,
    )
  )[0];
  const materialBills = (
    await q<{ n: string; amount: string }>(
      `SELECT count(*)::text AS n, COALESCE(SUM(b.amount),0)::text AS amount
         FROM projects.vendor_bills b
         JOIN projects.purchase_orders po ON po.id = b.po_id
        WHERE b.status = 'received' AND po.kind = 'material'`,
    )
  )[0];
  const cos = (
    await q<{ n: string; amount: string }>(
      `SELECT count(*)::text AS n, COALESCE(SUM(customer_amount),0)::text AS amount
         FROM projects.change_orders WHERE status = 'sent'`,
    )
  )[0];

  const byStage: Record<string, number> = {};
  for (const p of projects) byStage[p.stage] = (byStage[p.stage] ?? 0) + 1;
  const backlog = projects.reduce((t, p) => t + num(p.revised_contract ?? p.contract_value), 0);
  const committed = projects.reduce((t, p) => t + num(p.committed_cost), 0);
  const projected = projects.reduce((t, p) => t + num(p.projected_cost), 0);
  const budgeted = projects.filter((p) => p.projected_cost !== null);
  const budgetedContract = budgeted.reduce((t, p) => t + num(p.revised_contract), 0);
  const budgetedProjected = budgeted.reduce((t, p) => t + num(p.projected_cost), 0);

  const money = (r: { n: string; amount: string } | undefined) => ({ count: num(r?.n), amount: num(r?.amount) });
  return {
    generated_at: new Date().toISOString(),
    tenant: { id: tenantId, name: tenant?.display_name ?? null },
    totals: {
      active_projects: projects.length,
      by_stage: byStage,
      backlog_contract: backlog,
      committed_cost: committed,
      projected_cost: projected,
      projected_margin_pct: budgetedContract > 0 ? (budgetedContract - budgetedProjected) / budgetedContract : null,
      completed_90d: { count: num(closed?.n), contract_value: num(closed?.value) },
    },
    projects: projects.map((p) => {
      const revised = num(p.revised_contract ?? p.contract_value);
      const proj = p.projected_cost === null ? null : num(p.projected_cost);
      return {
        id: p.id, project_number: p.project_number, name: p.name, stage: p.stage,
        city: p.city, region: p.region, pm: p.pm,
        contract_value: num(p.contract_value), revised_contract: revised,
        target_margin: num(p.target_margin),
        committed_cost: p.committed_cost === null ? null : num(p.committed_cost),
        projected_cost: proj,
        projected_margin_pct: proj === null || revised <= 0 ? null : (revised - proj) / revised,
        scheduled_start: p.scheduled_start, scheduled_end: p.scheduled_end, actual_start: p.actual_start,
        field_release: presentFieldRelease({
          released_at: p.field_released_at,
          released_by: p.field_released_by_name,
          note: p.field_release_note,
        }),
        gates_awaiting_approval: num(p.gates_awaiting), draws_waiting: num(p.draws_waiting),
        updated_at: p.updated_at,
      };
    }),
    draws: {
      earned_awaiting_approval: draws.filter((d) => d.status === "earned").map(drawRow),
      approved_not_invoiced: draws.filter((d) => d.status === "approved" && !d.external_invoice_number).map(drawRow),
      invoiced_unpaid: draws.filter((d) => d.status === "invoiced").map(drawRow),
    },
    exceptions: {
      budget: budget.map((b) => ({ ...b, baseline: num(b.baseline), total_committed: num(b.total_committed), variance: num(b.variance), pct_over: num(b.pct_over) })),
      permits: permits.map((r) => ({ ...r, days_overdue: num(r.days_overdue) })),
      missing_daily_logs: missingLogs,
      unrecorded_invoices: unrecorded.map((r) => ({ ...r, amount: num(r.amount), days_since_issued: num(r.days_since_issued) })),
      unapplied_invoices: { count: num(unapplied?.n), amount: num(unapplied?.amount), unmatched_to_project: num(unapplied?.unmatched) },
      vendors_blocked: vendors.map((v) => ({ name: v.legal_name, expired: num(v.expired_count), missing: num(v.missing_count), next_expiry: v.next_expiry })),
      vendors_expiring: num(expiring?.n),
      gates_awaiting_approval: projects.reduce((t, p) => t + num(p.gates_awaiting), 0),
    },
    purchasing: {
      open_purchase_orders: money(pos),
      bills_awaiting_approval: money(bills),
      material_bills_unmatched: money(materialBills),
      change_orders_awaiting_customer: money(cos),
    },
  };
}

function drawRow(d: { project_number: string; project_name: string; label: string; amount: string; earned_at: string | null; approved_at: string | null; external_invoice_number: string | null }) {
  const since = d.approved_at ?? d.earned_at;
  return {
    project_number: d.project_number, project_name: d.project_name, label: d.label, amount: num(d.amount),
    earned_at: d.earned_at, approved_at: d.approved_at, external_invoice_number: d.external_invoice_number,
    days_waiting: since ? Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 86_400_000)) : null,
  };
}
