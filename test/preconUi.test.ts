import { describe, expect, it } from "vitest";
import {
  bindFieldStart,
  fieldReleaseHtml,
  fieldStartHtml,
} from "../client/fieldRelease.js";
import { bindPrecon, preconHtml } from "../client/precon.js";
import {
  officeCardHtml,
  officeDirectoryHtml,
} from "../client/permitOffices.js";

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );

class FakeEl {
  disabled = false;
  value = "";
  textContent = "";
  dataset: Record<string, string> = {};
  private listeners: Record<
    string,
    Array<(event: { preventDefault: () => void }) => void>
  > = {};
  addEventListener(
    type: string,
    fn: (event: { preventDefault: () => void }) => void,
  ) {
    (this.listeners[type] ??= []).push(fn);
  }
  click() {
    return this.emit("click");
  }
  submit() {
    return this.emit("submit");
  }
  emit(type: string) {
    return Promise.all(
      (this.listeners[type] ?? []).map((fn) =>
        Promise.resolve(fn({ preventDefault() {} })),
      ),
    );
  }
}

describe("field start", () => {
  it("shows the source and the refresh and override controls", () => {
    const html = fieldStartHtml({
      fieldStart: {
        date: "2026-11-02",
        source: "servicetitan",
        observed_at: "2026-10-25T15:04:00.000Z",
      },
      canRefresh: true,
      canOverride: true,
      esc,
    });
    expect(html).toContain("Field start Nov 2, 2026 · ServiceTitan.");
    expect(html).toContain("field-start-refresh");
    expect(html).toContain("Save manual date");
    expect(html).toContain('data-source="servicetitan"');
    expect(html).not.toContain("set by hand");
  });

  it("explains a manual date and hides controls the role cannot use", () => {
    const html = fieldStartHtml({
      fieldStart: { date: "2026-11-03", source: "manual", observed_at: null },
      canRefresh: false,
      canOverride: false,
      esc,
    });
    expect(html).toContain("Manual");
    expect(html).toContain("set by hand");
    expect(html).not.toContain("field-start-refresh");
    expect(html).not.toContain("field-start-override");
  });

  it("puts a one-line field start on the field release panel", () => {
    const html = fieldReleaseHtml({
      release: { released: false },
      canRelease: false,
      esc,
      items: [],
      fieldStart: { date: "2026-12-01", source: "manual", observed_at: null },
    });
    expect(html).toContain("field-start-line");
    expect(html).toContain("Field start Dec 1, 2026 · Manual.");
    expect(html).not.toContain("field-start-refresh");
  });

  it("saves and clears a manual date", async () => {
    const date = new FakeEl();
    date.value = "2026-11-02";
    const submit = new FakeEl();
    const clear = new FakeEl();
    const refresh = new FakeEl();
    const msg = new FakeEl();
    const form = new FakeEl();
    (
      form as FakeEl & { querySelector: (sel: string) => FakeEl | null }
    ).querySelector = (sel) =>
      sel === 'button[type="submit"]' ? submit : null;
    const root = {
      querySelector: (sel: string) =>
        ({
          ".field-start-refresh": refresh,
          ".field-start-date": date,
          ".field-start-override": form,
          ".field-start-clear": clear,
          ".field-start-msg": msg,
        })[sel] ?? null,
    };
    const overrides: Array<string | null> = [];
    let refreshed = 0;
    bindFieldStart(root, {
      onRefresh: () => {
        refreshed += 1;
      },
      onOverride: (value) => {
        overrides.push(value);
      },
    });
    await refresh.click();
    await form.submit();
    await clear.click();
    expect(refreshed).toBe(1);
    expect(overrides).toEqual(["2026-11-02", null]);
  });
});

