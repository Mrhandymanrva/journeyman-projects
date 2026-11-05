import type { SqlClient } from "../db/database.js";

/**
 * Portfolio health from local tables.
 *
 * Score starts at 100. Each red reason subtracts 20 and each yellow reason
 * subtracts 8, with a floor of 0. The band is red when any reason is red,
 * yellow when any reason is yellow, and green otherwise.
 *
 * A logged start that has passed, or is inside the next 7 days, with no
 * field start is not a reason. Field start is red only when it is more than
 * 7 days after the stored scheduled_start and both dates are set.
 *
 * Budget uses 80% and 100% of baseline. Those two cutoffs are copied here
 * until the staff budget alert module is on main. A zero baseline is not a
 * budget reason. Uncoded hours are a yellow budget detail, not a red by
 * themselves, and they share the budget reason when one already exists.
 */

export const BUDGET_YELLOW = 0.8;
export const BUDGET_RED = 1;

export type HealthBand = "green" | "yellow" | "red";
export type ReasonBand = "red" | "yellow";
export type HealthCode =
  | "budget"
  | "field_start"
  | "sub_compliance"
  | "precon"
  | "draws"
  | "closeout";

export interface HealthReason {
  code: HealthCode;
  band: ReasonBand;
  detail: string;
}

export interface HealthScore {
  score: number;
  band: HealthBand;
  reasons: HealthReason[];
}

export interface BillingPosition {
  position: "over" | "under" | "even";
  amount: number;
}

export interface ProjectHealthRow {
  project_id: string;
  stage: string;
  actual_end: string | null;
  updated_on: string | null;
  projected_margin_pct: number | null;
  revised_contract: number | null;
  committed_cost: number | null;
  projected_cost: number | null;
  billing: BillingPosition;
  health: HealthScore;
}

interface HealthFacts {
  project_id: string;
  stage: string;
  scheduled_start: string | null;
  field_start: string | null;
  actual_end: string | null;
  updated_on: string | null;
  gate_2_status: string | null;
  gate_3_status: string | null;
  baseline: number;
  committed: number;
  budget_exception: boolean;
  uncoded_hours: number;
  revised_contract: number | null;
  committed_cost: number | null;
  projected_cost: number | null;
  projected_margin_pct: number | null;
  vendor_blocked: boolean;
  vendor_expiring: boolean;
  precon_overdue: number;
  precon_late: number;
  draws_approved_stale: number;
  draw_stale_label: string | null;
  draw_stale_days: number | null;
  draws_unpaid_stale: number;
  unpaid_invoice_number: string | null;
  draws_earned_stale: number;
  closeout_open: number;
  under_billed: number;
  over_billed: number;
}

const INVOLVED_VENDORS = `
  SELECT po.vendor_id AS vendor_id
    FROM projects.purchase_orders po
   WHERE po.project_id = p.id
     AND po.status IN ('issued', 'partially_billed', 'closed')
     AND po.vendor_id IS NOT NULL
  UNION
  SELECT s.vendor_id
    FROM projects.schedule_items s
   WHERE s.project_id = p.id
     AND s.vendor_id IS NOT NULL
`;

