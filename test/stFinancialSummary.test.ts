import { describe, expect, it } from "vitest";
import {
  summarizeServiceTitanReads,
  type EstimateRead,
  type InvoiceHeaderRead,
} from "../src/domain/stFinancialSummary.js";

function sold(overrides: Partial<EstimateRead> = {}): EstimateRead {
  return {
    id: "est-1",
    status: "Sold",
    isChangeOrder: false,
    subtotal: 1000,
    tax: 80,
    total: 1080,
    items: [
      {
        skuType: "service",
        qty: 2,
        total: 1080,
        totalCost: 400,
        soldHours: 4,
      },
      {
        skuType: "material",
        qty: 1,
        total: 0,
        totalCost: 120,
        soldHours: null,
      },
    ],
    ...overrides,
  };
}

describe("ServiceTitan project summary", () => {
  it("sums sold estimates and keeps a real zero for change orders and cost adjustments", () => {
    const summary = summarizeServiceTitanReads({
      estimates: [
        sold(),
        sold({ id: "est-1" }),
        { ...sold({ id: "open" }), status: "Open" },
        sold({
          id: "co",
          isChangeOrder: true,
          subtotal: 200,
          tax: 0,
          total: 200,
          items: [
            { skuType: "service", qty: 1, total: 200, totalCost: 50, soldHours: 1 },
          ],
        }),
        sold({
          id: "cost-only",
          subtotal: 0,
          tax: 0,
          total: 0,
          items: [
            { skuType: "material", qty: 1, total: 0, totalCost: 75, soldHours: null },
          ],
        }),
      ],
      invoices: null,
    });
    expect(summary.estimatesRead).toBe(true);
    expect(summary.contractValue).toBe(1280);
    expect(summary.changeOrders).toBe(200);
    expect(summary.totalBudgetedExpense).toBe(645);
    expect(summary.costAdjustments).toBe(75);
    expect(summary.budgetedLaborExpense).toBe(450);
    expect(summary.budgetedLaborHours).toBe(9);
    expect(summary.budgetedMaterials).toBe(195);
    expect(summary.invoicesRead).toBe(false);
  });

  it("leaves change orders empty when a sold estimate has no change-order flag", () => {
    const summary = summarizeServiceTitanReads({
      estimates: [sold({ isChangeOrder: null })],
      invoices: null,
    });
    expect(summary.contractValue).toBe(1080);
    expect(summary.changeOrders).toBeNull();
  });

  it("leaves the budget empty when an item cost was not returned", () => {
    const summary = summarizeServiceTitanReads({
      estimates: [
        sold({
          items: [
            { skuType: "service", qty: 1, total: 1080, totalCost: null, soldHours: 4 },
          ],
        }),
      ],
      invoices: null,
    });
    expect(summary.totalBudgetedExpense).toBeNull();
    expect(summary.budgetedLaborExpense).toBeNull();
    expect(summary.budgetedLaborHours).toBe(4);
    const missingHours = summarizeServiceTitanReads({
      estimates: [
        sold({
          items: [
            { skuType: "service", qty: 1, total: 1080, totalCost: 400, soldHours: null },
          ],
        }),
      ],
      invoices: null,
    });
    expect(missingHours.budgetedLaborHours).toBeNull();
    expect(missingHours.budgetedLaborExpense).toBe(400);
  });

  it("sums open invoice balances and uses project retainage dollars when invoices omit retainage", () => {
    const invoices: InvoiceHeaderRead[] = [
      { id: "a", total: 100, balance: 0, retainage: null, active: true },
      { id: "b", total: 40, balance: 25, retainage: null, active: true },
      { id: "c", total: 10, balance: 10, retainage: null, active: false },
    ];
    const withoutProject = summarizeServiceTitanReads({ estimates: null, invoices });
    expect(withoutProject.billed).toBe(140);
    expect(withoutProject.openInvoices).toBe(25);
    expect(withoutProject.retainage).toBeNull();
    const withProject = summarizeServiceTitanReads({
      estimates: null,
      invoices: null,
      projectRetainage: 4180,
    });
    expect(withProject.invoicesRead).toBe(false);
    expect(withProject.retainage).toBe(4180);
    expect(withProject.billed).toBeNull();
  });
});
