/**
 * The project budget is projects.contract_value, projects.budgeted_labor_hours,
 * and the sum of projects.budget_lines by cost type. JP.BUDGET is the line the
 * Financials form adjusts so a typed category total matches that sum. Cost-code
 * lines are the same rows. Nothing here writes to ServiceTitan.
 */

import type { SqlClient } from "../db/database.js";
import { ApiError } from "../http/errors.js";
import type { DashboardBudget } from "./financialsDashboard.js";
import { roundMoney } from "./projectFinancials.js";

export const BUDGET_CODE = "JP.BUDGET";

const CATEGORIES = [
  { key: "labor", type: "L", label: "Labor" },
  { key: "materials", type: "M", label: "Materials" },
  { key: "subcontractor", type: "S", label: "Subcontractor" },
  { key: "other", type: "O", label: "Other" },
] as const;

export type BudgetCategoryKey = (typeof CATEGORIES)[number]["key"];

export interface BudgetAmountRow {
  costType: string;
  amount: number;
  count: number;
}

export interface BudgetEntry {
  contract_value: number | null;
  labor_hours: number | null;
  labor: number | null;
  materials: number | null;
  subcontractor: number | null;
  other: number | null;
  total: number | null;
  entered: boolean;
  summary_code: typeof BUDGET_CODE;
}

export type SummaryLineDecision =
  | { action: "delete" }
  | { action: "upsert"; amount: number }
  | { action: "reject"; otherLines: number };

function num(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function enteredTotal(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value != null);
  if (present.length === 0) return null;
  return roundMoney(present.reduce((sum, value) => sum + value, 0));
}

/** A cost type with no rows is null. A row of zero is a real zero. */
export function budgetFromSums(input: {
  contractValue: number | null;
  laborHours: number | null;
  rows: BudgetAmountRow[];
}): DashboardBudget {
  const byType = (type: string): number | null => {
    const row = input.rows.find((item) => item.costType === type && item.count > 0);
    if (!row || !Number.isFinite(row.amount)) return null;
    return roundMoney(row.amount);
  };
  const labor = byType("L");
  const materials = byType("M");
  const subcontractor = byType("S");
  const other = byType("O");
  const totalBudgetedExpense = enteredTotal([labor, materials, subcontractor, other]);
  const contractValue = input.contractValue == null ? null : roundMoney(input.contractValue);
  const laborHours = input.laborHours == null ? null : roundMoney(input.laborHours);
  return {
    entered: contractValue != null || laborHours != null || totalBudgetedExpense != null,
    contractValue,
    laborHours,
    labor,
    materials,
    subcontractor,
    other,
    totalBudgetedExpense,
  };
}

export function toBudgetEntry(budget: DashboardBudget): BudgetEntry {
  return {
    contract_value: budget.contractValue,
    labor_hours: budget.laborHours,
    labor: budget.labor,
    materials: budget.materials,
    subcontractor: budget.subcontractor,
    other: budget.other,
    total: budget.totalBudgetedExpense,
    entered: budget.entered,
    summary_code: BUDGET_CODE,
  };
}

/**
 * The form sets a category total. The JP.BUDGET line is the difference between
 * that total and the other cost codes of the same type. A blank field deletes
 * only that summary line. A total below the other codes is rejected.
 */
export function summaryLineAmount(desired: number | null, otherLines: number): SummaryLineDecision {
  if (desired == null) return { action: "delete" };
  const others = roundMoney(otherLines);
  const amount = roundMoney(desired - others);
  if (amount < 0) return { action: "reject", otherLines: others };
  if (amount === 0 && others > 0) return { action: "delete" };
  return { action: "upsert", amount };
}

export async function loadBudget(db: SqlClient, projectId: string): Promise<DashboardBudget> {
  const project = await db.query<{ contract_value: string | null; hours: string | null }>(
    `SELECT contract_value::text, budgeted_labor_hours::text AS hours
       FROM projects.projects
      WHERE id = $1`,
    [projectId],
  );
  const sums = await db.query<{ cost_type: string; amount: string; n: string }>(
    `SELECT cost_type::text AS cost_type,
            SUM(budget_amount)::text AS amount,
            COUNT(*)::text AS n
       FROM projects.budget_lines
      WHERE project_id = $1
      GROUP BY cost_type`,
    [projectId],
  );
  return budgetFromSums({
    contractValue: num(project.rows[0]?.contract_value),
    laborHours: num(project.rows[0]?.hours),
    rows: sums.rows.map((row) => ({
      costType: row.cost_type,
      amount: Number(row.amount),
      count: Number(row.n),
    })),
  });
}

export async function readBudgetEntry(db: SqlClient, projectId: string): Promise<BudgetEntry> {
  return toBudgetEntry(await loadBudget(db, projectId));
}

export interface BudgetEntryWrite {
  tenantId: string;
  projectId: string;
  contractValue: number | null;
  laborHours: number | null;
  labor: number | null;
  materials: number | null;
  subcontractor: number | null;
  other: number | null;
}

export async function saveBudgetEntry(db: SqlClient, input: BudgetEntryWrite): Promise<BudgetEntry> {
  const code = await db.query<{ id: string }>(
    `SELECT id FROM projects.cost_codes WHERE code = $1 AND active LIMIT 1`,
    [BUDGET_CODE],
  );
  const costCodeId = code.rows[0]?.id;
  if (!costCodeId) {
    throw new ApiError("conflict", "The project budget cost code is not on this company yet.");
  }

  const desired: Record<BudgetCategoryKey, number | null> = {
    labor: input.labor == null ? null : roundMoney(input.labor),
    materials: input.materials == null ? null : roundMoney(input.materials),
    subcontractor: input.subcontractor == null ? null : roundMoney(input.subcontractor),
    other: input.other == null ? null : roundMoney(input.other),
  };

  for (const category of CATEGORIES) {
    const others = await db.query<{ amount: string }>(
      `SELECT COALESCE(SUM(budget_amount), 0)::text AS amount
         FROM projects.budget_lines
        WHERE project_id = $1
          AND cost_type = $2::projects.cost_type
          AND cost_code_id <> $3`,
      [input.projectId, category.type, costCodeId],
    );
    const decision = summaryLineAmount(desired[category.key], Number(others.rows[0]?.amount ?? 0));
    if (decision.action === "reject") {
      throw new ApiError(
        "conflict",
        `${category.label} is already $${decision.otherLines.toFixed(2)} on other cost codes, which is more than the total entered.`,
      );
    }
    if (decision.action === "delete") {
      await db.query(
        `DELETE FROM projects.budget_lines
          WHERE project_id = $1 AND cost_code_id = $2 AND cost_type = $3::projects.cost_type`,
        [input.projectId, costCodeId, category.type],
      );
      continue;
    }
    await db.query(
      `INSERT INTO projects.budget_lines
         (tenant_id, project_id, cost_code_id, cost_type, budget_amount, note)
       VALUES ($1,$2,$3,$4::projects.cost_type,$5,'Project budget')
       ON CONFLICT (project_id, cost_code_id, cost_type)
       DO UPDATE SET budget_amount = EXCLUDED.budget_amount, note = EXCLUDED.note`,
      [input.tenantId, input.projectId, costCodeId, category.type, decision.amount],
    );
  }

  await db.query(
    `UPDATE projects.projects
        SET contract_value = $2,
            budgeted_labor_hours = $3,
            updated_at = now()
      WHERE id = $1`,
    [
      input.projectId,
      input.contractValue == null ? null : roundMoney(input.contractValue),
      input.laborHours == null ? null : roundMoney(input.laborHours),
    ],
  );

  return readBudgetEntry(db, input.projectId);
}