const FACTS_SQL = `
SELECT
  p.id AS project_id,
  p.stage::text AS stage,
  p.scheduled_start::text AS scheduled_start,
  p.field_start::text AS field_start,
  p.actual_end::text AS actual_end,
  (p.updated_at AT TIME ZONE 'America/New_York')::date::text AS updated_on,
  (SELECT g.status::text FROM projects.stage_gates g
    WHERE g.project_id = p.id AND g.gate_number = 2) AS gate_2_status,
  (SELECT g.status::text FROM projects.stage_gates g
    WHERE g.project_id = p.id AND g.gate_number = 3) AS gate_3_status,
  COALESCE((
    SELECT SUM(COALESCE(b.baseline_amount, b.budget_amount))
      FROM projects.budget_lines b WHERE b.project_id = p.id
  ), 0)::text AS baseline,
  COALESCE((
    SELECT SUM(v.total_committed) FROM projects.v_cost_position v WHERE v.project_id = p.id
  ), 0)::text AS committed,
  EXISTS (
    SELECT 1 FROM projects.v_budget_exceptions e WHERE e.project_id = p.id
  ) AS budget_exception,
  COALESCE((
    SELECT SUM(a.hours) FROM projects.labor_actuals a
     WHERE a.project_id = p.id AND a.cost_code_id IS NULL
  ), 0)::text AS uncoded_hours,
  m.revised_contract::text AS revised_contract,
  m.committed_cost::text AS committed_cost,
  m.projected_cost::text AS projected_cost,
  CASE
    WHEN m.revised_contract > 0 THEN round((m.revised_contract - m.projected_cost) / m.revised_contract, 4)::text
    ELSE NULL
  END AS projected_margin_pct,
  EXISTS (
    SELECT 1 FROM (${INVOLVED_VENDORS}) involved
    JOIN projects.v_vendor_eligibility e ON e.vendor_id = involved.vendor_id
    WHERE e.schedulable IS NOT TRUE
  ) AS vendor_blocked,
  EXISTS (
    SELECT 1 FROM (${INVOLVED_VENDORS}) involved
    JOIN projects.v_vendor_compliance c ON c.vendor_id = involved.vendor_id
    WHERE c.state = 'expiring'
  ) AS vendor_expiring,
  (
    SELECT count(*) FROM projects.precon_tasks t
     WHERE t.project_id = p.id
       AND t.status IN ('not_started', 'in_progress')
       AND t.due_on IS NOT NULL
       AND t.due_on < $1::date
  )::text AS precon_overdue,
  (
    SELECT count(*) FROM projects.precon_tasks t
     WHERE t.project_id = p.id
       AND t.status IN ('not_started', 'in_progress')
       AND t.due_on IS NOT NULL
       AND t.due_on < $1::date - 7
  )::text AS precon_late,
  (
    SELECT count(*) FROM projects.draws d
     WHERE d.project_id = p.id
       AND d.status = 'approved'
       AND NULLIF(btrim(d.external_invoice_number), '') IS NULL
       AND d.approved_at IS NOT NULL
       AND (d.approved_at AT TIME ZONE 'America/New_York')::date < $1::date - 7
  )::text AS draws_approved_stale,
  (
    SELECT d.label FROM projects.draws d
     WHERE d.project_id = p.id
       AND d.status = 'approved'
       AND NULLIF(btrim(d.external_invoice_number), '') IS NULL
       AND d.approved_at IS NOT NULL
       AND (d.approved_at AT TIME ZONE 'America/New_York')::date < $1::date - 7
     ORDER BY d.approved_at, d.sequence_number
     LIMIT 1
  ) AS draw_stale_label,
  (
    SELECT ($1::date - (d.approved_at AT TIME ZONE 'America/New_York')::date)::text
      FROM projects.draws d
     WHERE d.project_id = p.id
       AND d.status = 'approved'
       AND NULLIF(btrim(d.external_invoice_number), '') IS NULL
       AND d.approved_at IS NOT NULL
       AND (d.approved_at AT TIME ZONE 'America/New_York')::date < $1::date - 7
     ORDER BY d.approved_at, d.sequence_number
     LIMIT 1
  ) AS draw_stale_days,
  (
    SELECT count(*) FROM projects.draws d
     WHERE d.project_id = p.id
       AND d.status = 'invoiced'
       AND EXISTS (
         SELECT 1 FROM projects.st_invoice_observations i
          WHERE i.project_id = d.project_id
            AND lower(btrim(i.invoice_number)) = lower(btrim(d.external_invoice_number))
            AND i.balance > 0
            AND COALESCE(
              i.invoiced_on,
              (d.external_invoice_recorded_at AT TIME ZONE 'America/New_York')::date
            ) < $1::date - 30
       )
  )::text AS draws_unpaid_stale,
  (
    SELECT i.invoice_number
      FROM projects.draws d
      JOIN projects.st_invoice_observations i
        ON i.project_id = d.project_id
       AND lower(btrim(i.invoice_number)) = lower(btrim(d.external_invoice_number))
     WHERE d.project_id = p.id
       AND d.status = 'invoiced'
       AND i.balance > 0
       AND COALESCE(
         i.invoiced_on,
         (d.external_invoice_recorded_at AT TIME ZONE 'America/New_York')::date
       ) < $1::date - 30
     ORDER BY COALESCE(i.invoiced_on, (d.external_invoice_recorded_at AT TIME ZONE 'America/New_York')::date)
     LIMIT 1
  ) AS unpaid_invoice_number,
  (
    SELECT count(*) FROM projects.draws d
     WHERE d.project_id = p.id
       AND d.status = 'earned'
       AND d.earned_at IS NOT NULL
       AND (d.earned_at AT TIME ZONE 'America/New_York')::date <= $1::date - 3
  )::text AS draws_earned_stale,
  (
    (CASE WHEN COALESCE((
        SELECT c.punch_done_at IS NOT NULL FROM projects.project_closeout c WHERE c.project_id = p.id
      ), false) THEN 0 ELSE 1 END)
    + (CASE WHEN COALESCE((
        SELECT c.photos_done_at IS NOT NULL FROM projects.project_closeout c WHERE c.project_id = p.id
      ), false) THEN 0 ELSE 1 END)
    + (CASE WHEN (
        EXISTS (
          SELECT 1 FROM projects.project_closeout c
           WHERE c.project_id = p.id
             AND NULLIF(btrim(c.final_draw_invoice_number), '') IS NOT NULL
        )
        OR EXISTS (
          SELECT 1 FROM projects.draws d
           WHERE d.project_id = p.id
             AND d.is_retainage
             AND (
               NULLIF(btrim(d.external_invoice_number), '') IS NOT NULL
               OR d.external_invoice_verified_at IS NOT NULL
             )
        )
      ) THEN 0 ELSE 1 END)
    + (CASE WHEN COALESCE((
        SELECT c.warranty_start_on IS NOT NULL FROM projects.project_closeout c WHERE c.project_id = p.id
      ), false) THEN 0 ELSE 1 END)
    + (CASE WHEN COALESCE((
        SELECT NULLIF(btrim(c.review_request_note), '') IS NOT NULL
          FROM projects.project_closeout c WHERE c.project_id = p.id
      ), false) THEN 0 ELSE 1 END)
  )::text AS closeout_open,
  (
    COALESCE((
      SELECT SUM(GREATEST(d.amount - COALESCE(pi.amount, 0), 0))
        FROM projects.draws d
        LEFT JOIN projects.project_invoices pi
          ON pi.draw_id = d.id AND pi.status <> 'void'
       WHERE d.project_id = p.id AND d.status IN ('earned', 'approved')
    ), 0)
    + COALESCE((
      SELECT SUM(co.customer_amount)
        FROM projects.change_orders co
       WHERE co.project_id = p.id
         AND co.status = 'approved'
         AND NOT EXISTS (
           SELECT 1 FROM projects.project_invoices pi
            WHERE pi.change_order_id = co.id AND pi.status <> 'void'
         )
    ), 0)
  )::text AS under_billed,
  (
    COALESCE((
      SELECT SUM(GREATEST(
        GREATEST(COALESCE(obs.total, 0), COALESCE(pi.amount, 0)) - d.amount,
        0
      ))
        FROM projects.draws d
        LEFT JOIN LATERAL (
          SELECT MAX(i.total) AS total
            FROM projects.st_invoice_observations i
           WHERE i.project_id = d.project_id
             AND NULLIF(btrim(d.external_invoice_number), '') IS NOT NULL
             AND lower(btrim(i.invoice_number)) = lower(btrim(d.external_invoice_number))
        ) obs ON true
        LEFT JOIN projects.project_invoices pi
          ON pi.draw_id = d.id AND pi.status <> 'void'
       WHERE d.project_id = p.id
         AND (obs.total IS NOT NULL OR pi.id IS NOT NULL)
    ), 0)
    + COALESCE((
      SELECT SUM(i.total)
        FROM projects.st_invoice_observations i
        JOIN projects.project_job_links j
          ON j.project_id = i.project_id
         AND j.external_job_id = i.external_job_id
         AND j.source_active
       WHERE i.project_id = p.id
         AND NULLIF(btrim(i.invoice_number), '') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM projects.draws d
            WHERE d.project_id = i.project_id
              AND lower(btrim(d.external_invoice_number)) = lower(btrim(i.invoice_number))
         )
         AND NOT EXISTS (
           SELECT 1 FROM projects.change_orders co
            WHERE co.project_id = i.project_id
              AND co.status = 'approved'
              AND (
                lower(btrim(co.st_estimate_number)) = lower(btrim(i.invoice_number))
                OR lower(btrim(co.external_estimate_ref)) = lower(btrim(i.invoice_number))
              )
         )
    ), 0)
  )::text AS over_billed
FROM projects.projects p
LEFT JOIN projects.v_project_margin m ON m.project_id = p.id
ORDER BY p.project_number
`;

