import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  closeoutReportHtml,
  closeoutReportPayload,
  reportFormState,
} from "../client/closeoutReport.js";
import { openCloseoutSection } from "../client/financialsSections.js";
import { projectTableHtml } from "../client/home.js";
import {
  closeoutReportAvailable,
  closeoutReportWarnings,
  missingFinalFields,
  redactCosts,
  showCloseoutDraftBanner,
  type CloseoutSummaryBody,
  type CloseoutWarningInput,
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

const openWarnings: CloseoutWarningInput = {
  stage: "execution",
  finalized: false,
  actualEnd: null,
  punchDone: false,
  photosDone: false,
  finalDrawInvoice: null,
  warrantyStart: null,
  reviewRequest: "  ",
  lessonsLearned: "",
  achievementsObstacles: "",
  rootCauses: "",
  keyTakeaways: "",
  actionItems: "",
  nextSteps: "",
};

describe("final project report form", () => {
  it("is available at every stage and lists what is still open", () => {
    expect(
      closeoutReportAvailable({
        stage: "execution",
        gate4Status: "open",
        gate4Progress: false,
      }),
    ).toBe(true);
    expect(closeoutReportAvailable({ stage: "handoff" })).toBe(true);
    expect(closeoutReportAvailable()).toBe(true);
    const warnings = closeoutReportWarnings(openWarnings);
    expect(warnings).toEqual([
      "The project is not in closeout or complete.",
      "Punch list is still open.",
      "Final photos are not filed.",
      "Final draw invoice is not recorded.",
      "Warranty start is not set.",
      "Review request is not recorded.",
      "Actual end date is not set.",
      "Lessons learned is empty.",
      "Achievements and obstacles is empty.",
      "Root causes is empty.",
      "Key takeaways is empty.",
      "Action items is empty.",
      "Next steps is empty.",
    ]);
    expect(showCloseoutDraftBanner(false, [])).toBe(true);
    expect(showCloseoutDraftBanner(true, ["Punch list is still open."])).toBe(
      true,
    );
    expect(showCloseoutDraftBanner(true, [])).toBe(false);
    expect(
      closeoutReportWarnings({
        ...openWarnings,
        stage: "closeout",
        actualEnd: "2026-08-28",
        punchDone: true,
        photosDone: true,
        finalDrawInvoice: "1184",
        warrantyStart: "2026-11-01",
        reviewRequest: "Ask after the walkthrough",
        lessonsLearned: "Order tile earlier.",
        achievementsObstacles: "The tile was clean.",
        rootCauses: "Lead time.",
        keyTakeaways: "Confirm dates.",
        actionItems: "Update the checklist.",
        nextSteps: "Walk the warranty.",
      }),
    ).toEqual([]);

    const html = closeoutReportHtml(
      view({ draft_banner: true, warnings, can_edit: true }),
      { esc },
    );
    expect(html).toContain('id="fpr-draft-banner"');
    expect(html).toContain("Draft, not final");
    expect(html).toContain("Punch list is still open.");
    expect(html).toContain("Lessons learned is empty.");
    expect(html).toContain("Download PDF");
    expect(html).not.toContain("Available when the project enters closeout.");
    const quiet = closeoutReportHtml(
      view({ finalized: true, draft_banner: false, warnings: [] }),
      { esc },
    );
    expect(quiet).not.toContain("Draft, not final");
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

describe("closeout report entry", () => {
  it("links every project row to the report and opens the closeout section", () => {
    const html = projectTableHtml(
      [
        {
          id: "handoff-1",
          name: "Early job",
          project_number: "1",
          customer: "Pat",
          stage: "handoff",
          lifecycle: "open",
          pm_name: "D. Reyes",
          health: { score: 90, band: "green", reasons: [] },
          next_milestone: null,
        },
        {
          id: "done-1",
          name: "Finished",
          project_number: "2",
          customer: "Pat",
          stage: "complete",
          lifecycle: "completed",
          pm_name: "D. Reyes",
          health: { score: 100, band: "green", reasons: [] },
          next_milestone: null,
        },
      ],
      esc,
    );
    expect(html).toContain('href="/?project=handoff-1#closeout-report"');
    expect(html).toContain('href="/?project=done-1#closeout-report"');
    expect(html.match(/Closeout report/g)).toHaveLength(2);
    const page = new JSDOM(
      `<button class="fin-section-toggle" aria-expanded="false" aria-controls="closeout">Closeout</button>
       <div id="closeout" hidden><section id="final-project-report">Report</section></div>`,
    );
    const opened = openCloseoutSection(page.window.document);
    expect(opened).toBe(true);
    const body = page.window.document.getElementById("closeout");
    expect(body?.hidden).toBe(false);
    expect(
      page.window.document
        .querySelector('[aria-controls="closeout"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
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

  it("prints the draft banner and omits it once nothing is missing", async () => {
    const source = {
      company: "Journeyman Projects",
      body,
      pulled: pulled(costs),
      finalized: false,
      warnings: [
        "The project is not in closeout or complete.",
        "Punch list is still open.",
      ],
    };
    const html = reportPage(source);
    expect(html.indexOf("Draft, not final")).toBeLessThan(
      html.indexOf("FINAL PROJECT REPORT"),
    );
    expect(html).toContain("Punch list is still open.");
    const bytes = await renderCloseoutReportPdf(source);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.includes(Buffer.from("Draft, not final"))).toBe(true);
    expect(bytes.includes(Buffer.from("Punch list is still open."))).toBe(true);
    const finished = await renderCloseoutReportPdf({
      ...source,
      finalized: true,
      warnings: [],
    });
    expect(finished.includes(Buffer.from("Draft, not final"))).toBe(false);
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
