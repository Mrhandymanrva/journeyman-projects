import { addDays, windowSpan } from "./scheduleBoard.js";

export const GANTT_ROW_HEIGHT = 96;
export const UNPHASED = "Unphased";
const COLLAPSE_KEY = "jp-gantt-collapsed-phases";

export function phaseColor(phase) {
  let n = 0;
  for (const c of String(phase || UNPHASED)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return `var(--phase-${(n % 10) + 1})`;
}

export function phaseName(row) {
  const text = String(row?.phase ?? "").trim();
  return text || UNPHASED;
}

function day(value) {
  const match = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

export function inclusiveDays(start, end) {
  const a = day(start);
  const b = day(end);
  if (!a || !b) return 0;
  const n = Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000) + 1;
  return n > 0 ? n : 0;
}

/** Duration-weighted share of tasks whose status is complete. Cancelled tasks are left out. */
export function phaseProgress(tasks) {
  let weight = 0;
  let done = 0;
  for (const task of tasks) {
    if (task.status === "cancelled") continue;
    const days = inclusiveDays(task.window_start, task.window_end);
    if (days <= 0) continue;
    weight += days;
    if (task.status === "complete") done += days;
  }
  if (!weight) return 0;
  return Math.round((done / weight) * 100);
}

/**
 * Phases keep the order they first appear in `rows`. Unphased is always last.
 * Tasks keep their incoming order inside a phase.
 */
export function groupGanttRows(rows) {
  const order = [];
  const buckets = new Map();
  for (const row of rows) {
    const phase = phaseName(row);
    if (!buckets.has(phase)) {
      buckets.set(phase, []);
      order.push(phase);
    }
    buckets.get(phase).push(row);
  }
  const keys = order.filter((key) => key !== UNPHASED);
  if (buckets.has(UNPHASED)) keys.push(UNPHASED);
  return keys.map((phase) => {
    const tasks = buckets.get(phase);
    let start = day(tasks[0].window_start);
    let end = day(tasks[0].window_end);
    for (const task of tasks) {
      const taskStart = day(task.window_start);
      const taskEnd = day(task.window_end);
      if (taskStart && taskStart < start) start = taskStart;
      if (taskEnd && taskEnd > end) end = taskEnd;
    }
    return { phase, tasks, start, end, progress: phaseProgress(tasks) };
  });
}

export function loadCollapsed() {
  try {
    const raw = globalThis.localStorage?.getItem(COLLAPSE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value) => typeof value === "string"));
  } catch {
    return new Set();
  }
}

export function saveCollapsed(phases) {
  try {
    globalThis.localStorage?.setItem(COLLAPSE_KEY, JSON.stringify([...phases]));
  } catch {
    /* private mode and tests without storage still render */
  }
}

export function collapsedSet(collapsed) {
  if (collapsed instanceof Set) return collapsed;
  if (Array.isArray(collapsed)) return new Set(collapsed);
  return loadCollapsed();
}

export function ganttLayout(rows, collapsed) {
  const hidden = collapsedSet(collapsed);
  const groups = groupGanttRows(rows);
  const visual = [];
  for (const group of groups) {
    visual.push({
      kind: "phase",
      phase: group.phase,
      start: group.start,
      end: group.end,
      progress: group.progress,
      tasks: group.tasks,
      collapsed: hidden.has(group.phase),
      index: visual.length,
      y: visual.length * GANTT_ROW_HEIGHT,
    });
    if (hidden.has(group.phase)) continue;
    for (const task of group.tasks) {
      visual.push({
        kind: "task",
        task,
        phase: group.phase,
        index: visual.length,
        y: visual.length * GANTT_ROW_HEIGHT,
      });
    }
  }
  const taskY = new Map();
  const phaseY = new Map();
  for (const row of visual) {
    if (row.kind === "task") taskY.set(row.task.id, row.y);
    else phaseY.set(row.phase, row.y);
  }
  function anchorY(taskId) {
    if (taskY.has(taskId)) return taskY.get(taskId);
    const task = rows.find((row) => row.id === taskId);
    if (!task) return undefined;
    return phaseY.get(phaseName(task));
  }
  return { groups, visual, anchorY, height: visual.length * GANTT_ROW_HEIGHT };
}

/**
 * Dependency arrows follow the visible row. A task inside a collapsed phase
 * anchors on that phase header. An arrow whose ends share one header is omitted.
 */
