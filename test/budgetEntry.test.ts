import { describe, expect, it } from "vitest";
import {
  budgetEntryHtml,
  budgetEntryPayload,
  budgetEntryTotal,
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
    expect(html).toContain("Contract value");
    expect(html).toContain("Labor hours");
    expect(html).toContain("Subcontractor");
    expect(html).toContain("Total budgeted expense");
    expect(html).toContain("$38,916.80");
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
