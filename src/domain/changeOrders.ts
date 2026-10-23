import type { SqlClient } from '../db/database.js';
import { ApiError } from '../http/errors.js';
import { assertSubcontractCompliance } from './vendorCompliance.js';

/**
 * What approving a change order does to the project.
 *
 * §3.5 says approval "updates budget and schedule impact". Three effects, and
 * the first is the one that matters:
 *
 * 1. REVENUE is already handled by the schema. v_project_margin computes
 *    revised_contract as contract_value plus the customer_amount of every
 *    approved change order, so nothing here touches it. Adding to
 *    contract_value as well would double-count it — which is the obvious
 *    mistake, and the reason this comment exists.
 *
 * 2. COST moves the budget, INCLUDING the baseline, and including when the
 *    baseline is frozen. This is the only sanctioned way past the freeze:
 *    editing a budget line after the freeze gate returns baseline_frozen with
 *    the message "changes after the freeze belong on a change order", and this
 *    is what makes that sentence true rather than a dead end.
 *
 *    Both budget_amount and baseline_amount move, by the same amount. Moving
 *    only the budget would leave the line reading as an overrun against its
 *    original baseline forever; moving only the baseline would hide real
 *    spend. An approved change order is agreed scope, so the plan it is
 *    measured against has to move with it.
 *
 * 3. SCHEDULE impact pushes scheduled_end out by schedule_impact_days. Only
 *    scheduled_end — actual dates are a record of what happened and a change
 *    order does not rewrite history.
 */

export interface ChangeOrderEffect {
  budgetLinesCreated: number;
  budgetLinesUpdated: number;
  scheduleEndMovedTo: string | null;
}

export async function applyApprovedChangeOrder(
  db: SqlClient,
  tenantId: string,
  projectId: string,
  changeOrderId: string,
): Promise<ChangeOrderEffect> {
  const lines = await db.query<{
    cost_code_id: string;
    cost_type: string;
    amount: string;
    description: string | null;
  }>(
    `SELECT cost_code_id, cost_type::text AS cost_type, amount, description
       FROM projects.change_order_lines WHERE change_order_id = $1`,
    [changeOrderId],
  );

  let created = 0;
  let updated = 0;

  for (const line of lines.rows) {
    // One statement, so a concurrent approval of a second change order against
    // the same code cannot read-modify-write over the top of this one. The
    // COALESCE on baseline_amount matters: a line that was never frozen has a
    // null baseline, and null + anything is null, which would silently erase
    // the baseline the freeze had not yet set.
    const result = await db.query<{ created: boolean }>(
      `INSERT INTO projects.budget_lines
         (tenant_id, project_id, cost_code_id, cost_type, budget_amount, baseline_amount, note)
       VALUES ($1, $2, $3, $4::projects.cost_type, $5, $5, $6)
       ON CONFLICT (project_id, cost_code_id, cost_type) DO UPDATE
         SET budget_amount = projects.budget_lines.budget_amount + EXCLUDED.budget_amount,
             baseline_amount = CASE
               WHEN projects.budget_lines.baseline_amount IS NULL THEN NULL
               ELSE projects.budget_lines.baseline_amount + EXCLUDED.budget_amount
             END
       RETURNING (xmax = 0) AS created`,
      [
        tenantId,
        projectId,
        line.cost_code_id,
        line.cost_type,
        Number(line.amount),
        line.description ?? 'Change order',
      ],
    );
    if (result.rows[0]?.created) created++;
    else updated++;
  }

  const schedule = await db.query<{ scheduled_end: string | null }>(
    `UPDATE projects.projects
        SET scheduled_end = CASE
          WHEN scheduled_end IS NULL THEN NULL
          ELSE scheduled_end + (
            SELECT schedule_impact_days FROM projects.change_orders WHERE id = $2
          )
        END
      WHERE id = $1
      RETURNING scheduled_end`,
    [projectId, changeOrderId],
  );

  return {
    budgetLinesCreated: created,
    budgetLinesUpdated: updated,
    scheduleEndMovedTo: schedule.rows[0]?.scheduled_end ?? null,
  };
}

export interface PurchaseOrderLineEffect {
  linesApplied: number;
  linesAlreadyApplied: number;
}

