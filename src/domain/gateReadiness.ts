import type { SqlClient } from "../db/database.js";

/**
 * Shipped Gate 1 and Gate 2 checklist items.
 * `done` is a human tick. `ready` is computed beside it and never stored.
 */
export const GATE_1_CHECKLIST = [
  { key: "accepted_estimate", label: "accepted estimate on file" },
  { key: "scope", label: "scope of work on file" },
  { key: "budget_by_cost_code", label: "budget entered by cost code" },
  { key: "permit_need", label: "permit need decided" },
  { key: "subs", label: "subcontractors identified" },
  { key: "materials", label: "materials identified" },
  { key: "target_window", label: "target window set" },
] as const;

export const GATE_2_CHECKLIST = [
  { key: "field_start", label: "field start date set" },
  { key: "precon_clear", label: "preconstruction tasks done or waived" },
  { key: "permit_issued", label: "permit issued or not required" },
  { key: "subs_compliant", label: "awarded subs compliant" },
  { key: "materials_ordered", label: "material orders entered" },
  { key: "site_ready", label: "site access confirmed" },
] as const;

export const GATE_CHECKLISTS: Record<
  number,
  ReadonlyArray<{ key: string; label: string }>
> = {
  1: GATE_1_CHECKLIST,
  2: GATE_2_CHECKLIST,
};

/** Keys the screen can hint. site_ready is manual and stays false. */
export const HINTED_GATE_KEYS = [
  ...GATE_1_CHECKLIST.map((item) => item.key),
  ...GATE_2_CHECKLIST.map((item) => item.key),
] as const;

export type GateReadiness = Record<(typeof HINTED_GATE_KEYS)[number], boolean>;

/**
 * Live facts beside a tick. A true value does not mark the item done.
 * site_ready has no fact to read, so it is always false.
 * subs_compliant is true when every vendor on an issued purchase order is
 * schedulable, including when the project has no issued purchase order.
 * precon_clear is true when no precon task is still not_started or in_progress,
 * including when the project has no precon tasks.
 */
export async function gateReadiness(
  db: SqlClient,
  projectId: string,
): Promise<GateReadiness> {
  const { rows } = await db.query<Record<string, boolean | null>>(
    `SELECT
       (p.estimate_import_id IS NOT NULL OR p.contract_value > 0) AS accepted_estimate,
       EXISTS (
         SELECT 1 FROM projects.project_controls c
          WHERE c.project_id = p.id
            AND c.active
            AND c.kind = 'document'
            AND c.data->>'folder' = 'charter_scope'
       ) AS scope,
       EXISTS (
         SELECT 1 FROM projects.budget_lines b WHERE b.project_id = p.id
       ) AS budget_by_cost_code,
       (
         p.jurisdiction_id IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM projects.precon_tasks t
            WHERE t.project_id = p.id AND t.task_type = 'permit'
         )
         OR EXISTS (
           SELECT 1 FROM projects.permits pr
            WHERE pr.project_id = p.id AND pr.not_required
         )
       ) AS permit_need,
       (
         EXISTS (
           SELECT 1 FROM projects.schedule_items s
            WHERE s.project_id = p.id AND s.vendor_id IS NOT NULL
         )
         OR EXISTS (
           SELECT 1 FROM projects.bid_recipients r
             JOIN projects.bid_requests b ON b.id = r.request_id
            WHERE b.project_id = p.id
         )
         OR EXISTS (
           SELECT 1 FROM projects.purchase_orders po
            WHERE po.project_id = p.id
              AND po.kind = 'subcontract'
              AND po.vendor_id IS NOT NULL
         )
       ) AS subs,
       (
         EXISTS (
           SELECT 1 FROM projects.precon_tasks t
            WHERE t.project_id = p.id AND t.task_type = 'material_order'
         )
         OR EXISTS (
           SELECT 1 FROM projects.purchase_orders po
            WHERE po.project_id = p.id AND po.kind = 'material'
         )
       ) AS materials,
       (p.scheduled_end IS NOT NULL OR p.field_start IS NOT NULL) AS target_window,
       (p.field_start IS NOT NULL) AS field_start,
       NOT EXISTS (
         SELECT 1 FROM projects.precon_tasks t
          WHERE t.project_id = p.id
            AND t.status IN ('not_started', 'in_progress')
       ) AS precon_clear,
       (
         EXISTS (
           SELECT 1 FROM projects.permits pr
            WHERE pr.project_id = p.id AND pr.issued_on IS NOT NULL
         )
         OR EXISTS (
           SELECT 1 FROM projects.permits pr
            WHERE pr.project_id = p.id AND pr.not_required
         )
       ) AS permit_issued,
       NOT EXISTS (
         SELECT 1 FROM projects.purchase_orders po
           LEFT JOIN projects.v_vendor_eligibility e ON e.vendor_id = po.vendor_id
          WHERE po.project_id = p.id
            AND po.status IN ('issued', 'partially_billed', 'closed')
            AND po.vendor_id IS NOT NULL
            AND e.schedulable IS DISTINCT FROM true
       ) AS subs_compliant,
       EXISTS (
         SELECT 1 FROM projects.purchase_orders po
          WHERE po.project_id = p.id AND po.kind = 'material'
       ) AS materials_ordered
     FROM projects.projects p
    WHERE p.id = $1`,
    [projectId],
  );
  const row = rows[0] ?? {};
  const flag = (key: string) => row[key] === true;
  return {
    accepted_estimate: flag("accepted_estimate"),
    scope: flag("scope"),
    budget_by_cost_code: flag("budget_by_cost_code"),
    permit_need: flag("permit_need"),
    subs: flag("subs"),
    materials: flag("materials"),
    target_window: flag("target_window"),
    field_start: flag("field_start"),
    precon_clear: flag("precon_clear"),
    permit_issued: flag("permit_issued"),
    subs_compliant: flag("subs_compliant"),
    materials_ordered: flag("materials_ordered"),
    site_ready: false,
  };
}

/** Portfolio list columns. `alias` is a query alias we wrote, never request input. */
export function portfolioGateColumns(alias = "p"): string {
  return `(SELECT g.status::text FROM projects.stage_gates g
            WHERE g.project_id = ${alias}.id AND g.gate_number = 1) AS gate_1_status,
          (SELECT g.status::text FROM projects.stage_gates g
            WHERE g.project_id = ${alias}.id AND g.gate_number = 2) AS gate_2_status`;
}

export function presentPortfolioGates(row: Record<string, unknown>): {
  gate_1: string | null;
  gate_2: string | null;
} {
  return {
    gate_1: typeof row.gate_1_status === "string" ? row.gate_1_status : null,
    gate_2: typeof row.gate_2_status === "string" ? row.gate_2_status : null,
  };
}
