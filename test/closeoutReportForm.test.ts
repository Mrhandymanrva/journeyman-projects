import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  closeoutReportHtml,
  closeoutReportPayload,
  reportFormState,
} from "../client/closeoutReport.js";
import {
  closeoutReportAvailable,
  missingFinalFields,
  redactCosts,
  type CloseoutSummaryBody,
  type PulledSnapshot,
} from "../src/domain/closeoutSummary.js";
import {
  buildCloseoutReportBlocks,
  closeoutReportHtml as reportPage,
  renderCloseoutReportPdf,
} from "../src/domain/closeoutSummaryExport.js";

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );

function pulled(costs: PulledSnapshot["costs"]): PulledSnapshot {
  return {
    pulled_at: "2026-11-10T15:00:00.000Z",
    currency: "USD",
    cover: {
      name: "Whitfield Primary Bath",
      project_number: "MHR-2026-1044",
      address: "4412 Grove Avenue, Richmond, VA, 23221",
      customer: "Whitfield Household",
      stage: "closeout",
      pm_name: "Pat Manager",
    },
    scope: {
      summary: "Primary bath remodel",
      charter_documents: ["Scope of work"],
    },
    schedule: {
      scheduled_start: "2026-08-01",
      scheduled_end: "2026-09-01",
      field_start: "2026-08-03",
      actual_start: "2026-08-04",
      actual_end: null,
      plan_baseline_start: null,
      plan_baseline_finish: null,
      milestones: [
        {
          title: "Tile set",
          due_on: "2026-08-20",
          completed_on: "2026-08-22",
          state: "complete",
        },
      ],
      tasks: [
        {
          title: "Set tile",
          start_on: "2026-08-10",
          due_on: "2026-08-18",
          completed_on: "2026-08-19",
          state: "complete",
        },
      ],
      items: [],
    },
    costs,
    risks: [
      {
        description: "Tile delay: Supplier lead time",
        impact: 4,
        probability: 3,
        mitigation: "Order early",
        roam: "mitigated",
      },
    ],
    communications: [
      {
        audience: "Customer",
        channel: "phone",
        cadence: "weekly",
        notes: "Friday afternoon",
      },
    ],
    suggested_roles: [
      {
        name: "Pat Manager",
        role: "Project manager",
        responsibilities: "Runs the job.",
        source: "pm",
      },
    ],
    closeout: {
      punch_done: true,
      punch_note: "Tile edge",
      photos_done: false,
      photos_note: null,
      final_draw_invoice_number: "1184",
      warranty_start_on: "2026-11-01",
      review_request_note: null,
      photo_document_count: 1,
      closeout_document_count: 2,
      gate_4_status: "open",
    },
    daily_logs: { count: 1, first_on: "2026-08-12", last_on: "2026-08-12" },
  };
}

const costs = {
  contract_value: 41800,
  budgeted_expense: 10380,
  actual_expense: null,
  labor_actual: null,
  materials_actual: null,
  subcontractor_actual: null,
  budgeted_labor: 3200,
  budgeted_materials: 1980,
  budgeted_subcontractor: 5200,
  budgeted_margin: 31420,
  budgeted_margin_percent: 75.17,
  actual_margin: null,
  actual_margin_percent: null,
  committed_open: 0,
  total_committed: 0,
  variance: 0,
  approved_change_orders: 2400,
  purchase_orders: { count: 1, total: 500 },
  vendor_bills: { count: 1, total: 125.5 },
};

function view(partial: Record<string, unknown> = {}) {
  return {
    available: true,
    today: "2026-11-10",
    can_edit: true,
    can_view_costs: true,
    finalized: false,
    summary: null,
    pulled: pulled(costs),
    ...partial,
  };
}

