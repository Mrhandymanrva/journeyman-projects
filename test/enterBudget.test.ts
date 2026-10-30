import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { can, type StaffRole } from "../src/http/capabilities.js";
import { bindSoldEstimateButton, budgetEntryHtml, budgetFormEditable } from "../client/budgetEntry.js";
import { bindEnterBudget } from "../client/financialsSections.js";

const soldEstimate = {
  contractValue: 83432.65,
  totalBudgetedExpense: 29096.57,
  budgetedLaborExpense: 0,
  budgetedLaborHours: 0,
  budgetedMaterials: 29096.57,
};

function financialsPage(role: StaffRole) {
  const editable = can(role, "edit_budget_before_freeze");
  const form = budgetEntryHtml(
    { contract_value: null, subcontractor: 50 },
    { editable, soldEstimate },
  );
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <section id="page-financials" hidden>
        <button type="button" id="enter-budget">Enter budget</button>
        <section class="card">
          <button type="button" class="fin-section-toggle" aria-expanded="false" aria-controls="outer-body">Parent</button>
          <div id="outer-body" hidden>
            <button type="button" class="fin-section-toggle" aria-expanded="false" aria-controls="fin-body-budget">Budget</button>
            <div id="fin-body-budget" hidden>${form}</div>
          </div>
        </section>
      </section>
    </body></html>`,
    { url: "http://localhost/" },
  );
  const scrolled: any[] = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: any) {
    scrolled.push(this);
  };
  bindEnterBudget(dom.window.document);
  return { document: dom.window.document, scrolled };
}

describe("budget form editability", () => {
  it("lets owner, manager, and project manager enter the first budget after the freeze gate", () => {
    for (const role of ["owner", "manager", "project_manager"] as const) {
      expect(
        budgetFormEditable({
          canEdit: can(role, "edit_budget_before_freeze"),
          frozen: true,
          entered: false,
        }),
      ).toBe(true);
    }
    expect(
      budgetFormEditable({ canEdit: can("office", "edit_budget_before_freeze"), frozen: true, entered: false }),
    ).toBe(false);
    expect(
      budgetFormEditable({ canEdit: can("bookkeeper", "edit_budget_before_freeze"), frozen: true, entered: false }),
    ).toBe(false);
    expect(
      budgetFormEditable({ canEdit: can("owner", "edit_budget_before_freeze"), frozen: true, entered: true }),
    ).toBe(false);
  });
});

describe("Enter budget", () => {
  it.each(["owner", "manager", "project_manager"] as const)(
    "opens the section and focuses an enabled contract field for %s",
    (role) => {
      const { document, scrolled } = financialsPage(role);
      document.getElementById("enter-budget")!.click();

      const contract = document.getElementById("budget-contract");
      expect(can(role, "edit_budget_before_freeze")).toBe(true);
      expect(document.getElementById("page-financials")!.hidden).toBe(false);
      expect(document.getElementById("outer-body")!.hidden).toBe(false);
      expect(document.getElementById("fin-body-budget")!.hidden).toBe(false);
      expect(
        document.querySelector('[aria-controls="outer-body"]')!.getAttribute("aria-expanded"),
      ).toBe("true");
      expect(
        document.querySelector('[aria-controls="fin-body-budget"]')!.getAttribute("aria-expanded"),
      ).toBe("true");
      expect(contract.disabled).toBe(false);
      expect(document.getElementById("budget-save")).not.toBeNull();
      expect(document.activeElement).toBe(contract);
      expect(scrolled[0]).toBe(contract);
    },
  );

  it("keeps the contract field disabled for a role that cannot edit the budget", () => {
    const { document, scrolled } = financialsPage("office");
    document.getElementById("enter-budget")!.click();
    const contract = document.getElementById("budget-contract");
    expect(can("office", "edit_budget_before_freeze")).toBe(false);
    expect(contract.disabled).toBe(true);
    expect(document.getElementById("budget-save")).toBeNull();
    expect(document.getElementById("use-st-estimate")).toBeNull();
    expect(document.getElementById("fin-body-budget")!.hidden).toBe(false);
    expect(document.getElementById("outer-body")!.hidden).toBe(false);
    expect(document.activeElement).not.toBe(contract);
    expect(scrolled[0]).toBe(contract);
  });
});

describe("Use ST estimate", () => {
  it("prefills the loaded sold-estimate figures and does not save", () => {
    const dom = new JSDOM(
      `<!doctype html><body>${budgetEntryHtml(
        { contract_value: 18640, subcontractor: 50 },
        { editable: true, soldEstimate },
      )}</body>`,
      { url: "http://localhost/" },
    );
    const { document } = dom.window;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    let submitted = 0;
    document.getElementById("budget-entry-form")!.addEventListener("submit", (event: { preventDefault(): void }) => {
      event.preventDefault();
      submitted += 1;
    });
    bindSoldEstimateButton(document);
    document.getElementById("use-st-estimate")!.click();

    expect(document.getElementById("budget-contract").value).toBe("83432.65");
    expect(document.getElementById("budget-materials").value).toBe("29096.57");
    expect(document.getElementById("budget-labor").value).toBe("0");
    expect(document.getElementById("budget-hours").value).toBe("0");
    expect(document.getElementById("budget-sub").value).toBe("50");
    expect(document.getElementById("budget-other").value).toBe("");
    expect(document.getElementById("budget-total")!.textContent).toBe("$29,146.57");
    expect(document.getElementById("budget-st-note")!.textContent).toContain("Nothing is saved");
    expect(submitted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("omits the button when there is no sold estimate or the form cannot be edited", () => {
    expect(budgetEntryHtml(null, { editable: true })).not.toContain("use-st-estimate");
    expect(budgetEntryHtml(null, { editable: false, soldEstimate })).not.toContain("use-st-estimate");
    expect(budgetEntryHtml(null, { editable: false, frozen: true, soldEstimate })).toContain("disabled");
  });
});
