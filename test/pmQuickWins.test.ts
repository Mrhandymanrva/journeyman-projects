import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GOAL_KEY_RESULT_EXAMPLE,
  goalKeyResultHelpHtml,
} from "../client/goalHelp.js";
import { roleTitle } from "../client/roleTitles.js";
import {
  SCHEDULE_PROGRESS_CAPTION,
  appointmentReadWindow,
  scheduleProgress,
} from "../client/scheduleProgress.js";
import {
  knownProjectFacts,
  projectTemplates,
  templateContent,
} from "../client/projectTemplates.js";
import {
  LABOR_PAGE_ID,
  PRECON_ROLE_NOTE,
  PROJECT_PAGE_ALIASES,
  PROJECT_PAGE_ID,
  PROJECT_PAGE_ORDER,
  SHOW_COMMUNICATIONS_TAB,
  navEntries,
  workspacePages,
} from "../client/workspaceNav.js";

const today = "2026-10-26";

describe("schedule progress", () => {
  it("counts Gantt activities, ServiceTitan appointments, and precon tasks as one schedule", () => {
    const progress = scheduleProgress({
      today,
      activities: [
        {
          id: "a1",
          title: "Set tile",
          window_start: "2026-10-20",
          window_end: "2026-10-26",
          status: "confirmed",
        },
        {
          id: "a2",
          title: "Painting",
          window_start: "2026-11-02",
          window_end: "2026-11-04",
          status: "proposed",
        },
        {
          id: "a3",
          title: "Walkthrough",
          window_start: "2026-10-26",
          window_end: "2026-10-28",
          status: "complete",
        },
        {
          id: "a4",
          title: "Cancelled work",
          window_start: "2026-10-26",
          window_end: "2026-10-26",
          status: "cancelled",
        },
      ],
      appointments: [
        {
          id: "st1",
          title: "ST job · DEMO-1",
          window_start: "2026-10-28",
          window_end: "2026-10-28",
          status: "confirmed",
        },
        {
          id: "st2",
          title: "Finished appointment",
          window_start: "2026-10-01",
          window_end: "2026-10-01",
          status: "complete",
        },
        {
          id: "st3",
          title: "Cancelled appointment",
          window_start: "2026-10-27",
          window_end: "2026-10-27",
          status: "cancelled",
        },
      ],
      preconTasks: [
        { id: "p1", title: "Permit application", due_on: "2026-11-01", status: "not_started" },
        { id: "p2", title: "Plans", due_on: "2026-11-02", status: "in_progress" },
        { id: "p3", title: "Selections", due_on: null, status: "done" },
        { id: "p4", title: "Site visit", due_on: "2026-10-26", status: "waived" },
      ],
    });

    expect(progress.caption).toBe(SCHEDULE_PROGRESS_CAPTION);
    expect(progress.total).toBe(9);
    expect(progress.complete).toBe(4);
    expect(progress.percent).toBe(44);
    expect(progress.week.map((row) => row.title)).toEqual([
      "Set tile",
      "Site visit",
      "Walkthrough",
      "ST job · DEMO-1",
      "Permit application",
    ]);
    expect(progress.week.every((row) => row.start >= today && row.start <= "2026-11-01" || row.end >= today)).toBe(true);
  });

  it("leaves progress blank when the schedule is empty and ignores undated precon in the next 7 days", () => {
    const progress = scheduleProgress({
      today,
      preconTasks: [{ id: "p", title: "No date", due_on: null, status: "not_started" }],
    });
    expect(progress.percent).toBe(0);
    expect(progress.total).toBe(1);
    expect(progress.week).toEqual([]);
    expect(scheduleProgress({ today }).percent).toBeNull();
  });

  it("asks ServiceTitan for a window that includes the next 7 days and stays within 63 days", () => {
    expect(appointmentReadWindow(today)).toEqual({
      from: "2026-10-26",
      to: "2026-11-01",
    });
    expect(
      appointmentReadWindow(today, {
        scheduled_start: "2026-10-01",
        scheduled_end: "2026-11-20",
      }),
    ).toEqual({ from: "2026-10-01", to: "2026-11-20" });
    const wide = appointmentReadWindow(today, {
      scheduled_start: "2026-01-01",
      scheduled_end: "2026-12-31",
    });
    const span =
      (Date.parse(wide.to + "T12:00:00Z") - Date.parse(wide.from + "T12:00:00Z")) /
      86400000;
    expect(span).toBeLessThanOrEqual(62);
    expect(wide.from <= today).toBe(true);
    expect(wide.to >= "2026-11-01").toBe(true);
  });
});

