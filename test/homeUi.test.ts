import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dueListHtml,
  homeShellHtml,
  landingChoice,
  projectTableHtml,
} from "../client/home.js";

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );

describe("home landing", () => {
  it("opens a project deep link and otherwise stays on home", () => {
    expect(
      landingChoice({
        search: "",
        hash: "",
        rememberedProjectId: "remembered",
        projectPages: ["dashboard", "plan"],
      }),
    ).toEqual({ kind: "home" });
    expect(
      landingChoice({
        search: "?project=proj-1",
        hash: "#plan",
        projectPages: ["plan"],
      }).kind,
    ).toBe("project");
    expect(
      landingChoice({
        search: "?project=proj-1",
        hash: "#plan",
        projectPages: ["plan"],
      }),
    ).toMatchObject({ projectId: "proj-1" });
    expect(
      landingChoice({
        search: "",
        hash: "#financials",
        rememberedProjectId: "remembered",
        projectPages: ["financials", "plan"],
      }),
    ).toMatchObject({ kind: "project", projectId: "remembered" });
    expect(
      landingChoice({
        search: "",
        hash: "#home",
        rememberedProjectId: "remembered",
        projectPages: ["dashboard"],
      }).kind,
    ).toBe("home");
  });

  it("keeps the new hand-offs slot in the layout and empty", () => {
    const html = homeShellHtml();
    const slot = html.match(/data-slot="new-handoffs"[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(slot).toContain("hidden");
    expect(slot).toContain("data-handoff-body");
    expect(slot).not.toContain("<li");
    expect(slot).not.toContain("<tr");
    expect(slot).not.toMatch(/example|sample|fake/i);
    expect(readFileSync("client/workspace.js", "utf8")).toContain('data-page="home"');
    expect(readFileSync("client/index.html", "utf8")).toContain('id="home"');
  });

  it("labels due rows and keeps completed distinct from cancelled", () => {
    const table = projectTableHtml(
      [
        {
          id: "p1",
          name: "Finished",
          project_number: "1",
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
    expect(table).toContain("Completed");
    expect(table).not.toContain("Cancelled");
    const due = dueListHtml(
      [
        {
          project_name: "Whitfield — Primary Bath",
          item_type: "wbs_task",
          title: "Schedule the inspection",
          due_on: "2026-10-22",
          overdue: true,
          owner_name: "D. Reyes",
          href: "/?project=p&plan=tasks&item=t#plan",
        },
        {
          project_name: "Whitfield — Primary Bath",
          item_type: "precon_task",
          title: "Subs booked",
          due_on: "2026-10-26",
          overdue: false,
          owner_role: "project_manager",
          href: "/?project=p&item=t#precon-permits",
        },
      ],
      esc,
    );
    expect(due.indexOf("Overdue")).toBeLessThan(due.indexOf("Due today"));
    expect(due).toContain("WBS task");
    expect(due).toContain("Precon task");
    expect(due).toContain("Project Coordinator");
    expect(due).not.toContain("Gantt");
  });
});
