/**
 * ServiceTitan Project Financials summary tiles.
 * Actual revenue and actual expense come from the figures already on the
 * Financials page. Contract, budget, change orders, retainage, and open
 * invoices come from a ServiceTitan read. A missing figure stays null.
 * Nothing here invents a number, and nothing writes to ServiceTitan.
 */

import { roundMoney } from "./projectFinancials.js";

export type FigureSource = "servicetitan" | "actuals" | "computed" | "missing";

export interface Figure {
  value: number | null;
  source: FigureSource;
}

export interface DashboardActuals {
  /** Invoice lines, material expenses, labor, or a stored reconciliation exist. */
  observed: boolean;
  /** Classified billed, including lines that are neither labor nor material. This is actual revenue. */
  billed: number;
  laborBurden: number;
  /** Null when purchase-order cost was not returned. Zero is a real zero. */
  materialsExpense: number | null;
  /** Null when materials expense was not returned. Labor alone is not the total. */
  expenses: number | null;
}

export interface DashboardServiceTitan {
  estimatesRead: boolean;
  contractValue: number | null;
  totalBudgetedExpense: number | null;
  changeOrders: number | null;
  costAdjustments: number | null;
  budgetedLaborExpense: number | null;
  budgetedLaborHours: number | null;
  budgetedMaterials: number | null;
  invoicesRead: boolean;
  /** Invoice header totals. Distinct from classified actual revenue. */
  billed: number | null;
  openInvoices: number | null;
  retainage: number | null;
}

export interface FinancialsDashboard {
  contractValue: Figure;
  actualRevenue: Figure;
  totalBudgetedExpense: Figure;
  costToComplete: Figure;
  changeOrders: Figure;
  costAdjustments: Figure;
  actualExpense: Figure;
  materialsExpense: Figure;
  laborExpense: Figure;
  budgetedMaterials: Figure;
  budgetedLaborExpense: Figure;
  actualMargin: Figure;
  actualMarginPercent: Figure;
  billed: Figure;
  budgetedMargin: Figure;
  budgetedMarginPercent: Figure;
  earnedRevenue: Figure;
  percentOfWorkCompleted: Figure;
  retainage: Figure;
  openInvoices: Figure;
  budgetedLaborHours: Figure;
}

export const MISSING_FIGURE_TOOLTIP =
  "ServiceTitan did not return this figure. Nothing is estimated.";

const missing = (): Figure => ({ value: null, source: "missing" });

function reported(
  value: number | null | undefined,
  source: "servicetitan" | "actuals",
): Figure {
  if (value == null || !Number.isFinite(value)) return missing();
  return { value: roundMoney(value), source };
}

function computed(value: number | null): Figure {
  if (value == null || !Number.isFinite(value)) return missing();
  return { value: roundMoney(value), source: "computed" };
}

/** Margin and completion percents, two decimal places. Null when the base is not positive. */
export function percentOf(part: number, whole: number): number | null {
  if (!(whole > 0) || !Number.isFinite(part)) return null;
  return Math.round((part / whole) * 10000) / 100;
}

/**
 * Cost to complete is total budgeted expense minus actual expense.
 * The result may be negative when the project is already over budget.
 */
export function costToComplete(budget: number, actualExpense: number): number {
  return roundMoney(budget - actualExpense);
}

/**
 * Earned revenue is contract value times actual expense over total budgeted expense.
 * Percent complete is that same ratio. A zero budget does not produce a percent.
 */
export function earnedRevenue(contract: number, actualExpense: number, budget: number): number | null {
  if (!(budget > 0)) return null;
  return roundMoney(contract * (actualExpense / budget));
}

export function buildFinancialsDashboard(input: {
  actuals: DashboardActuals | null;
  serviceTitan: DashboardServiceTitan | null;
}): FinancialsDashboard {
  const actuals = input.actuals?.observed ? input.actuals : null;
  const st = input.serviceTitan;
  const estimates = st?.estimatesRead ? st : null;
  const invoices = st?.invoicesRead ? st : null;

  const actualRevenue = actuals ? reported(actuals.billed, "actuals") : missing();
  const actualExpense =
    actuals && actuals.expenses != null ? reported(actuals.expenses, "actuals") : missing();
  const materialsExpense =
    actuals && actuals.materialsExpense != null
      ? reported(actuals.materialsExpense, "actuals")
      : missing();
  const laborExpense = actuals ? reported(actuals.laborBurden, "actuals") : missing();

  const contractValue = estimates ? reported(estimates.contractValue, "servicetitan") : missing();
  const totalBudgetedExpense = estimates
    ? reported(estimates.totalBudgetedExpense, "servicetitan")
    : missing();
  const changeOrders = estimates ? reported(estimates.changeOrders, "servicetitan") : missing();
  const costAdjustments = estimates ? reported(estimates.costAdjustments, "servicetitan") : missing();
  const budgetedLaborExpense = estimates
    ? reported(estimates.budgetedLaborExpense, "servicetitan")
    : missing();
  const budgetedLaborHours = estimates
    ? reported(estimates.budgetedLaborHours, "servicetitan")
    : missing();
  const budgetedMaterials = estimates ? reported(estimates.budgetedMaterials, "servicetitan") : missing();
  const billed = invoices ? reported(invoices.billed, "servicetitan") : missing();
  const openInvoices = invoices ? reported(invoices.openInvoices, "servicetitan") : missing();
  const retainage = st && st.retainage != null ? reported(st.retainage, "servicetitan") : missing();

  const marginDollars =
    actualRevenue.value != null && actualExpense.value != null
      ? roundMoney(actualRevenue.value - actualExpense.value)
      : null;
  const budgetMarginDollars =
    contractValue.value != null && totalBudgetedExpense.value != null
      ? roundMoney(contractValue.value - totalBudgetedExpense.value)
      : null;

  return {
    contractValue,
    actualRevenue,
    totalBudgetedExpense,
    costToComplete:
      totalBudgetedExpense.value != null && actualExpense.value != null
        ? computed(costToComplete(totalBudgetedExpense.value, actualExpense.value))
        : missing(),
    changeOrders,
    costAdjustments,
    actualExpense,
    materialsExpense,
    laborExpense,
    budgetedMaterials,
    budgetedLaborExpense,
    actualMargin: computed(marginDollars),
    actualMarginPercent: computed(
      marginDollars != null && actualRevenue.value != null
        ? percentOf(marginDollars, actualRevenue.value)
        : null,
    ),
    billed,
    budgetedMargin: computed(budgetMarginDollars),
    budgetedMarginPercent: computed(
      budgetMarginDollars != null && contractValue.value != null
        ? percentOf(budgetMarginDollars, contractValue.value)
        : null,
    ),
    earnedRevenue: computed(
      contractValue.value != null &&
        actualExpense.value != null &&
        totalBudgetedExpense.value != null
        ? earnedRevenue(contractValue.value, actualExpense.value, totalBudgetedExpense.value)
        : null,
    ),
    percentOfWorkCompleted: computed(
      actualExpense.value != null && totalBudgetedExpense.value != null
        ? percentOf(actualExpense.value, totalBudgetedExpense.value)
        : null,
    ),
    retainage,
    openInvoices,
    budgetedLaborHours,
  };
}