describe("goal key results", () => {
  it("explains start, target, current, and unit with an example", () => {
    const help = goalKeyResultHelpHtml();
    expect(help).toContain("start");
    expect(help).toContain("target");
    expect(help).toContain("current");
    expect(help).toContain("unit");
    expect(help).toContain(GOAL_KEY_RESULT_EXAMPLE);
    expect(GOAL_KEY_RESULT_EXAMPLE).toContain("start 0");
    expect(GOAL_KEY_RESULT_EXAMPLE).toContain("target 1");
    expect(GOAL_KEY_RESULT_EXAMPLE).toContain("current 0");
    expect(GOAL_KEY_RESULT_EXAMPLE).toContain("inspections");
    expect(readFileSync("client/projectControls.js", "utf8")).toContain(
      "goalKeyResultHelpHtml",
    );
  });
});

describe("precon and permits tab", () => {
  it("renames the tab, keeps the old hash as a redirect, and leads with coordinator work", () => {
    expect(workspacePages[PROJECT_PAGE_ID]?.[0]).toBe("Precon & permits");
    expect(PROJECT_PAGE_ALIASES).toContain("project");
    expect(PROJECT_PAGE_ORDER.slice(0, 3)).toEqual(["precon", "permits", "gates"]);
    expect(LABOR_PAGE_ID).toBe("financials");
    expect(PRECON_ROLE_NOTE).toContain("Project Coordinator");
    expect(PRECON_ROLE_NOTE).toContain("Richmond GM");
    expect(PRECON_ROLE_NOTE).not.toMatch(/Wes|Mason/);
    expect(roleTitle("project_manager")).toBe("Project Coordinator");
    expect(roleTitle("manager")).toBe("Richmond GM");
    const workspace = readFileSync("client/workspace.js", "utf8");
    expect(workspace).toContain("PROJECT_PAGE_ALIASES");
    expect(workspace).toContain("LABOR_PAGE_ID");
    expect(workspace).not.toContain("Project details & permits");
  });
});

describe("communications tab", () => {
  it("stays in the app and stays out of the nav until the flag is turned on", () => {
    expect(SHOW_COMMUNICATIONS_TAB).toBe(false);
    expect(workspacePages.communications?.[0]).toBe("Communications");
    expect(navEntries().map(([id]) => id)).not.toContain("communications");
    expect(navEntries(true).map(([id]) => id)).toContain("communications");
    expect(readFileSync("client/workspace.js", "utf8")).toContain(
      "SHOW_COMMUNICATIONS_TAB",
    );
  });
});

describe("document templates", () => {
  it("keeps every section and fills facts the project already has", () => {
    const project = {
      project_number: "DMO-2026-0184",
      name: "Whitfield — Primary Bath",
      source_customer_name: "Ada Whitfield",
      address_line1: "4412 Grove Avenue",
      city: "Richmond",
      region: "VA",
      postal_code: "23221",
      contract_value: 41800,
      scheduled_start: "2026-10-07",
      scheduled_end: "2026-11-12",
      actual_start: "2026-10-08",
      field_start: { date: "2026-10-20" },
      sold_estimates: [{ name: "Customer upgraded the tile", customer_amount: 2400 }],
      permit_summary: [
        {
          permit_type: "Building",
          permit_number: "BLD-26-4471",
          issued_on: "2026-10-08",
          not_required: false,
        },
      ],
    };
    const text = templateContent("charter", project);
    expect(projectTemplates.charter?.sections).toHaveLength(12);
    for (const section of projectTemplates.charter?.sections ?? []) {
      expect(text).toContain("## " + section);
    }
    expect(text).toContain("Ada Whitfield");
    expect(text).toContain("4412 Grove Avenue, Richmond, VA, 23221");
    expect(text).toContain("$41,800.00");
    expect(text).toContain("Customer upgraded the tile");
    expect(text).toContain("$2,400.00");
    expect(text).toContain("2026-10-07");
    expect(text).toContain("2026-10-20");
    expect(text).toContain("BLD-26-4471");
    expect(text).toContain("issued 2026-10-08");
  });

  it("leaves unknown facts blank and does not drop sections from any template", () => {
    const text = templateContent("charter", { project_number: "X", name: "Y" });
    expect(text).toMatch(/^- Customer:\s*$/m);
    expect(text).toMatch(/^- Service address:\s*$/m);
    expect(text).toMatch(/^- Contract amount:\s*$/m);
    expect(text).toMatch(/^- Estimate amount:\s*$/m);
    expect(text).toMatch(/^- Permits:\s*$/m);
    expect(knownProjectFacts({})).toContain("- Field start: ");
    for (const template of Object.values(projectTemplates)) {
      const body = templateContent(
        Object.keys(projectTemplates).find((key) => projectTemplates[key] === template)!,
        null,
      );
      for (const section of template.sections) expect(body).toContain("## " + section);
    }
  });
});
