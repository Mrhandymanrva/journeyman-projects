import { describe, expect, it } from "vitest";
import { financialsDashboardHtml } from "../client/financialsDashboard.js";
import {
  buildFinancialsDashboard,
  costToComplete,
  earnedRevenue,
  overBudgetNote,
  percentComplete,
  percentOf,
  type DashboardActuals,
  type DashboardBudget,
  type DashboardServiceTitan,
} from "../src/domain/financialsDashboard.js";

const actuals: DashboardActuals = {
  observed: true,
  billed: 1952,
  laborBurden: 48,
  materialsExpense: 400,
  expenses: 448,
};

const budget: DashboardBudget = {
  entered: true,
  contractValue: 41800,
  laborHours: 32,
  labor: 4800,
  materials: 8000,
  subcontractor: 13120,
  other: null,
  totalBudgetedExpense: 25920,
};

const serviceTitan: DashboardServiceTitan = {
  estimatesRead: true,
  contractValue: 41800,
  totalBudgetedExpense: 25920,
  changeOrders: 2400,
  costAdjustments: 0,
  budgetedLaborExpense: 4800,
  budgetedLaborHours: 32,
  budgetedMaterials: 8000,
  invoicesRead: true,
  billed: 27480,
  openInvoices: 14940,
  retainage: 4180,
};