describe("preconstruction checklist", () => {
  it("lists tasks, overdue, and the permit office", () => {
    const html = preconHtml({
      precon: {
        open: 1,
        overdue: 1,
        tasks: [
          {
            id: "task-1",
            type: "permit",
            title: "Permit application submitted",
            owner_role: "project_manager",
            due_on: "2026-10-01",
            status: "in_progress",
            overdue: true,
            notes: "Waiting on the reviewer",
            permit_number: "BLD-10",
            office: {
              name: "City of Richmond",
              office_name: "Planning and Development Review",
              main_phone: "804-646-6304",
              portal_url: "https://permits.rva.gov",
              website_url: null,
              inspection_method: "phone",
              inspection_phone: "804-646-6440",
              inspection_url: null,
              typical_review_days: 12,
              last_verified: "2026-10-01",
              work_requiring_permit: "Residential alterations",
              required_documents: null,
              plan_requirements: null,
              fee_notes: null,
            },
            inspections: [
              {
                result: "pending",
                scheduled_on: "2026-10-20",
                occurred_on: null,
                notes: null,
              },
            ],
          },
        ],
      },
      canEdit: true,
      esc,
    });
    expect(html).toContain("Permit application submitted");
    expect(html).toContain("Overdue");
    expect(html).toContain("Planning and Development Review");
    expect(html).toContain("https://permits.rva.gov");
    expect(html).toContain("Residential alterations");
    expect(html).toContain("data-precon-add");
    expect(html).not.toContain("data-precon-apply");
  });

  it("offers the template when the project has no tasks", () => {
    const html = preconHtml({
      precon: { open: 0, overdue: 0, tasks: [] },
      canEdit: true,
      esc,
    });
    expect(html).toContain("data-precon-apply");
    expect(html).toContain("No preconstruction tasks");
  });

  it("patches status from the checklist", async () => {
    const html = preconHtml({
      precon: {
        open: 1,
        overdue: 0,
        tasks: [
          {
            id: "task-9",
            type: "plans",
            title: "Plans or drawings",
            owner_role: "project_manager",
            due_on: null,
            status: "not_started",
            overdue: false,
            notes: null,
            office: null,
            inspections: [],
          },
        ],
      },
      canEdit: true,
      esc,
    });
    const select = new FakeEl();
    select.dataset.preconStatus = "task-9";
    select.value = "done";
    const root = {
      querySelector: () => null,
      querySelectorAll: (sel: string) =>
        sel === "[data-precon-status]" ? [select] : [],
    };
    const seen: Array<[string, string]> = [];
    bindPrecon(root, {
      onApply: () => undefined,
      onAdd: () => undefined,
      onEdit: () => undefined,
      onInspect: () => undefined,
      onStatus: (id: string, status: string) => {
        seen.push([id, status]);
      },
    });
    expect(html).toContain('data-precon-status="task-9"');
    await select.emit("change");
    expect(seen).toEqual([["task-9", "done"]]);
  });
});

describe("permit office directory", () => {
  const office = {
    id: "office-1",
    name: "City of Richmond",
    state: "VA",
    office_name: "Planning and Development Review",
    address_line1: "900 E Broad St",
    contact_phone: "804-646-6304",
    portal_url: "https://permits.rva.gov",
    website_url: "https://www.rva.gov",
    inspection_method: "phone",
    inspection_phone: "804-646-6440",
    last_verified: "2026-10-01",
    work_requiring_permit: "Residential alterations",
    contacts: [
      {
        id: "contact-1",
        name: "Alex Kim",
        title: "Plan reviewer",
        phone: "804-555-0100",
        email: "alex@example.test",
        notes: "handles residential plan review; call before 10am",
      },
    ],
  };

  it("shows every contact title and notes, and edit controls for managers", () => {
    const html = officeDirectoryHtml({ offices: [office], canEdit: true, esc });
    expect(html).toContain("Plan reviewer");
    expect(html).toContain("handles residential plan review; call before 10am");
    expect(html).toContain('data-contact-edit="contact-1"');
    expect(html).toContain('id="office-import"');
  });

  it("keeps the directory read-only for office staff", () => {
    const html = officeCardHtml(office, false, esc);
    expect(html).toContain("Alex Kim");
    expect(html).toContain("Plan reviewer");
    expect(html).not.toContain("data-contact-edit");
    expect(html).not.toContain("data-office-edit");
  });
});