export function dependencyArrows(rows, { from, days, collapsed }) {
  const layout = ganttLayout(rows, collapsed);
  const arrows = [];
  for (const row of rows) {
    for (const dep of row.dependencies ?? []) {
      const predecessor = rows.find((item) => item.id === dep.predecessor_id);
      if (!predecessor) continue;
      const y1 = layout.anchorY(predecessor.id);
      const y2 = layout.anchorY(row.id);
      if (y1 === undefined || y2 === undefined || y1 === y2) continue;
      const start = windowSpan(predecessor.window_start, predecessor.window_end, from, days);
      const end = windowSpan(row.window_start, row.window_end, from, days);
      if (!start || !end) continue;
      const x = (start.last + 1) * 36;
      const x2 = end.first * 36;
      const y = y1 + GANTT_ROW_HEIGHT / 2;
      const yTo = y2 + GANTT_ROW_HEIGHT / 2;
      arrows.push({
        predecessorId: predecessor.id,
        successorId: row.id,
        x,
        y,
        x2,
        y2: yTo,
        d: `M${x},${y} H${x + 10} V${yTo} H${Math.max(0, x2 - 3)}`,
      });
    }
  }
  return { layout, arrows };
}

export function renderGantt({ rows, from, days, projectId, editable, esc, today, collapsed }) {
  const width = days * 36;
  const { layout, arrows } = dependencyArrows(rows, { from, days, collapsed });
  const list = layout.visual
    .map((row) => {
      if (row.kind === "phase") return phaseRow(row, { from, days, width, esc });
      return taskRow(row.task, { from, days, width, projectId, editable, esc });
    })
    .join("");
  const paths = arrows.map((arrow) => `<path d="${arrow.d}" marker-end="url(#gantt-arrow)"/>`).join("");
  const legend = layout.groups
    .map(
      (group) =>
        `<span><i style="background:${phaseColor(group.phase)}"></i>${esc(group.phase)}</span>`,
    )
    .join("");
  const head = Array.from({ length: days }, (_, i) => {
    const d = addDays(from, i);
    return `<span class="${d === today ? "gantt-today" : ""}">${esc(d.slice(5))}</span>`;
  }).join("");
  return `<div class="gantt-legend">${legend}</div><p class="hint">Drag a task to move it; drag an edge to resize. Successors follow automatically, preserving duration and waiting time. Use Details & dependencies to link tasks. Dates use calendar days.</p><p id="gantt-status" role="status" aria-live="polite"></p><div class="gantt-scroll"><div style="width:${width + 260}px"><div class="gantt-head"><strong>Activity / stage</strong><div style="width:${width}px">${head}</div></div><div class="gantt-body">${list}<svg class="gantt-links" style="left:260px" width="${width}" height="${layout.height}" aria-hidden="true"><defs><marker id="gantt-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="var(--muted)"/></marker></defs>${paths}</svg></div></div></div>`;
}

function phaseRow(row, { from, days, width, esc }) {
  const span = windowSpan(row.start, row.end, from, days);
  const color = phaseColor(row.phase);
  const count = row.tasks.length;
  const label = `${count} ${count === 1 ? "activity" : "activities"} · ${row.progress}% complete`;
  const bar = span
    ? `<div class="gantt-bar gantt-summary" style="left:${span.first * 36}px;width:${span.length * 36}px;background:${color}" aria-label="${esc(row.phase)}, ${row.progress}% complete, ${esc(row.start)} to ${esc(row.end)}" title="${esc(row.phase)} · ${esc(row.start)} to ${esc(row.end)}"><span class="gantt-progress" style="width:${row.progress}%"></span><span>${esc(row.phase)}</span></div>`
    : "";
  return `<div class="gantt-row gantt-phase-row" data-gantt-phase="${esc(row.phase)}" data-gantt-y="${row.y}"><div class="gantt-label"><button type="button" class="gantt-phase-toggle" data-gantt-collapse="${esc(row.phase)}" aria-expanded="${row.collapsed ? "false" : "true"}"><span class="gantt-chevron" aria-hidden="true">${row.collapsed ? "▸" : "▾"}</span><strong>${esc(row.phase)}</strong></button><small>${esc(label)}</small><small>${esc(row.start)} → ${esc(row.end)}</small></div><div class="gantt-track" style="width:${width}px">${bar}</div></div>`;
}

