/**
 * Portfolio fields for the change-order log and the closeout record.
 * Counts and hints are computed. Nothing here is stored a second time.
 */

export interface PortfolioChangeOrders {
  open: number;
  unpriced: number;
  not_in_servicetitan: number;
  unsigned: number;
}

export interface PortfolioCloseout {
  open_items: number;
  warranty_start: string | null;
  review_request_recorded: boolean;
}

/** `alias` is a query alias we wrote, never request input. */
export function portfolioChangeOrderColumns(alias = "p"): string {
  const open = `co.project_id = ${alias}.id AND co.status IN ('draft', 'sent')`;
  return `(SELECT count(*)::int FROM projects.change_orders co WHERE ${open}) AS co_open,
          (SELECT count(*)::int FROM projects.change_orders co
            WHERE ${open} AND co.priced_at IS NULL) AS co_unpriced,
          (SELECT count(*)::int FROM projects.change_orders co
            WHERE ${open} AND co.entered_st_at IS NULL) AS co_not_in_st,
          (SELECT count(*)::int FROM projects.change_orders co
            WHERE ${open} AND co.signed_at IS NULL) AS co_unsigned`;
}

/** `alias` is a query alias we wrote, never request input. */
export function portfolioCloseoutColumns(alias = "p"): string {
  return `(SELECT g.status::text FROM projects.stage_gates g
            WHERE g.project_id = ${alias}.id AND g.gate_number = 4) AS gate_4_status,
          COALESCE((
            SELECT bool_or((item->>'done') = 'true')
              FROM projects.stage_gates g
              CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(g.checklist) = 'array' THEN g.checklist ELSE '[]'::jsonb END
              ) AS item
             WHERE g.project_id = ${alias}.id AND g.gate_number = 4
          ), false) AS gate_4_progress,
          (SELECT c.punch_done_at IS NOT NULL
             FROM projects.project_closeout c
            WHERE c.project_id = ${alias}.id) AS closeout_punch,
          (SELECT c.photos_done_at IS NOT NULL
             FROM projects.project_closeout c
            WHERE c.project_id = ${alias}.id) AS closeout_photos,
          (
            EXISTS (
              SELECT 1 FROM projects.project_closeout c
               WHERE c.project_id = ${alias}.id
                 AND NULLIF(btrim(c.final_draw_invoice_number), '') IS NOT NULL
            )
            OR EXISTS (
              SELECT 1 FROM projects.draws d
               WHERE d.project_id = ${alias}.id
                 AND d.is_retainage
                 AND (
                   NULLIF(btrim(d.external_invoice_number), '') IS NOT NULL
                   OR d.external_invoice_verified_at IS NOT NULL
                 )
            )
          ) AS closeout_final_draw,
          (SELECT c.warranty_start_on::text
             FROM projects.project_closeout c
            WHERE c.project_id = ${alias}.id) AS closeout_warranty_start,
          (SELECT NULLIF(btrim(c.review_request_note), '') IS NOT NULL
             FROM projects.project_closeout c
            WHERE c.project_id = ${alias}.id) AS closeout_review`;
}

export const PORTFOLIO_LOG_KEYS = [
  "co_open",
  "co_unpriced",
  "co_not_in_st",
  "co_unsigned",
  "gate_4_status",
  "gate_4_progress",
  "closeout_punch",
  "closeout_photos",
  "closeout_final_draw",
  "closeout_warranty_start",
  "closeout_review",
] as const;

export function presentPortfolioChangeOrders(
  row: Record<string, unknown>,
): PortfolioChangeOrders {
  return {
    open: Number(row.co_open ?? 0),
    unpriced: Number(row.co_unpriced ?? 0),
    not_in_servicetitan: Number(row.co_not_in_st ?? 0),
    unsigned: Number(row.co_unsigned ?? 0),
  };
}

/**
 * Null until the project is in closeout or Gate 4 has any progress
 * (status other than open, or any checklist item ticked).
 * open_items counts the five closeout facts that are not ready yet.
 */
export function presentPortfolioCloseout(
  row: Record<string, unknown>,
): PortfolioCloseout | null {
  const stage = row.stage;
  const gateStatus = row.gate_4_status;
  const progressed =
    stage === "closeout" ||
    (typeof gateStatus === "string" && gateStatus !== "open") ||
    row.gate_4_progress === true;
  if (!progressed) return null;
  const warranty =
    typeof row.closeout_warranty_start === "string" && row.closeout_warranty_start
      ? row.closeout_warranty_start
      : null;
  const ready = [
    row.closeout_punch === true,
    row.closeout_photos === true,
    row.closeout_final_draw === true,
    warranty !== null,
    row.closeout_review === true,
  ];
  return {
    open_items: ready.filter((item) => !item).length,
    warranty_start: warranty,
    review_request_recorded: row.closeout_review === true,
  };
}
