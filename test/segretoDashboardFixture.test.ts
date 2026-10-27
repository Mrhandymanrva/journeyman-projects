import { describe, expect, it } from "vitest";
import { financialsDashboardHtml } from "../client/financialsDashboard.js";
import { buildFinancialsDashboard } from "../src/domain/financialsDashboard.js";
import { roundMoney } from "../src/domain/projectFinancials.js";
import {
  SEGRETO_DASHBOARD_FIXTURE,
  segretoBilledMaterials,
  segretoDashboardInput,
  segretoInvoiceLines,
  segretoOpenInvoices,
} from "../src/demo/segretoDashboardFixture.js";

describe("Segreto dashboard fixture", () => {
  it("builds the dashboard from one object and dashes figures ServiceTitan did not return", () => {
    const fixture = SEGRETO_DASHBOARD_FIXTURE;
    expect(segretoBilledMaterials(fixture)).toBe(10185.52);
    expect(segretoOpenInvoices(fixture)).toBe(3930.32);
    expect(roundMoney(fixture.actuals.billedLabor + segretoBilledMaterials(fixture))).toBe(
      fixture.invoices.headerTotal,
    );
    expect(roundMoney(fixture.payments.applied + fixture.payments.unapplied)).toBe(fixture.payments.total);
    expect(segretoInvoiceLines(fixture).map((line) => line.kind)).toEqual(["labor", "material", "material"]);

    const input = segretoDashboardInput(fixture);
    expect(input.actuals.billed).toBe(28289.92);
    expect(input.actuals.materialsExpense).toBeNull();
    expect(input.actuals.expenses).toBeNull();
    expect(input.serviceTitan.billed).toBe(28289.92);
    expect(input.serviceTitan.openInvoices).toBe(3930.32);
    expect(input.serviceTitan.estimatesRead).toBe(false);

    const dashboard = buildFinancialsDashboard(input);
    expect(dashboard.actualRevenue).toEqual({ value: 28289.92, source: "actuals" });
    expect(dashboard.laborExpense).toEqual({ value: 2440.43, source: "actuals" });
    expect(dashboard.billed).toEqual({ value: 28289.92, source: "servicetitan" });
    expect(dashboard.openInvoices).toEqual({ value: 3930.32, source: "servicetitan" });
    expect(dashboard.materialsExpense.value).toBeNull();
    expect(dashboard.actualExpense.value).toBeNull();
    expect(dashboard.actualMargin.value).toBeNull();
    expect(dashboard.actualMarginPercent.value).toBeNull();
    expect(dashboard.contractValue.value).toBeNull();
    expect(dashboard.totalBudgetedExpense.value).toBeNull();
    expect(dashboard.changeOrders.value).toBeNull();
    expect(dashboard.costAdjustments.value).toBeNull();
    expect(dashboard.costToComplete.value).toBeNull();
    expect(dashboard.earnedRevenue.value).toBeNull();
    expect(dashboard.percentOfWorkCompleted.value).toBeNull();
    expect(dashboard.budgetedMargin.value).toBeNull();
    expect(dashboard.budgetedMarginPercent.value).toBeNull();
    expect(dashboard.budgetedLaborExpense.value).toBeNull();
    expect(dashboard.budgetedLaborHours.value).toBeNull();
    expect(dashboard.retainage.value).toBeNull();
    expect(dashboard.contractValue.value).not.toBe(fixture.journeymanContract);
    expect(dashboard.contractValue.value).not.toBe(fixture.payments.total);

    const html = financialsDashboardHtml(dashboard);
    expect(html).toContain("ServiceTitan did not return this figure. Nothing is estimated.");
    expect(html).toContain("$28,289.92");
    expect(html).toContain("$3,930.32");
    expect(html).toContain("$2,440.43");
    expect(html).not.toContain("$30,000");
    expect(html).not.toContain("$1.00");
  });
});