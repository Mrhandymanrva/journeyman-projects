import { describe, expect, it } from "vitest";
import {
  GANTT_ROW_HEIGHT,
  UNPHASED,
  dependencyArrows,
  groupGanttRows,
  phaseProgress,
  renderGantt,
  type GanttRow,
} from "../client/gantt.js";
import { phaseFromPlanTaskLinks } from "../src/domain/planPhase.js";

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

const from = "2026-10-01";
const days = 28;

function row(
  partial: Partial<GanttRow> & Pick<GanttRow, "id" | "title" | "window_start" | "window_end">,
): GanttRow {
  return {
    project_id: "p",
    source: "plan",
    status: "proposed",
    dependencies: [],
    ...partial,
  };
}

const rows = [
  row({
    id: "a",
    title: "Set tile",
    phase: "Waterproofing and finishes",
    window_start: "2026-10-03",
    window_end: "2026-10-05",
    status: "complete",
  }),
  row({
    id: "b",
    title: "Paint",
    phase: "Waterproofing and finishes",
    window_start: "2026-10-06",
    window_end: "2026-10-09",
    status: "proposed",
  }),
  row({
    id: "st",
    title: "ST job 1 · 1",
    phase: "Waterproofing and finishes",
    window_start: "2026-10-04",
    window_end: "2026-10-04",
    status: "confirmed",
    source: "servicetitan",
  }),
  row({
    id: "c",
    title: "Rough electrical",
    phase: "Rough-in",
    window_start: "2026-10-10",
    window_end: "2026-10-12",
    status: "confirmed",
    dependencies: [{ predecessor_id: "a" }],
  }),
  row({
    id: "d",
    title: "ST job 9 · 1",
    phase: null,
    window_start: "2026-10-02",
    window_end: "2026-10-02",
    status: "confirmed",
    source: "servicetitan",
  }),
  row({
    id: "e",
    title: "Closeout walk",
    phase: "Closeout",
    window_start: "2026-10-20",
    window_end: "2026-10-21",
    status: "proposed",
    dependencies: [{ predecessor_id: "b" }, { predecessor_id: "missing" }],
  }),
];

