import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  bindBudgetEntryFigures,
  budgetEntryHtml,
  budgetEntryMargin,
  budgetEntryPayload,
  budgetEntryTotal,
  formatBudgetMargin,
} from "../client/budgetEntry.js";

describe("budget entry form", () => {
  it("uses the shared form row and leaves a blank contract out of the total", () => {
    const parsed = budgetEntryPayload({
      contract_value: "",
      labor: "21480",
      labor_hours: "120",
      materials: "6708.80",
      subcontractor: "10728",
      other: "",
    });
    expect("body" in parsed).toBe(true);
    if (!("body" in parsed)) return;
    expect(parsed.body).toEqual({
      contract_value: null,
      labor: 21480,
      labor_hours: 120,
      materials: 6708.8,
      subcontractor: 10728,
      other: null,
    });
    expect(budgetEntryTotal(parsed.body)).toBe(38916.8);

    const html = budgetEntryHtml(
      {
        contract_value: null,
        labor: 21480,
        labor_hours: 120,
        materials: 6708.8,
        subcontractor: 10728,
        other: null,
      },
      { editable: true },
    );
    expect(html).toContain('class="form-row"');
    expect(html).toContain("Revenue");
    expect(html).toContain("Contract value");
    expect(html).toContain("What the customer pays");
    expect(html).toContain("Budgeted cost");
    expect(html).toContain("Labor cost");
    expect(html).toContain("Labor hours");
    expect(html).toContain("Subcontractor");
    expect(html).toContain("Total budgeted cost");
    expect(html).toContain("Expected margin");
    expect(html.indexOf("Revenue")).toBeLessThan(
      html.indexOf("Contract value"),
    );
    expect(html.indexOf("Contract value")).toBeLessThan(
      html.indexOf("Budgeted cost"),
    );
    expect(html.indexOf("Labor cost")).toBeLessThan(
      html.indexOf("Labor hours"),
    );
    expect(html.indexOf("Labor hours")).toBeLessThan(html.indexOf("Materials"));
    expect(html.indexOf(">Materials<")).toBeLessThan(
      html.indexOf("Subcontractor"),
    );
    expect(html.indexOf("Subcontractor")).toBeLessThan(html.indexOf(">Other<"));
    expect(html.indexOf("Total budgeted cost")).toBeLessThan(
      html.indexOf("Expected margin"),
    );
    expect(html).toContain("$38,916.80");
    expect(html).toContain("\u2014");
    expect(html).toContain('id="budget-save"');
    expect(html).toContain('value=""');
  });

  it("treats a blank form as no budget and rejects a zero contract", () => {
    const blank = budgetEntryPayload({});
    expect("body" in blank).toBe(true);
    if (!("body" in blank)) return;
    expect(blank.body.contract_value).toBeNull();
    expect(blank.body.labor).toBeNull();
    expect(budgetEntryTotal(blank.body)).toBeNull();

    expect(budgetEntryPayload({ contract_value: "0" })).toEqual({
      error: "Contract value has to be greater than zero, or left blank.",
    });
    expect(budgetEntryPayload({ labor: "-1" })).toEqual({
      error: "Amounts cannot be negative.",
    });

    const locked = budgetEntryHtml(null, { editable: false });
    expect(locked).not.toContain("budget-save");
    expect(locked).toContain("disabled");
    expect(locked).toContain('class="form-row"');
  });
});

describe("expected margin", () => {
  it("is blank when either side is blank, negative when cost exceeds the contract, and has no percent at a zero contract", () => {
    expect(budgetEntryMargin({})).toEqual({ amount: null, percent: null });
    expect(budgetEntryMargin({ contract_value: "", labor: "" })).toEqual({
      amount: null,
      percent: null,
    });
    expect(budgetEntryMargin({ contract_value: "100000", labor: "" })).toEqual({
      amount: null,
      percent: null,
    });
    expect(budgetEntryMargin({ contract_value: "", labor: "40000" })).toEqual({
      amount: null,
      percent: null,
    });
    expect(
      formatBudgetMargin(
        budgetEntryMargin({ contract_value: "", labor: "40000" }),
      ),
    ).toBe("\u2014");

    expect(
      budgetEntryMargin({
        contract_value: "100000",
        labor: "40000",
        materials: "15000",
        subcontractor: "10000",
        other: "5000",
      }),
    ).toEqual({ amount: 30000, percent: 30 });
    expect(
      formatBudgetMargin(
        budgetEntryMargin({
          contract_value: "100000",
          labor: "40000",
          materials: "15000",
          subcontractor: "10000",
          other: "5000",
        }),
      ),
    ).toBe("$30,000.00 (30.0%)");

    const negative = budgetEntryMargin({
      contract_value: "1000",
      labor: "1500",
    });
    expect(negative).toEqual({ amount: -500, percent: -50 });
    expect(formatBudgetMargin(negative)).toBe("\u2212$500.00 (\u221250.0%)");

    const zeroContract = budgetEntryMargin({
      contract_value: "0",
      labor: "100",
    });
    expect(zeroContract).toEqual({ amount: -100, percent: null });
    expect(formatBudgetMargin(zeroContract)).toBe("\u2212$100.00");
    expect(formatBudgetMargin(zeroContract)).not.toMatch(/Infinity|NaN/);

    expect(budgetEntryMargin({ contract_value: "0", labor: "0" })).toEqual({
      amount: 0,
      percent: null,
    });
  });

  it("updates the margin line as the contract and costs are typed", () => {
    const dom = new JSDOM(
      `<!doctype html><body>${budgetEntryHtml(
        { contract_value: null, labor: null },
        { editable: true },
      )}</body>`,
      { url: "http://localhost/" },
    );
    const win = dom.window as unknown as {
      document: {
        getElementById(id: string): {
          value: string;
          textContent: string | null;
          classList: { contains(name: string): boolean };
          dispatchEvent(event: unknown): void;
        } | null;
      };
      Event: new (type: string, init?: { bubbles?: boolean }) => object;
    };
    const { document } = win;
    bindBudgetEntryFigures(
      document as Parameters<typeof bindBudgetEntryFigures>[0],
    );
    expect(document.getElementById("budget-margin")?.textContent).toBe(
      "\u2014",
    );

    const contract = document.getElementById("budget-contract");
    const labor = document.getElementById("budget-labor");
    if (!contract || !labor) throw new Error("budget fields missing");
    contract.value = "10000";
    contract.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(document.getElementById("budget-margin")?.textContent).toBe(
      "\u2014",
    );

    labor.value = "12500";
    labor.dispatchEvent(new win.Event("input", { bubbles: true }));
    const margin = document.getElementById("budget-margin");
    if (!margin) throw new Error("margin missing");
    expect(margin.textContent).toBe("\u2212$2,500.00 (\u221225.0%)");
    expect(margin.classList.contains("neg")).toBe(true);
  });
});
