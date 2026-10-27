import { describe, expect, it } from "vitest";
import { financialsDashboardHtml } from "../client/financialsDashboard.js";
import {
  buildFinancialsDashboard,
  costToComplete,
  earnedRevenue,
  percentOf,
  type DashboardActuals,
  type DashboardServiceTitan,
} from "../src/domain/financialsDashboard.js";

const actuals: DashboardActuals = {
  observed: true,
  billed: 1952,
  laborBurden: 48,
  materialsExpense: 400,
  expenses: 448,
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

describe("financials dashboard tiles", () => {
  it("uses actuals for revenue and expense, ServiceTitan for contract figures, and computes the rest", () => {
    const dashboard = buildFinancialsDashboard({ actuals, serviceTitan });
    expect(dashboard.actualRevenue).toEqual({ value: 1952, source: "actuals" });
    expect(dashboard.actualExpense).toEqual({ value: 448, source: "actuals" });
    expect(dashboard.contractValue).toEqual({ value: 41800, source: "servicetitan" });
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
    expect(dashboard.earnedRevenue.value).toBe(
      earnedRevenue(41800, 448, 25920),
    );
    expect(dashboard.earnedRevenue.source).toBe("computed");
    expect(percentOf(1504, 1952)).toBe(77.05);
    expect(costToComplete(25920, 448)).toBe(25472);
  });

  it("dashes contract, cost to complete, and earned revenue when ServiceTitan was not read", () => {
    const dashboard = buildFinancialsDashboard({ actuals, serviceTitan: null });
    expect(dashboard.contractValue.value).toBeNull();
    expect(dashboard.totalBudgetedExpense.value).toBeNull();
    expect(dashboard.costToComplete.value).toBeNull();
    expect(dashboard.earnedRevenue.value).toBeNull();
    expect(dashboard.percentOfWorkCompleted.value).toBeNull();
    expect(dashboard.openInvoices.value).toBeNull();
    expect(dashboard.actualRevenue.value).toBe(1952);
    const html = financialsDashboardHtml(dashboard);
    expect(html).toContain("ServiceTitan did not return this figure. Nothing is estimated.");
    expect(html).toContain("Contract value");
    expect(html).toContain("Cost to complete");
    expect(html).toContain("\u2014");
  });

  it("dashes margin when actuals have not been observed", () => {
    const dashboard = buildFinancialsDashboard({
      actuals: { observed: false, billed: 0, laborBurden: 0, materialsExpense: 0, expenses: 0 },
      serviceTitan,
    });
    expect(dashboard.actualRevenue.value).toBeNull();
    expect(dashboard.actualExpense.value).toBeNull();
    expect(dashboard.actualMargin.value).toBeNull();
    expect(dashboard.actualMarginPercent.value).toBeNull();
    expect(dashboard.contractValue.value).toBe(41800);
  });

  it("keeps a dollar cost to complete when the budget is zero and does not invent a percent", () => {
    const dashboard = buildFinancialsDashboard({
      actuals,
      serviceTitan: { ...serviceTitan, totalBudgetedExpense: 0 },
    });
    expect(dashboard.costToComplete.value).toBe(-448);
    expect(dashboard.percentOfWorkCompleted.value).toBeNull();
    expect(dashboard.earnedRevenue.value).toBeNull();
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
