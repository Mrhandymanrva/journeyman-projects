/**
 * Project financials summary tiles.
 * Budget tiles come from the Journeyman budget. Actuals, billed, open
 * invoices, retainage, change orders, and cost adjustments stay on the
 * ServiceTitan read. A missing figure stays null. Nothing here invents a
 * number, and nothing writes to ServiceTitan.
 */

import type { CommittedLabor } from "./committedLabor.js";
import { roundMoney } from "./projectFinancials.js";

export type FigureSource = "journeyman" | "servicetitan" | "actuals" | "computed" | "missing";

export type FigureGap = "budget" | "computed" | "servicetitan";

export interface Figure {
  value: number | null;
  source: FigureSource;
  /** Why a missing figure is blank. Omitted when the figure has a value. */
  gap?: FigureGap;
  /**
   * Replaces the formatted percent when cost-to-cost completion is past the budget.
   * The numeric value stays capped at 100.
   */
  note?: string;
  /** Plain-language formula, shown as a tooltip when the figure has a value. */
  tip?: string;
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
  /**
   * Scheduled labor still committed against the budget. Absent on callers
   * that only build tiles from budget and actuals. Its `cost` is the only
   * committed dollar amount the summary uses.
   */
  committedLabor?: CommittedLabor | null;
  /** Same number as committedLabor.cost. Omitted when committed labor was not read. */
  committedCost?: Figure;
  /** Actual expense plus committedLabor.cost. Omitted when committed labor was not read. */
  projectedCost?: Figure;
}

/** Committed cost is the Labor commitment panel total. It is not recomputed here. */
export const COMMITTED_COST_TIP =
  "Committed labor cost, the same total as the Labor commitment panel. It is 25% of that labor revenue plus hours times the ServiceTitan burden rate, for linked jobs that are not yet both completed and invoiced. Those jobs are not included in actual expense.";

export const PROJECTED_COST_TIP =
  "Actual expense plus committed labor. Committed labor is the Labor commitment total. A job moves from committed to actual once it is completed and invoiced, so it is not in both.";

export const ACTUAL_EXPENSE_TIP =
  "Labor burden, materials, and subcontract cost already recorded. Committed labor is not included. A completed and invoiced job is in this actual, not in committed.";

export const COST_TO_COMPLETE_TIP =
  "Total budgeted expense minus actual expense minus committed labor. Committed labor is the Labor commitment total and is not already inside actual expense.";

export const ACTUAL_MARGIN_TIP =
  "Actual revenue minus actual expense. Committed labor is not subtracted. Margin stays on actuals only.";

export const ACTUAL_MARGIN_PERCENT_TIP =
  "Actual margin divided by actual revenue. Actual margin is actual revenue minus actual expense. Committed labor is not subtracted.";

export const PERCENT_COMPLETE_TIP =
  "Actual expense divided by total budgeted expense, and never shown above 100%. Committed labor is not included. Completion stays on actuals only.";

export const EARNED_REVENUE_TIP =
  "Contract value times percent of work completed. That percent is actual expense divided by total budgeted expense, and capped at 100%. Committed labor is not included.";

export const BUDGETED_MARGIN_TIP =
  "Contract value minus total budgeted expense. Committed labor is not part of this figure.";

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

