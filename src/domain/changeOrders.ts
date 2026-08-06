import type { SqlClient } from '../db/database.js';

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