describe("final project report form", () => {
  it("stays a one-line note until closeout or Gate 4", () => {
    expect(
      closeoutReportAvailable({
        stage: "execution",
        gate4Status: "open",
        gate4Progress: false,
      }),
    ).toBe(false);
    expect(
      closeoutReportAvailable({
        stage: "closeout",
        gate4Status: "open",
        gate4Progress: false,
      }),
    ).toBe(true);
    expect(
      closeoutReportAvailable({
        stage: "complete",
        gate4Status: "open",
        gate4Progress: false,
      }),
    ).toBe(true);
    expect(
      closeoutReportAvailable({
        stage: "execution",
        gate4Status: "submitted",
        gate4Progress: false,
      }),
    ).toBe(true);
    expect(
      closeoutReportAvailable({
        stage: "handoff",
        gate4Status: "open",
        gate4Progress: true,
      }),
    ).toBe(true);

    const html = closeoutReportHtml(
      {
        available: false,
        can_view_costs: true,
        can_edit: true,
        pulled: pulled(costs),
      },
      { esc },
    );
    expect(html).toContain("Available when the project enters closeout.");
    expect(html).not.toContain("Download PDF");
    expect(html).not.toContain("$41,800.00");
  });

  it("follows the template and keeps learning outcomes optional", () => {
    const html = closeoutReportHtml(view(), { esc });
    const order = [
      "Final project report",
      "Roles and responsibilities",
      "1. Final project summary",
      "1.1 Content summary",
      "Schedule",
      "Costs and budget",
      "Risk",
      "Communication strategy and methods",
      "1.2 Lessons learned",
      "1.3 Learning outcomes",
      "1.4 Project performance summary",
      "1.5 Critical thinking review",
      "2. Post-mortem report",
      "Initial expectations",
      "Milestones",
      "Achievements and obstacles",
      "Root causes",
      "Key takeaways",
      "Action items",
      "Next steps",
    ];
    let at = -1;
    for (const heading of order) {
      const next = html.indexOf(heading);
      expect(next, heading).toBeGreaterThan(at);
      at = next;
    }
    expect(html).toContain(
      "Optional. Briefly summarize how the learning outcomes were met.",
    );
    expect(html).toContain("Optional. Specific problem-solving examples.");
    expect(html).toContain("Required to finalize.");
    expect(html).toContain("Whitfield Household");
    expect(html).toContain("Scope of work");
    expect(html).toContain("$41,800.00");
    expect(html).toContain("Actual margin");
    expect(html).toContain("1 entry");
    expect(html).toContain('id="fpr-save"');
    expect(html).toContain('id="fpr-finalize"');
    expect(html).toContain('id="fpr-pdf"');
    expect(html).toContain('id="fpr-print"');
    expect(html).not.toContain("DO_NOT_LEAK");
  });

  it("hides cost, margin, and the PDF from someone without margin access", () => {
    const html = closeoutReportHtml(
      view({ can_view_costs: false, can_edit: false }),
      { esc },
    );
    expect(html).toContain("Cost and margin are hidden.");
    expect(html).not.toContain("$41,800.00");
    expect(html).not.toContain("Actual margin");
    expect(html).not.toContain('id="fpr-pdf"');
    expect(html).not.toContain('id="fpr-print"');
    expect(html).not.toContain('id="fpr-save"');
    expect(html).toContain("Lessons learned");
    expect(html).toContain("disabled");
  });

  it("makes a finalized report read-only and still offers the PDF", () => {
    const html = closeoutReportHtml(
      view({
        can_edit: false,
        finalized: true,
        finalized_label: "Nov 10, 2026, 9:00 AM ET",
        summary: {
          report_date: "2026-11-10",
          narrative: { lessons_learned: "Order tile earlier." },
        },
      }),
      { esc },
    );
    expect(html).toContain("This report is read-only.");
    expect(html).toContain("Order tile earlier.");
    expect(html).not.toContain('id="fpr-save"');
    expect(html).not.toContain('id="fpr-finalize"');
    expect(html).toMatch(/id="fpr-refresh"[^>]*disabled/);
    expect(html).toContain('id="fpr-pdf"');
    expect(html).toContain("<textarea");
    expect(html).toContain("disabled");
  });

  it("reads the narrative the project manager typed", () => {
    const html = closeoutReportHtml(view(), { esc });
    const dom = new JSDOM(`<div id="host">${html}</div>`);
    const root = dom.window.document.getElementById("host")!;
    const lessons = root.querySelector(
      "[data-field='narrative.lessons_learned']",
    ) as { value: string };
    lessons.value = "Order tile earlier.";
    const takeaways = root.querySelector(
      "[data-field='post_mortem.key_takeaways']",
    ) as { value: string };
    takeaways.value = "Confirm lead times at award.";
    const thinking = root.querySelector(
      "[data-field='narrative.critical_thinking']",
    ) as { value: string };
    expect(thinking.value).toBe("");
    const payload = closeoutReportPayload(root);
    expect(payload.narrative.lessons_learned).toBe("Order tile earlier.");
    expect(payload.narrative.critical_thinking).toBe("");
    expect(payload.narrative.learning_outcomes_summary).toBe("");
    expect(payload.post_mortem.key_takeaways).toBe(
      "Confirm lead times at award.",
    );
    expect(payload.roles[0]).toMatchObject({
      name: "Pat Manager",
      role: "Project manager",
    });
    expect(payload.risks[0]).toMatchObject({
      description: "Tile delay: Supplier lead time",
      impact: 4,
    });
    expect(payload.version).toBe(1);
  });

  it("refreshes pulled rows and keeps the narrative draft", () => {
    const state = reportFormState(view(), {
      preferLive: true,
      draft: {
        report_date: "2026-11-09",
        narrative: { lessons_learned: "Typed and not saved" },
        post_mortem: { key_takeaways: "Still typing" },
      },
    });
    expect(state.live).toBe(true);
    expect(state.narrative.lessons_learned).toBe("Typed and not saved");
    expect(state.postText.key_takeaways).toBe("Still typing");
    expect(state.risks[0]?.description).toContain("Tile delay");
    expect(state.reportDate).toBe("2026-11-09");
  });
});