describe("gantt phase grouping", () => {
  it("keeps first-seen phase order and puts Unphased last", () => {
    const groups = groupGanttRows(rows);
    expect(groups.map((group) => group.phase)).toEqual([
      "Waterproofing and finishes",
      "Rough-in",
      "Closeout",
      UNPHASED,
    ]);
    expect(groups[0]!.tasks.map((task) => task.id)).toEqual(["a", "b", "st"]);
    expect(groups.at(-1)!.tasks.map((task) => task.id)).toEqual(["d"]);
  });

  it("spans the summary bar from the earliest start to the latest finish", () => {
    const group = groupGanttRows(rows)[0]!;
    expect(group.start).toBe("2026-10-03");
    expect(group.end).toBe("2026-10-09");
    expect(group.progress).toBe(phaseProgress(group.tasks));
    expect(group.progress).toBe(38);
    const html = renderGantt({ rows, from, days, projectId: "p", editable: true, esc, today: from, collapsed: new Set() });
    expect(html).toContain('class="gantt-bar gantt-summary" style="left:72px;width:252px;');
    expect(html).toContain("38% complete");
    expect(html).toContain('class="gantt-progress" style="width:38%"');
  });

  it("puts a phased ServiceTitan visit with its plan phase and an unlinked visit in Unphased", () => {
    const groups = groupGanttRows(rows);
    const finishes = groups.find((group) => group.phase === "Waterproofing and finishes")!;
    const unphased = groups.find((group) => group.phase === UNPHASED)!;
    expect(finishes.tasks.map((task) => task.id)).toContain("st");
    expect(unphased.tasks.map((task) => task.id)).toEqual(["d"]);
    expect(groups.at(-1)!.phase).toBe(UNPHASED);
    const html = renderGantt({ rows, from, days, projectId: "p", editable: true, esc, today: from, collapsed: new Set() });
    expect(html).toContain('data-gantt-row="st"');
    expect(html).toContain('data-gantt-id="st" data-movable="false"');
    expect(html).not.toMatch(/data-gantt-id="st"[^>]*data-movable="true"/);
    expect(html).not.toContain('data-gantt-id="phase');
    const summary = html.slice(html.indexOf("gantt-summary"), html.indexOf("gantt-task-row"));
    expect(summary).not.toContain("data-movable");
    expect(summary).not.toContain("data-gantt-id");
  });

  it("maps dependency arrows to visible row centers, including a collapsed phase header", () => {
    const open = dependencyArrows(rows, { from, days, collapsed: new Set() });
    expect(open.layout.visual.map((item) => (item.kind === "phase" ? item.phase : item.task.id))).toEqual([
      "Waterproofing and finishes",
      "a",
      "b",
      "st",
      "Rough-in",
      "c",
      "Closeout",
      "e",
      UNPHASED,
      "d",
    ]);
    expect(open.layout.visual.map((item) => item.y)).toEqual(
      open.layout.visual.map((_, index) => index * GANTT_ROW_HEIGHT),
    );
    const toRough = open.arrows.find((arrow) => arrow.successorId === "c")!;
    expect(toRough).toMatchObject({ predecessorId: "a", x: 180, y: 144, x2: 324, y2: 528 });
    expect(toRough.d).toBe("M180,144 H190 V528 H321");
    const toCloseout = open.arrows.find((arrow) => arrow.successorId === "e")!;
    expect(toCloseout).toMatchObject({ predecessorId: "b", x: 324, y: 240, x2: 684, y2: 720 });
    expect(open.arrows.some((arrow) => arrow.predecessorId === "missing")).toBe(false);

    const collapsed = dependencyArrows(rows, { from, days, collapsed: new Set(["Closeout"]) });
    expect(collapsed.layout.visual.map((item) => (item.kind === "task" ? item.task.id : item.phase))).not.toContain("e");
    const rerouted = collapsed.arrows.find((arrow) => arrow.successorId === "e")!;
    expect(rerouted.y2).toBe(576 + GANTT_ROW_HEIGHT / 2);
    expect(rerouted.d).toBe("M324,240 H334 V624 H681");

    const both = dependencyArrows(
      [
        ...rows,
        row({
          id: "b2",
          title: "Seal",
          phase: "Waterproofing and finishes",
          window_start: "2026-10-06",
          window_end: "2026-10-07",
          dependencies: [{ predecessor_id: "a" }],
        }),
      ],
      { from, days, collapsed: new Set(["Waterproofing and finishes"]) },
    );
    expect(both.arrows.some((arrow) => arrow.predecessorId === "a" && arrow.successorId === "b2")).toBe(false);
    const stillCrosses = both.arrows.find((arrow) => arrow.successorId === "c")!;
    expect(stillCrosses.y).toBe(GANTT_ROW_HEIGHT / 2);
    expect(stillCrosses.x).toBe(180);

    const html = renderGantt({
      rows,
      from,
      days,
      projectId: "p",
      editable: true,
      esc,
      today: from,
      collapsed: new Set(["Closeout"]),
    });
    expect(html).not.toContain('data-gantt-row="e"');
    expect(html).toContain('data-gantt-collapse="Closeout" aria-expanded="false"');
    expect(html).toContain('d="M324,240 H334 V624 H681"');
    expect(html).toContain(`height="${collapsed.layout.height}"`);
  });

  it("treats a blank phase as Unphased and ignores cancelled duration", () => {
    const groups = groupGanttRows([
      row({ id: "blank", title: "Blank", phase: "  ", window_start: "2026-10-02", window_end: "2026-10-02", status: "complete" }),
      row({ id: "named", title: "Named", phase: "Closeout", window_start: "2026-10-08", window_end: "2026-10-08", status: "proposed" }),
      row({ id: "drop", title: "Dropped", phase: "Closeout", window_start: "2026-10-08", window_end: "2026-10-10", status: "cancelled" }),
    ]);
    expect(groups.map((group) => group.phase)).toEqual(["Closeout", UNPHASED]);
    expect(groups[0]!.progress).toBe(0);
    expect(groups[0]!.end).toBe("2026-10-10");
  });
});

describe("plan task phase link", () => {
  it("uses the only phase named by linked plan tasks", () => {
    expect(phaseFromPlanTaskLinks(["Waterproofing and finishes", "  ", null])).toBe(
      "Waterproofing and finishes",
    );
    expect(phaseFromPlanTaskLinks([" Rough-in ", "Rough-in"])).toBe("Rough-in");
    expect(phaseFromPlanTaskLinks(["Rough-in", "Closeout"])).toBeNull();
    expect(phaseFromPlanTaskLinks([null, "  "])).toBeNull();
    expect(phaseFromPlanTaskLinks([])).toBeNull();
  });
});
