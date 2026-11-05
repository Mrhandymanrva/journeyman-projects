import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  billsSummary,
  budgetSummary,
  changeOrderSummary,
  collapsedCard,
  drawSummary,
  laborSummary,
  nextSectionExpanded,
  purchaseOrderSummary,
  reservesSummary,
  stDetailSummary,
} from "../client/financialsSections.js";

describe("financials sections", () => {
  it("starts collapsed and shows a one-line total", () => {
    const html = collapsedCard({
      id: "bills",
      title: "Vendor bills & payments",
      summary: billsSummary([
        { status: "received", amount: 100 },
        { status: "rejected", amount: 50 },
        { status: "approved", amount: 25 },
      ]),
      body: "<p>Bills</p>",
    });
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="fin-body-bills"');
    expect(html).toContain('id="fin-body-bills" hidden');
    expect(html).toContain("2 bills · $125");
    expect(html).toContain("Vendor bills & payments");
    expect(nextSectionExpanded(false)).toBe(true);
    expect(nextSectionExpanded("false")).toBe(true);
    expect(nextSectionExpanded(true)).toBe(false);
    expect(nextSectionExpanded("true")).toBe(false);
  });

  it("summarizes the other financials sections as a count and a dollar total", () => {
    expect(budgetSummary([{ baseline: 100 }, { baseline: 50 }])).toBe("2 lines · $150 budget");
    expect(budgetSummary([])).toBe("No budget entered");
    expect(budgetSummary([], { entered: true })).toBe("No cost-code lines");
    expect(purchaseOrderSummary([{ amount: 2600 }])).toBe("1 purchase order · $2,600");
    expect(changeOrderSummary({ change_orders: [{ customer_amount: 2400 }] })).toBe(
      "1 change order · $2,400",
    );
    expect(drawSummary({ draws: [{ amount: 4000 }, { amount: 1000 }] })).toBe("2 draws · $5,000");
    expect(laborSummary({ hours: 8.07, total: 308 })).toBe("8.07 hours · $308.00");
    expect(stDetailSummary(null)).toBe("Not read yet");
    expect(
      stDetailSummary({ observed_at: "2026-10-27T12:00:00Z", billed: 1952, expenses: 448, margin: 1504 }),
    ).toBe("Billed $1,952.00 · Expenses $448.00 · Margin $1,504.00");
    expect(
      stDetailSummary({
        observed_at: "2026-10-27T12:00:00Z",
        billed: 28289.92,
        materials_expense_read: false,
      }),
    ).toBe("Billed $28,289.92 · Expenses not returned");
    expect(
      reservesSummary([
        { active: true, data: { allocated: 1000, drawn: 250 } },
        { active: false, data: { allocated: 500, drawn: 0 } },
      ]),
    ).toBe("1 reserve · $1,000 allocated · $750 remaining");
  });

  it("collapses every financials card in the page shell and leaves the notice open", () => {
    const html = readFileSync("client/index.html", "utf8");
    const toggles = html.match(/class="fin-section-toggle"/g) ?? [];
    expect(toggles).toHaveLength(7);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(7);
    for (const id of ["st-financials", "fin-body-budget", "pos", "cos", "closeout", "labor", "draws"]) {
      expect(html).toContain(`aria-controls="${id}"`);
      expect(html).toContain(`id="${id}" hidden`);
    }
    expect(html).toContain('<div id="notice"></div>');
    expect(html).toContain('<div class="card-b" id="subs"></div>');
    expect(html).not.toContain('data-fin-section="notice"');
    const css = readFileSync("client/console.css", "utf8");
    expect(css).toContain(".form-row{");
    expect(css).not.toContain("field-start-override{display:flex;flex-wrap:wrap");
  });
});