describe("final project report document", () => {
  const body: CloseoutSummaryBody = {
    version: 1,
    report_date: "2026-11-10",
    roles: [
      {
        name: "Pat Manager",
        role: "Project manager",
        responsibilities: "Runs the job.",
      },
    ],
    narrative: {
      scope: "Bath remodel narrative",
      schedule_commentary: "Started late.",
      cost_commentary: "Margin held.",
      lessons_learned: "Order tile earlier.",
      learning_outcomes_summary: "",
      performance_summary: "The crew stayed in touch.",
      critical_thinking: "",
    },
    risks: pulled(costs).risks,
    communications: pulled(costs).communications,
    learning_outcomes: [],
    post_mortem: {
      initial_expectations: "Finish in August.",
      milestones: [
        {
          title: "Tile set",
          due_on: "2026-08-20",
          completed_on: "2026-08-22",
          state: "complete",
          note: "",
        },
      ],
      achievements_obstacles: "The tile work was clean. The grout was late.",
      roadblocks: "Lead time.",
      additional_resources: "",
      root_causes: "The supplier date was taken on faith.",
      key_takeaways: "Confirm lead times at award.",
      action_items: "Add lead time to the buyout checklist.",
      next_steps: "Walk the warranty items next week.",
    },
  };

  it("does not require learning outcomes or critical thinking", () => {
    expect(missingFinalFields(body)).toEqual({});
    const empty = missingFinalFields({
      ...body,
      narrative: { ...body.narrative, lessons_learned: "  " },
      post_mortem: { ...body.post_mortem, key_takeaways: "" },
    });
    expect(empty["narrative.lessons_learned"]).toBeTruthy();
    expect(empty["post_mortem.key_takeaways"]).toBeTruthy();
    expect(empty["narrative.critical_thinking"]).toBeUndefined();
  });

  it("drops cost and margin when the reader cannot see them", () => {
    const hidden = redactCosts(pulled(costs), false);
    expect(hidden.costs).toBeNull();
    expect(hidden.cover.name).toBe("Whitfield Primary Bath");
    const blocks = buildCloseoutReportBlocks({
      company: "Journeyman",
      body,
      pulled: hidden,
    });
    const text = JSON.stringify(blocks);
    expect(text).not.toContain("Actual margin");
    expect(text).not.toContain("41,800");
    expect(text).toContain("Order tile earlier.");
    expect(text).toContain("Roles and responsibilities");
    expect(text).toContain("1.5 Critical thinking review");
    expect(text).toContain("2. Post-mortem report");
  });

  it("renders an internal PDF that names the project", async () => {
    const source = {
      company: "Journeyman Projects",
      body,
      pulled: pulled(costs),
    };
    const html = reportPage(source);
    expect(html).toContain("Whitfield Primary Bath");
    expect(html).toContain("FINAL PROJECT REPORT");
    expect(html).toContain(
      "Internal closeout report · not for the customer · MHR-2026-1044",
    );
    expect(html).toContain("$41,800.00");
    expect(html).toContain("@media print");
    const bytes = await renderCloseoutReportPdf(source);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.includes(Buffer.from("Whitfield Primary Bath"))).toBe(true);
    expect(bytes.includes(Buffer.from("Internal closeout report"))).toBe(true);
    expect(bytes.length).toBeGreaterThan(2000);
  });
});
