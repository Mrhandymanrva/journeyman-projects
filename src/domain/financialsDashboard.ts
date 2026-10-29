/**
 * Project financials summary tiles.
 * Budget tiles come from the Journeyman budget. Actuals, billed, open
 * invoices, retainage, change orders, and cost adjustments stay on the
 * ServiceTitan read. A missing figure stays null. Nothing here invents a
 * number, and nothing writes to ServiceTitan.
 */

import { roundMoney } from "./projectFinancials.js";

export type FigureSource = "journeyman" | "servicetitan" | "actuals" | "computed" | "missing";

export type FigureGap = "budget" | "computed" | "servicetitan";

export interface Figure {
  value: number | null;
  source: FigureSource;
  /** Why a missing figure is blank. Omitted when the figure has a value. */
  gap?: FigureGap;
}

export interface DashboardActuals {
  /** Invoice lines, material expenses, labor, or a stored reconciliation exist. */
  observed: boolean;
  /** Classified billed, including lines that are neither labor nor material. This is actual revenue. */
  billed: number;
  laborBurden: number;
  /** Null when purchase-order cost was not returned. Zero is a real zero. */
  materialsExpense: number | null;
  /**
   * Qualifying subcontract vendor bills. Zero when none have been recorded.
   * Null only when actuals were not observed.
   */
  subcontractorExpense?: number | null;
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

/** Category dollars are sums of budget lines. A missing category is null, not zero. */
export interface DashboardBudget {
  entered: boolean;
  contractValue: number | null;
  laborHours: number | null;
  labor: number | null;
  materials: number | null;
  subcontractor: number | null;
  other: number | null;
  totalBudgetedExpense: number | null;
}

/** Read-only ServiceTitan sold estimate. Never the tile value. */
export interface SoldEstimateReference {
  contractValue: number | null;
  totalBudgetedExpense: number | null;
  budgetedLaborExpense: number | null;
  budgetedLaborHours: number | null;
  budgetedMaterials: number | null;
}

export interface FinancialsDashboard {
  budgetEntered: boolean;
  soldEstimate: SoldEstimateReference | null;
  contractValue: Figure;
  actualRevenue: Figure;
  totalBudgetedExpense: Figure;
  costToComplete: Figure;
  changeOrders: Figure;
  costAdjustments: Figure;
  actualExpense: Figure;
  materialsExpense: Figure;
  subcontractorExpense: Figure;
  laborExpense: Figure;
  budgetedMaterials: Figure;
  budgetedSubcontractor: Figure;
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

const missing = (gap: FigureGap = "servicetitan"): Figure => ({
  value: null,
  source: "missing",
  gap,
});

function reported(
  value: number | null | undefined,
  source: "servicetitan" | "actuals",
): Figure {
  if (value == null || !Number.isFinite(value)) return missing("servicetitan");
  return { value: roundMoney(value), source };
}

function computed(value: number | null, gap: FigureGap = "computed"): Figure {
  if (value == null || !Number.isFinite(value)) return missing(gap);
  return { value: roundMoney(value), source: "computed" };
}

function budgeted(value: number | null | undefined): Figure {
  if (value == null || !Number.isFinite(value)) return missing("budget");
  return { value: roundMoney(value), source: "journeyman" };
}

function finiteMoney(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return roundMoney(value);
}

function readSoldEstimate(
  serviceTitan: DashboardServiceTitan | null | undefined,
): SoldEstimateReference | null {
  if (!serviceTitan?.estimatesRead) return null;
  const ref: SoldEstimateReference = {
    contractValue: finiteMoney(serviceTitan.contractValue),
    totalBudgetedExpense: finiteMoney(serviceTitan.totalBudgetedExpense),
    budgetedLaborExpense: finiteMoney(serviceTitan.budgetedLaborExpense),
    budgetedLaborHours: finiteMoney(serviceTitan.budgetedLaborHours),
    budgetedMaterials: finiteMoney(serviceTitan.budgetedMaterials),
  };
  if (
    ref.contractValue == null &&
    ref.totalBudgetedExpense == null &&
    ref.budgetedLaborExpense == null &&
    ref.budgetedLaborHours == null &&
    ref.budgetedMaterials == null
  ) {
    return null;
  }
  return ref;
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
  budget?: DashboardBudget | null;
}): FinancialsDashboard {
  const actuals = input.actuals?.observed ? input.actuals : null;
  const st = input.serviceTitan;
  const estimates = st?.estimatesRead ? st : null;
  const invoices = st?.invoicesRead ? st : null;
  const budget = input.budget?.entered ? input.budget : null;

  const actualRevenue = actuals ? reported(actuals.billed, "actuals") : missing();
  const actualExpense =
    actuals && actuals.expenses != null ? reported(actuals.expenses, "actuals") : missing();
  const materialsExpense =
    actuals && actuals.materialsExpense != null
      ? reported(actuals.materialsExpense, "actuals")
      : missing();
  const subcontractorExpense =
    actuals && actuals.observed && actuals.subcontractorExpense != null
      ? reported(actuals.subcontractorExpense, "actuals")
      : missing();
  const laborExpense = actuals ? reported(actuals.laborBurden, "actuals") : missing();

  const contractValue = budgeted(budget ? budget.contractValue : null);
  const totalBudgetedExpense = budgeted(budget ? budget.totalBudgetedExpense : null);
  const changeOrders = estimates ? reported(estimates.changeOrders, "servicetitan") : missing();
  const costAdjustments = estimates ? reported(estimates.costAdjustments, "servicetitan") : missing();
  const budgetedLaborExpense = budgeted(budget ? budget.labor : null);
  const budgetedLaborHours = budgeted(budget ? budget.laborHours : null);
  const budgetedMaterials = budgeted(budget ? budget.materials : null);
  const budgetedSubcontractor = budgeted(budget ? budget.subcontractor : null);
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
    budgetEntered: input.budget?.entered === true,
    soldEstimate: readSoldEstimate(st),
    contractValue,
    actualRevenue,
    totalBudgetedExpense,
    costToComplete:
      totalBudgetedExpense.value != null && actualExpense.value != null
        ? computed(costToComplete(totalBudgetedExpense.value, actualExpense.value))
        : missing("computed"),
    changeOrders,
    costAdjustments,
    actualExpense,
    materialsExpense,
    subcontractorExpense,
    laborExpense,
    budgetedMaterials,
    budgetedSubcontractor,
    budgetedLaborExpense,
    actualMargin: computed(marginDollars, "servicetitan"),
    actualMarginPercent: computed(
      marginDollars != null && actualRevenue.value != null
        ? percentOf(marginDollars, actualRevenue.value)
        : null,
      "servicetitan",
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