/**
 * Copy change-order lines that name a purchase order onto that order.
 *
 * Match an existing PO line on cost code and cost type. Otherwise add a line
 * whose original amount stays 0 and whose change amount is this line. The
 * po_line_changes unique key makes a repeated approval add the money once.
 * Budget application is separate and must not run again.
 */
export async function applyChangeOrderToPurchaseOrders(
  db: SqlClient,
  tenantId: string,
  projectId: string,
  changeOrderId: string,
  staffId: string,
): Promise<PurchaseOrderLineEffect> {
  const lines = await db.query<{
    id: string;
    po_id: string;
    cost_code_id: string;
    cost_type: string;
    amount: string;
    description: string | null;
  }>(
    `SELECT id, po_id, cost_code_id, cost_type::text AS cost_type, amount::text AS amount, description
       FROM projects.change_order_lines
      WHERE change_order_id = $1 AND po_id IS NOT NULL`,
    [changeOrderId],
  );

  let applied = 0;
  let already = 0;
  for (const line of lines.rows) {
    const po = await db.query<{
      id: string;
      project_id: string;
      status: string;
      kind: string;
      vendor_id: string | null;
    }>(
      `SELECT id, project_id, status::text AS status, kind::text AS kind, vendor_id
         FROM projects.purchase_orders WHERE id = $1`,
      [line.po_id],
    );
    const order = po.rows[0];
    if (!order || order.project_id !== projectId) {
      throw new ApiError('conflict', 'That purchase order is not on this project.');
    }
    if (order.status === 'void') {
      throw new ApiError('conflict', 'A void purchase order cannot take a change order.');
    }
    const amount = Number(line.amount);
    const existingChange = await db.query<{ id: string }>(
      `SELECT id FROM projects.po_line_changes WHERE change_order_line_id = $1`,
      [line.id],
    );
    if (
      existingChange.rows.length === 0 &&
      ['issued', 'partially_billed', 'closed'].includes(order.status)
    ) {
      await assertSubcontractCompliance(db, order, 'issue');
    }

    let poLineId = (
      await db.query<{ id: string; current_amount: string }>(
        `SELECT id, current_amount::text AS current_amount
           FROM projects.po_lines
          WHERE po_id = $1 AND cost_code_id = $2 AND cost_type = $3::projects.cost_type
          ORDER BY line_no
          LIMIT 1`,
        [line.po_id, line.cost_code_id, line.cost_type],
      )
    ).rows[0];

    if (!poLineId) {
      if (amount < 0) {
        throw new ApiError(
          'conflict',
          'A new purchase order line cannot start from a negative change.',
        );
      }
      const next = await db.query<{ n: string }>(
        `SELECT COALESCE(MAX(line_no), 0)::text AS n FROM projects.po_lines WHERE po_id = $1`,
        [line.po_id],
      );
      const inserted = await db.query<{ id: string; current_amount: string }>(
        `INSERT INTO projects.po_lines
           (tenant_id, po_id, line_no, cost_code_id, cost_type, description, original_amount)
         VALUES ($1,$2,$3,$4,$5::projects.cost_type,$6,0)
         RETURNING id, current_amount::text AS current_amount`,
        [
          tenantId,
          line.po_id,
          Number(next.rows[0]?.n ?? 0) + 1,
          line.cost_code_id,
          line.cost_type,
          line.description ?? '',
        ],
      );
      poLineId = inserted.rows[0];
    }

    const current = Number(poLineId?.current_amount ?? 0);
    if (existingChange.rows.length === 0 && current + amount < -0.001) {
      throw new ApiError(
        'conflict',
        'That change would take the purchase order line below zero.',
      );
    }

    const inserted = await db.query<{ id: string }>(
      `INSERT INTO projects.po_line_changes
         (tenant_id, po_line_id, change_order_line_id, amount, applied_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (po_line_id, change_order_line_id) DO NOTHING
       RETURNING id`,
      [tenantId, poLineId!.id, line.id, amount, staffId],
    );
    if (inserted.rows.length) applied++;
    else already++;
  }

  return { linesApplied: applied, linesAlreadyApplied: already };
}
