import { roundMoney } from "./poMath.js";

/**
 * Display-only threshold for actual cost against budget.
 * Warning at 80%, over budget at 100%. Nothing here sends mail, text, or
 * any other notification, and nothing here calls another system.
 */
export type BudgetAlert = "none" | "warning" | "over_budget" | "no_budget";

export interface BudgetAlertResult {
  budget_alert: BudgetAlert;
  /** One decimal. Null when no positive budget is set, so 0/0 is not 100%. */
  actual_to_budget_pct: number | null;
}

export function budgetAlert(
  actualCost: number,
  budgetAmount: number,
): BudgetAlertResult {
  const budget = roundMoney(budgetAmount);
  const actual = roundMoney(actualCost);
  if (!(budget > 0)) {
    return { budget_alert: "no_budget", actual_to_budget_pct: null };
  }
  const actualCents = Math.round(actual * 100);
  const budgetCents = Math.round(budget * 100);
  const actual_to_budget_pct =
    Math.round((actualCents / budgetCents) * 1000) / 10;
  if (actualCents >= budgetCents) {
    return { budget_alert: "over_budget", actual_to_budget_pct };
  }
  // 80% in integer cents: actual/budget >= 4/5.
  if (actualCents * 5 >= budgetCents * 4) {
    return { budget_alert: "warning", actual_to_budget_pct };
  }
  return { budget_alert: "none", actual_to_budget_pct };
}