function taskRow(row, { from, days, width, projectId, editable, esc }) {
  const span = windowSpan(row.window_start, row.window_end, from, days);
  const canMove = editable && row.project_id === projectId && row.source !== "servicetitan" && !["complete", "cancelled"].includes(row.status);
  const color = phaseColor(row.phase);
  const bar = span
    ? `<div class="gantt-bar" ${canMove ? 'tabindex="0" role="button"' : ""} data-gantt-id="${esc(row.id)}" data-movable="${canMove}" style="left:${span.first * 36}px;width:${span.length * 36}px;background:${color};opacity:${row.status === "complete" ? ".55" : "1"}" aria-label="${esc(row.title)}. ${canMove ? "Drag to move, or use left and right arrows. Shift plus arrows resizes the finish." : ""}" title="${esc(row.title)} · ${esc(row.window_start)} to ${esc(row.window_end)}">${canMove ? '<span class="gantt-handle" data-resize="start" title="Resize start"></span>' : ""}<span>${esc(row.title)}</span>${canMove ? '<span class="gantt-handle" data-resize="end" title="Resize finish"></span>' : ""}</div>`
    : "";
  const action =
    row.source === "servicetitan"
      ? "<small>ServiceTitan · use dispatch review to change</small>"
      : `<button class="btn sm" data-plan-edit="${esc(row.id)}">Details & dependencies</button>`;
  return `<div class="gantt-row gantt-task-row" data-gantt-row="${esc(row.id)}" data-gantt-y="${row.y}"><div class="gantt-label"><strong>${esc(row.title)}</strong><small>${esc(phaseName(row))} · ${esc(String(row.status).replaceAll("_", " "))}</small><small>${esc(row.window_start)} → ${esc(row.window_end)}</small>${action}</div><div class="gantt-track" style="width:${width}px">${bar}</div></div>`;
}

export function bindGantt(container, { rows, save, rerender }) {
  let busy = false;
  const status = () => container.querySelector("#gantt-status");
  async function apply(bar, row, delta, edge) {
    if (!delta || busy) return;
    const start = addDays(row.window_start, edge === "end" ? 0 : delta);
    const end = addDays(row.window_end, edge === "start" ? 0 : delta);
    if (start > end) {
      status().textContent = "Finish must be on or after start.";
      return;
    }
    busy = true;
    container.setAttribute("aria-busy", "true");
    status().textContent = "Saving dates and dependent tasks…";
    try {
      await save(row, { window_start: start, window_end: end });
    } catch (e) {
      if (status()) status().textContent = e.message;
    } finally {
      busy = false;
      container.removeAttribute("aria-busy");
    }
  }
  container.querySelectorAll("[data-gantt-collapse]").forEach((button) => {
    button.addEventListener("click", () => {
      const phase = button.getAttribute("data-gantt-collapse");
      if (!phase) return;
      const next = loadCollapsed();
      if (next.has(phase)) next.delete(phase);
      else next.add(phase);
      saveCollapsed(next);
      if (typeof rerender === "function") rerender();
    });
  });
  container.querySelectorAll('[data-movable="true"]').forEach((bar) => {
    const row = rows.find((item) => item.id === bar.dataset.ganttId);
    bar.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      e.preventDefault();
      void apply(bar, row, e.key === "ArrowLeft" ? -1 : 1, e.shiftKey ? "end" : null);
    });
    bar.addEventListener("pointerdown", (e) => {
      if (busy || e.button !== 0) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const x = e.clientX;
      const edge = e.target.dataset.resize;
      let delta = 0;
      const move = (ev) => {
        delta = Math.round((ev.clientX - x) / 36);
        bar.style.transform = `translateX(${edge ? 0 : delta * 36}px)`;
        status().textContent = `${row.title}: ${addDays(row.window_start, edge === "end" ? 0 : delta)} → ${addDays(row.window_end, edge === "start" ? 0 : delta)}`;
      };
      const finish = () => {
        bar.style.transform = "";
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", finish);
        bar.removeEventListener("pointercancel", cancel);
        void apply(bar, row, delta, edge);
      };
      const cancel = () => {
        delta = 0;
        bar.style.transform = "";
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", finish);
        bar.removeEventListener("pointercancel", cancel);
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", finish);
      bar.addEventListener("pointercancel", cancel);
    });
  });
}