function num(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year!, (month ?? 1) - 1, (day ?? 1) + days));
  return utc.toISOString().slice(0, 10);
}

export function daysBetween(earlier: string, later: string): number {
  const start = Date.parse(`${earlier.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${later.slice(0, 10)}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

function budgetReason(facts: HealthFacts): HealthReason | null {
  const uncoded = facts.uncoded_hours > 0;
  let reason: HealthReason | null = null;
  if (facts.baseline > 0) {
    const ratio = facts.committed / facts.baseline;
    const pct = Math.round(ratio * 100);
    if (ratio >= BUDGET_RED || facts.budget_exception) {
      reason = {
        code: "budget",
        band: "red",
        detail:
          ratio >= BUDGET_RED
            ? `Committed cost is ${pct}% of baseline`
            : "A cost line is over 110% of its baseline",
      };
    } else if (ratio >= BUDGET_YELLOW) {
      reason = {
        code: "budget",
        band: "yellow",
        detail: `Committed cost is ${pct}% of baseline`,
      };
    }
  } else if (facts.budget_exception) {
    reason = {
      code: "budget",
      band: "red",
      detail: "A cost line is over 110% of its baseline",
    };
  }
  if (!uncoded) return reason;
  if (!reason) {
    return { code: "budget", band: "yellow", detail: "hours not on a cost code" };
  }
  return { ...reason, detail: `${reason.detail}. Hours not on a cost code.` };
}

function fieldStartReason(facts: HealthFacts, today: string): HealthReason | null {
  const scheduled = facts.scheduled_start?.slice(0, 10) ?? null;
  const field = facts.field_start?.slice(0, 10) ?? null;
  if (scheduled && field && daysBetween(scheduled, field) > 7) {
    return {
      code: "field_start",
      band: "red",
      detail: `Field start is ${daysBetween(scheduled, field)} days after the logged start`,
    };
  }
  if (
    field &&
    field >= today &&
    field <= addDays(today, 7) &&
    facts.gate_2_status !== "approved"
  ) {
    return {
      code: "field_start",
      band: "yellow",
      detail: `Field start is ${field} and Gate 2 is not approved`,
    };
  }
  return null;
}

function complianceReason(facts: HealthFacts): HealthReason | null {
  if (facts.vendor_blocked) {
    return {
      code: "sub_compliance",
      band: "red",
      detail: "A vendor on this project is not schedulable",
    };
  }
  if (facts.vendor_expiring) {
    return {
      code: "sub_compliance",
      band: "yellow",
      detail: "A required document is inside its warn window",
    };
  }
  return null;
}

function preconReason(facts: HealthFacts): HealthReason | null {
  if (facts.precon_late > 0) {
    return {
      code: "precon",
      band: "red",
      detail: "A preconstruction task is more than 7 days overdue",
    };
  }
  if (facts.precon_overdue > 0) {
    return {
      code: "precon",
      band: "yellow",
      detail: "A preconstruction task is overdue",
    };
  }
  return null;
}

function drawsReason(facts: HealthFacts): HealthReason | null {
  const parts: string[] = [];
  if (facts.draws_approved_stale > 0) {
    parts.push(
      facts.draws_approved_stale === 1 && facts.draw_stale_label
        ? `${facts.draw_stale_label} approved ${facts.draw_stale_days ?? 0} days ago with no invoice number`
        : `${facts.draws_approved_stale} draws approved more than 7 days ago with no invoice number`,
    );
  }
  if (facts.draws_unpaid_stale > 0) {
    parts.push(
      facts.unpaid_invoice_number
        ? `Invoice ${facts.unpaid_invoice_number} has been unpaid for more than 30 days`
        : "A matched invoice has been unpaid for more than 30 days",
    );
  }
  if (parts.length > 0) {
    return { code: "draws", band: "red", detail: parts.join(". ") };
  }
  if (facts.draws_earned_stale > 0) {
    return {
      code: "draws",
      band: "yellow",
      detail: "A draw has been earned and not approved for 3 days",
    };
  }
  return null;
}

function closeoutReason(facts: HealthFacts): HealthReason | null {
  if (facts.closeout_open <= 0) return null;
  if (facts.stage === "closeout") {
    return { code: "closeout", band: "red", detail: "Closeout has open items" };
  }
  if (facts.stage === "execution" && facts.gate_3_status === "approved") {
    return {
      code: "closeout",
      band: "yellow",
      detail: "Gate 3 is approved and closeout still has open items",
    };
  }
  return null;
}

export function assessHealth(facts: HealthFacts, today: string): HealthScore {
  const reasons = [
    budgetReason(facts),
    fieldStartReason(facts, today),
    complianceReason(facts),
    preconReason(facts),
    drawsReason(facts),
    closeoutReason(facts),
  ].filter((reason): reason is HealthReason => reason !== null);
  const reds = reasons.filter((reason) => reason.band === "red").length;
  const yellows = reasons.filter((reason) => reason.band === "yellow").length;
  const band: HealthBand = reds > 0 ? "red" : yellows > 0 ? "yellow" : "green";
  return {
    score: Math.max(0, 100 - 20 * reds - 8 * yellows),
    band,
    reasons,
  };
}

function billingOf(under: number, over: number): BillingPosition {
  const underAmount = money(under);
  const overAmount = money(over);
  if (overAmount > 0) return { position: "over", amount: overAmount };
  if (underAmount > 0) return { position: "under", amount: underAmount };
  return { position: "even", amount: 0 };
}

function presentFacts(row: Record<string, unknown>, today: string): ProjectHealthRow {
  const facts: HealthFacts = {
    project_id: String(row.project_id),
    stage: String(row.stage),
    scheduled_start: text(row.scheduled_start),
    field_start: text(row.field_start),
    actual_end: text(row.actual_end),
    updated_on: text(row.updated_on),
    gate_2_status: text(row.gate_2_status),
    gate_3_status: text(row.gate_3_status),
    baseline: num(row.baseline),
    committed: num(row.committed),
    budget_exception: row.budget_exception === true,
    uncoded_hours: num(row.uncoded_hours),
    revised_contract: numOrNull(row.revised_contract),
    committed_cost: numOrNull(row.committed_cost),
    projected_cost: numOrNull(row.projected_cost),
    projected_margin_pct: numOrNull(row.projected_margin_pct),
    vendor_blocked: row.vendor_blocked === true,
    vendor_expiring: row.vendor_expiring === true,
    precon_overdue: num(row.precon_overdue),
    precon_late: num(row.precon_late),
    draws_approved_stale: num(row.draws_approved_stale),
    draw_stale_label: text(row.draw_stale_label),
    draw_stale_days: numOrNull(row.draw_stale_days),
    draws_unpaid_stale: num(row.draws_unpaid_stale),
    unpaid_invoice_number: text(row.unpaid_invoice_number),
    draws_earned_stale: num(row.draws_earned_stale),
    closeout_open: num(row.closeout_open),
    under_billed: num(row.under_billed),
    over_billed: num(row.over_billed),
  };
  return {
    project_id: facts.project_id,
    stage: facts.stage,
    actual_end: facts.actual_end,
    updated_on: facts.updated_on,
    projected_margin_pct: facts.projected_margin_pct,
    revised_contract: facts.revised_contract,
    committed_cost: facts.committed_cost,
    projected_cost: facts.projected_cost,
    billing: billingOf(facts.under_billed, facts.over_billed),
    health: assessHealth(facts, today),
  };
}

/** Live health for every project the tenant can see. `today` is a New York date. */
export async function loadProjectHealth(
  db: SqlClient,
  today: string,
): Promise<ProjectHealthRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(FACTS_SQL, [today]);
  return rows.map((row) => presentFacts(row, today));
}

export function feedHealth(row: ProjectHealthRow | undefined): {
  projected_margin_pct: number | null;
  billing: BillingPosition;
  health: HealthScore;
} {
  return {
    projected_margin_pct: row?.projected_margin_pct ?? null,
    billing: row?.billing ?? { position: "even", amount: 0 },
    health: row?.health ?? { score: 100, band: "green", reasons: [] },
  };
}

/**
 * Active projects are written every day the job runs.
 * A complete project is written on the day it reaches complete
 * (`actual_end`, or the New York date of `updated_at` when that date is empty
 * and no earlier snapshot exists). Cancelled projects are left out.
 */
export function includeInDailySnapshot(
  row: ProjectHealthRow,
  today: string,
  snapshottedBeforeToday: ReadonlySet<string>,
): boolean {
  if (row.stage === "cancelled") return false;
  if (row.stage !== "complete") return true;
  if (row.actual_end === today) return true;
  return (
    row.actual_end === null &&
    row.updated_on === today &&
    !snapshottedBeforeToday.has(row.project_id)
  );
}