function visible(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

describe("financials dashboard tiles", () => {
  it("uses actuals for revenue and expense, the Journeyman budget for contract and cost, and computes the rest", () => {
    const dashboard = buildFinancialsDashboard({ actuals, serviceTitan, budget });
    expect(dashboard.actualRevenue).toEqual({ value: 1952, source: "actuals" });
    expect(dashboard.actualExpense).toEqual({ value: 448, source: "actuals" });
    expect(dashboard.contractValue).toEqual({ value: 41800, source: "journeyman" });
    expect(dashboard.totalBudgetedExpense).toEqual({ value: 25920, source: "journeyman" });
    expect(dashboard.budgetedLaborExpense).toEqual({ value: 4800, source: "journeyman" });
    expect(dashboard.budgetedLaborHours).toEqual({ value: 32, source: "journeyman" });
    expect(dashboard.changeOrders).toEqual({ value: 2400, source: "servicetitan" });
    expect(dashboard.costAdjustments).toEqual({ value: 0, source: "servicetitan" });
    expect(dashboard.openInvoices).toEqual({ value: 14940, source: "servicetitan" });
    expect(dashboard.billed).toEqual({ value: 27480, source: "servicetitan" });
    expect(dashboard.actualMargin).toEqual({ value: 1504, source: "computed" });
    expect(dashboard.actualMarginPercent).toEqual({ value: 77.05, source: "computed" });
    expect(dashboard.costToComplete).toEqual({ value: 25472, source: "computed" });
    expect(dashboard.budgetedMargin).toEqual({ value: 15880, source: "computed" });
    expect(dashboard.budgetedMarginPercent).toEqual({ value: 37.99, source: "computed" });
    expect(dashboard.percentOfWorkCompleted).toEqual({ value: 1.73, source: "computed" });
    expect(dashboard.earnedRevenue.value).toBe(earnedRevenue(41800, 448, 25920));
    expect(dashboard.earnedRevenue.source).toBe("computed");
    expect(percentOf(1504, 1952)).toBe(77.05);
    expect(costToComplete(25920, 448)).toBe(25472);
  });

  it("does not let a ServiceTitan sold estimate replace the Journeyman budget", () => {
    const dashboard = buildFinancialsDashboard({
      actuals,
      serviceTitan,
      budget: {
        entered: true,
        contractValue: 50000,
        laborHours: 10,
        labor: 1000,
        materials: 2000,
        subcontractor: 3000,
        other: null,
        totalBudgetedExpense: 6000,
      },
    });
    expect(dashboard.contractValue).toEqual({ value: 50000, source: "journeyman" });
    expect(dashboard.totalBudgetedExpense).toEqual({ value: 6000, source: "journeyman" });
    expect(dashboard.budgetedLaborExpense).toEqual({ value: 1000, source: "journeyman" });
    expect(dashboard.budgetedLaborHours).toEqual({ value: 10, source: "journeyman" });
    expect(dashboard.budgetedMaterials).toEqual({ value: 2000, source: "journeyman" });
    expect(dashboard.soldEstimate).toMatchObject({
      contractValue: 41800,
      totalBudgetedExpense: 25920,
      budgetedLaborExpense: 4800,
      budgetedLaborHours: 32,
    });
    expect(dashboard.changeOrders).toEqual({ value: 2400, source: "servicetitan" });
    expect(dashboard.costToComplete).toEqual({ value: 5552, source: "computed" });
    expect(dashboard.budgetedMargin).toEqual({ value: 44000, source: "computed" });
    expect(dashboard.budgetedMarginPercent).toEqual({ value: 88, source: "computed" });
    expect(dashboard.percentOfWorkCompleted).toEqual({ value: 7.47, source: "computed" });
    expect(dashboard.earnedRevenue.value).toBe(earnedRevenue(50000, 448, 6000));
    const html = financialsDashboardHtml(dashboard);
    expect(html).toContain("ServiceTitan sold estimate, read only");
    expect(html).toContain("$50,000.00");
    expect(html).not.toContain("No budget entered");
  });

  it("shows the empty state and never a zero when no budget has been entered", () => {
    const dashboard = buildFinancialsDashboard({ actuals: null, serviceTitan: null, budget: null });
    expect(dashboard.budgetEntered).toBe(false);
    expect(dashboard.contractValue).toEqual({ value: null, source: "missing", gap: "budget" });
    expect(dashboard.totalBudgetedExpense.gap).toBe("budget");
    expect(dashboard.budgetedLaborHours.gap).toBe("budget");
    expect(dashboard.costToComplete.gap).toBe("computed");
    expect(dashboard.earnedRevenue.gap).toBe("computed");
    expect(dashboard.percentOfWorkCompleted.gap).toBe("computed");
    expect(dashboard.budgetedMargin.gap).toBe("computed");
    const html = financialsDashboardHtml(dashboard);
    expect(visible(html)).toContain("No budget entered \u2014 Enter budget");
    expect(html).toContain('id="enter-budget"');
    expect(html).toContain("No budget entered for this figure.");
    expect(html).toContain("This figure stays blank until every number it uses has been entered.");
    expect(html).not.toContain("$0");
  });

  it("dashes a tile that needs a category or a contract that was left blank", () => {
    const dashboard = buildFinancialsDashboard({
      actuals: {
        observed: true,
        billed: 28289.92,
        laborBurden: 2440.43,
        materialsExpense: null,
        expenses: null,
      },
      serviceTitan: {
        ...serviceTitan,
        estimatesRead: false,
        invoicesRead: true,
        billed: 28289.92,
        openInvoices: 3930.32,
        retainage: null,
      },
      budget: {
        entered: true,
        contractValue: null,
        laborHours: 120,
        labor: 21480,
        materials: 6708.8,
        subcontractor: 10728,
        other: null,
        totalBudgetedExpense: 38916.8,
      },
    });
    expect(dashboard.budgetEntered).toBe(true);
    expect(dashboard.contractValue).toEqual({ value: null, source: "missing", gap: "budget" });
    expect(dashboard.totalBudgetedExpense).toEqual({ value: 38916.8, source: "journeyman" });
    expect(dashboard.budgetedLaborExpense).toEqual({ value: 21480, source: "journeyman" });
    expect(dashboard.budgetedLaborHours).toEqual({ value: 120, source: "journeyman" });
    expect(dashboard.budgetedMaterials).toEqual({ value: 6708.8, source: "journeyman" });
    expect(dashboard.costToComplete).toEqual({ value: null, source: "missing", gap: "computed" });
    expect(dashboard.budgetedMargin.value).toBeNull();
    expect(dashboard.earnedRevenue.value).toBeNull();
    expect(dashboard.percentOfWorkCompleted.value).toBeNull();
    expect(dashboard.actualRevenue).toEqual({ value: 28289.92, source: "actuals" });
    expect(dashboard.billed).toEqual({ value: 28289.92, source: "servicetitan" });
    expect(dashboard.laborExpense).toEqual({ value: 2440.43, source: "actuals" });
    expect(dashboard.openInvoices).toEqual({ value: 3930.32, source: "servicetitan" });
    expect(dashboard.soldEstimate).toBeNull();
    const html = financialsDashboardHtml(dashboard);
    expect(html).toContain("No budget entered for this figure.");
    expect(html).toContain("$38,916.80");
    expect(html).toContain("$21,480.00");
    expect(visible(html)).not.toContain("No budget entered \u2014 Enter budget");
  });

  it("dashes budget tiles when no Journeyman budget is entered, even if actuals were read", () => {
    const dashboard = buildFinancialsDashboard({ actuals, serviceTitan: null });
    expect(dashboard.contractValue.value).toBeNull();
    expect(dashboard.contractValue.gap).toBe("budget");
    expect(dashboard.totalBudgetedExpense.value).toBeNull();
    expect(dashboard.costToComplete.value).toBeNull();
    expect(dashboard.costToComplete.gap).toBe("computed");
    expect(dashboard.earnedRevenue.value).toBeNull();
    expect(dashboard.percentOfWorkCompleted.value).toBeNull();
    expect(dashboard.openInvoices.value).toBeNull();
    expect(dashboard.openInvoices.gap).toBe("servicetitan");
    expect(dashboard.actualRevenue.value).toBe(1952);
    const html = financialsDashboardHtml(dashboard);
    expect(html).toContain("ServiceTitan did not return this figure. Nothing is estimated.");
    expect(html).toContain("No budget entered for this figure.");
    expect(visible(html)).toContain("No budget entered \u2014 Enter budget");
  });

  it("dashes margin when actuals have not been observed", () => {
    const dashboard = buildFinancialsDashboard({
      actuals: { observed: false, billed: 0, laborBurden: 0, materialsExpense: 0, expenses: 0 },
      serviceTitan,
      budget,
    });
    expect(dashboard.actualRevenue.value).toBeNull();
    expect(dashboard.actualExpense.value).toBeNull();
    expect(dashboard.actualMargin.value).toBeNull();
    expect(dashboard.actualMarginPercent.value).toBeNull();
    expect(dashboard.contractValue).toEqual({ value: 41800, source: "journeyman" });
  });

  it("keeps a dollar cost to complete when the budget is zero and does not invent a percent", () => {
    const dashboard = buildFinancialsDashboard({
      actuals,
      serviceTitan,
      budget: {
        ...budget,
        labor: 0,
        materials: 0,
        subcontractor: 0,
        other: 0,
        totalBudgetedExpense: 0,
      },
    });
    expect(dashboard.totalBudgetedExpense).toEqual({ value: 0, source: "journeyman" });
    expect(dashboard.costToComplete.value).toBe(-448);
    expect(dashboard.percentOfWorkCompleted.value).toBeNull();
    expect(dashboard.earnedRevenue.value).toBeNull();
  });

  it("dashes actual expense and margin when materials expense was not returned", () => {
    const dashboard = buildFinancialsDashboard({
      actuals: { observed: true, billed: 28289.92, laborBurden: 2440.43, materialsExpense: null, expenses: null },
      serviceTitan: { ...serviceTitan, estimatesRead: false, invoicesRead: true, billed: 28289.92, openInvoices: 3930.32, retainage: null },
    });
    expect(dashboard.laborExpense).toEqual({ value: 2440.43, source: "actuals" });
    expect(dashboard.materialsExpense.value).toBeNull();
    expect(dashboard.actualExpense.value).toBeNull();
    expect(dashboard.actualMargin.value).toBeNull();
    expect(dashboard.actualMarginPercent.value).toBeNull();
    expect(dashboard.costToComplete.value).toBeNull();
    expect(dashboard.openInvoices).toEqual({ value: 3930.32, source: "servicetitan" });
    expect(dashboard.retainage.value).toBeNull();
  });

  it("caps cost-to-cost completion at 100 percent so earned revenue stays within the contract", () => {
    const over = buildFinancialsDashboard({
      actuals: {
        observed: true,
        billed: 4200,
        laborBurden: 180,
        materialsExpense: 26720.88,
        subcontractorExpense: 0,
        expenses: 26900.88,
      },
      serviceTitan,
      budget: {
        entered: true,
        contractValue: 62000,
        laborHours: 16,
        labor: 2400,
        materials: null,
        subcontractor: null,
        other: null,
        totalBudgetedExpense: 2400,
      },
    });
    expect(percentComplete(26900.88, 2400)).toBe(100);
    expect(earnedRevenue(62000, 26900.88, 2400)).toBe(62000);
    expect(over.percentOfWorkCompleted.value).toBe(100);
    expect(over.percentOfWorkCompleted.note).toBe("Over budget · actual $26,900.88 vs budget $2,400.00");
    expect(over.earnedRevenue.value).toBe(62000);
    expect(over.earnedRevenue.value).toBe(over.contractValue.value);
    const html = financialsDashboardHtml(over);
    expect(visible(html)).toContain("Over budget · actual $26,900.88 vs budget $2,400.00");
    expect(html).not.toContain("1,120");
    expect(html).not.toContain("694,939");
    expect(html).not.toContain("Infinity");
    expect(html).not.toContain("NaN");
  });

  it("leaves an under-budget percent and earned revenue unchanged", () => {
    expect(percentComplete(448, 25920)).toBe(1.73);
    expect(overBudgetNote(448, 25920)).toBeNull();
    expect(earnedRevenue(41800, 448, 25920)).toBe(722.47);
    const dashboard = buildFinancialsDashboard({ actuals, serviceTitan, budget });
    expect(dashboard.percentOfWorkCompleted).toEqual({ value: 1.73, source: "computed" });
    expect(dashboard.earnedRevenue.value).toBe(722.47);
    expect(financialsDashboardHtml(dashboard)).not.toContain("Over budget");
  });

  it("does not divide by a zero budget", () => {
    expect(percentComplete(26900.88, 0)).toBeNull();
    expect(percentComplete(10, Number.NaN)).toBeNull();
    expect(earnedRevenue(62000, 26900.88, 0)).toBeNull();
    expect(earnedRevenue(Number.POSITIVE_INFINITY, 10, 100)).toBeNull();
    expect(overBudgetNote(10, 0)).toBeNull();
    const dashboard = buildFinancialsDashboard({
      actuals,
      serviceTitan: null,
      budget: { ...budget, totalBudgetedExpense: 0, labor: 0, materials: 0, subcontractor: 0, other: 0 },
    });
    expect(dashboard.percentOfWorkCompleted.value).toBeNull();
    expect(dashboard.percentOfWorkCompleted.note).toBeUndefined();
    expect(dashboard.earnedRevenue.value).toBeNull();
    const html = financialsDashboardHtml(dashboard);
    expect(html).not.toContain("Infinity");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Over budget");
  });

  it("does not invent a margin percent when actual revenue is zero", () => {
    const dashboard = buildFinancialsDashboard({
      actuals: { observed: true, billed: 0, laborBurden: 10, materialsExpense: 0, expenses: 10 },
      serviceTitan,
    });
    expect(dashboard.actualMargin.value).toBe(-10);
    expect(dashboard.actualMarginPercent.value).toBeNull();
  });
});