function withOverBudgetNote(
  figure: Figure,
  spent: number | null,
  budget: number | null,
  committed = 0,
): Figure {
  if (spent == null || budget == null) return figure;
  const note = overBudgetNote(spent, budget, committed);
  return note ? { ...figure, note } : figure;
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
 * Cost to complete is total budgeted expense minus actual expense minus
 * committed labor. Committed defaults to 0 when that read was not supplied.
 * The result may be negative when the project is already over budget.
 * Committed labor is only jobs that have not moved to actual.
 */
export function costToComplete(budget: number, actualExpense: number, committed = 0): number {
  return roundMoney(budget - actualExpense - committed);
}

/**
 * Cost-to-cost percent complete from actual expense only, two decimal places, never above 100.
 * Committed labor is not included. A zero, missing, or non-finite budget does not produce a percent.
 */
export function percentComplete(actualExpense: number, budget: number): number | null {
  const raw = percentOf(actualExpense, budget);
  if (raw == null) return null;
  return raw > 100 ? 100 : raw;
}

/**
 * Earned revenue is contract value times cost-to-cost percent complete.
 * The percent uses actual expense only and is capped at 100, so earned revenue
 * never exceeds contract value. Committed labor is not included.
 * A zero, missing, or non-finite budget does not produce a number.
 */
export function earnedRevenue(contract: number, actualExpense: number, budget: number): number | null {
  if (!(budget > 0) || !Number.isFinite(contract) || !Number.isFinite(actualExpense)) return null;
  if (actualExpense >= budget) return roundMoney(contract);
  return roundMoney(contract * (actualExpense / budget));
}

/** Shown instead of a percent above 100. Null when the job is not over budget. */
export function overBudgetNote(spent: number, budget: number, committed = 0): string | null {
  if (!(budget > 0) || !Number.isFinite(spent) || !Number.isFinite(budget)) return null;
  if (!(spent > budget)) return null;
  const label = committed > 0 ? "actual and committed" : "actual";
  return `Over budget · ${label} ${formatDashboardMoney(spent)} vs budget ${formatDashboardMoney(budget)}`;
}

function formatDashboardMoney(value: number): string {
  const rounded = roundMoney(value);
  const sign = rounded < 0 ? "-" : "";
  const [whole, frac] = Math.abs(rounded).toFixed(2).split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}.${frac}`;
}

function withTip(figure: Figure, tip: string | null): Figure {
  if (!tip) return figure;
  return { ...figure, tip };
}

/** The Labor commitment panel's committed dollars. Null when that read was not supplied. */
export function committedLaborCost(labor: CommittedLabor | null | undefined): number | null {
  if (!labor) return null;
  const cost = labor.cost;
  return Number.isFinite(cost) ? roundMoney(cost) : 0;
}

export function buildFinancialsDashboard(input: {
  actuals: DashboardActuals | null;
  serviceTitan: DashboardServiceTitan | null;
  budget?: DashboardBudget | null;
  /** When set, every committed dollar on this summary is `committedLabor.cost`. */
  committedLabor?: CommittedLabor | null;
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

  const committed = committedLaborCost(input.committedLabor);
  const committedAmount = committed ?? 0;
  const marginDollars =
    actualRevenue.value != null && actualExpense.value != null
      ? roundMoney(actualRevenue.value - actualExpense.value)
      : null;
  const budgetMarginDollars =
    contractValue.value != null && totalBudgetedExpense.value != null
      ? roundMoney(contractValue.value - totalBudgetedExpense.value)
      : null;
  const committedTips = committed != null;

  return {
    budgetEntered: input.budget?.entered === true,
    soldEstimate: readSoldEstimate(st),
    contractValue,
    actualRevenue,
    totalBudgetedExpense,
    costToComplete: withTip(
      totalBudgetedExpense.value != null && actualExpense.value != null
        ? computed(costToComplete(totalBudgetedExpense.value, actualExpense.value, committedAmount))
        : missing("computed"),
      committedTips ? COST_TO_COMPLETE_TIP : null,
    ),
    changeOrders,
    costAdjustments,
    actualExpense: withTip(actualExpense, committedTips ? ACTUAL_EXPENSE_TIP : null),
    materialsExpense,
    subcontractorExpense,
    laborExpense,
    budgetedMaterials,
    budgetedSubcontractor,
    budgetedLaborExpense,
    actualMargin: withTip(computed(marginDollars, "servicetitan"), committedTips ? ACTUAL_MARGIN_TIP : null),
    actualMarginPercent: withTip(
      computed(
        marginDollars != null && actualRevenue.value != null
          ? percentOf(marginDollars, actualRevenue.value)
          : null,
        "servicetitan",
      ),
      committedTips ? ACTUAL_MARGIN_PERCENT_TIP : null,
    ),
    billed,
    budgetedMargin: withTip(computed(budgetMarginDollars), committedTips ? BUDGETED_MARGIN_TIP : null),
    budgetedMarginPercent: computed(
      budgetMarginDollars != null && contractValue.value != null
        ? percentOf(budgetMarginDollars, contractValue.value)
        : null,
    ),
    earnedRevenue: withTip(
      computed(
        contractValue.value != null &&
          actualExpense.value != null &&
          totalBudgetedExpense.value != null
          ? earnedRevenue(contractValue.value, actualExpense.value, totalBudgetedExpense.value)
          : null,
      ),
      committedTips ? EARNED_REVENUE_TIP : null,
    ),
    percentOfWorkCompleted: withTip(
      withOverBudgetNote(
        computed(
          actualExpense.value != null && totalBudgetedExpense.value != null
            ? percentComplete(actualExpense.value, totalBudgetedExpense.value)
            : null,
        ),
        actualExpense.value,
        totalBudgetedExpense.value,
      ),
      committedTips ? PERCENT_COMPLETE_TIP : null,
    ),
    retainage,
    openInvoices,
    budgetedLaborHours,
    ...(input.committedLabor
      ? {
          committedLabor: input.committedLabor,
          committedCost: {
            value: committedAmount,
            source: "computed" as const,
            tip: COMMITTED_COST_TIP,
          },
          projectedCost:
            actualExpense.value == null
              ? missing("computed")
              : {
                  value: roundMoney(actualExpense.value + committedAmount),
                  source: "computed" as const,
                  tip: PROJECTED_COST_TIP,
                },
        }
      : {}),
  };
}
