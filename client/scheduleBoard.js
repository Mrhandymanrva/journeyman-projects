export const addDays = (date, n) =>
  new Date(Date.parse(date + "T12:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
export function windowSpan(start, end, from, days = 14) {
  const index = (d) =>
    Math.round(
      (Date.parse(d + "T12:00:00Z") - Date.parse(from + "T12:00:00Z")) /
        86400000,
    );
  const first = Math.max(0, index(start)),
    last = Math.min(days - 1, index(end));
  return first > last ? null : { first, last, length: last - first + 1 };
}
export function issues(row, today) {
  if (["complete", "cancelled"].includes(row.status)) return [];
  return [
    !row.staff_id && !row.vendor_id && !row.resources?.length
      ? "Unassigned"
      : "",
    row.window_end < today ? "Overdue" : "",
    row.conflicting_resource_ids?.length ? "Resource overlap" : "",
    row.vendor_schedulable === false ||
    row.resources?.some((r) => !r.schedulable)
      ? "Compliance needs attention"
      : "",
    row.dependencies?.some((d) => d.date_conflict)
      ? "Predecessor date conflict"
      : "",
    row.dependencies?.some((d) => d.status !== "complete")
      ? "Waiting on predecessor"
      : "",
  ].filter(Boolean);
}
export function crewGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const assigned = [
      ...(row.resources ?? []).map((r) => ({
        id: "resource:" + r.id,
        name: r.name,
        trade: r.trade || r.kind || "Crew",
      })),
      ...(row.vendor_id
        ? [
            {
              id: "vendor:" + row.vendor_id,
              name: row.vendor_name,
              trade: "Trade partner",
            },
          ]
        : []),
      ...(row.staff_id
        ? [
            {
              id: "staff:" + row.staff_id,
              name: row.staff_name,
              trade: "Technician",
            },
          ]
        : []),
    ];
    if (!assigned.length)
      assigned.push({
        id: "unassigned",
        name: "Unassigned work",
        trade: "Needs an owner",
      });
    for (const person of assigned) {
      if (!groups.has(person.id))
        groups.set(person.id, { ...person, rows: [] });
      groups.get(person.id).rows.push(row);
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function renderScheduleBoard({
  rows,
  from,
  view,
  all,
  projectId,
  editable,
  esc,
  today,
}) {
  const people = (r) =>
    [...(r.resources ?? []).map((x) => x.name), r.vendor_name, r.staff_name]
      .filter(Boolean)
      .join(", ") || "Unassigned";
  const button = (r) =>
    r.source === "servicetitan"
      ? `<button class="btn sm" data-st-appointment="${esc(r.id)}" type="button">ST appointment</button>`
      : editable && r.project_id === projectId
        ? `<button class="btn sm" data-plan-edit="${esc(r.id)}" type="button" aria-label="Edit ${esc(r.title)}">Edit</button>`
        : "";
  const timing = (r) =>
    r.source === "servicetitan"
      ? `<small class="st-appointment-time">${esc(new Date(r.appointment_start).toLocaleTimeString("en-US", { timeZone: r.time_zone, hour: "numeric", minute: "2-digit" }))} – ${esc(new Date(r.appointment_end).toLocaleTimeString("en-US", { timeZone: r.time_zone, hour: "numeric", minute: "2-digit" }))} ET · ${esc(r.source_status)}</small>`
      : "";
  const badge = (r) =>
    issues(r, today)
      .map((s) => `<span class="pm-warning">${esc(s)}</span>`)
      .join("");
  const card = (r) =>
    `<article class="pm-task"><strong>${esc(r.title)}</strong><small>${esc(all ? r.project_name : r.phase || "No phase assigned")}</small><p>${esc(people(r))}</p>${timing(r)}<small>${esc(r.window_start)} → ${esc(r.window_end)}</small><div class="pm-flags">${badge(r)}</div>${button(r)}</article>`;
  if (!rows.length)
    return '<p class="state">No work matches this view. Adjust the dates or filters, or add an activity.</p>';
  if (view === "board")
    return `<div class="pm-board">${[
      ["proposed", "Planned"],
      ["confirmed", "Ready"],
      ["in_progress", "In progress"],
      ["complete", "Complete"],
    ]
      .map(([status, label]) => {
        const items = rows.filter((r) => r.status === status);
        return `<section class="pm-column"><h3>${label} <span>${items.length}</span></h3>${items.map(card).join("") || '<p class="hint">No activities</p>'}</section>`;
      })
      .join("")}</div>`;
  if (view === "crew")
    return `<div class="pm-crews">${crewGroups(rows)
      .map(
        (g) =>
          `<section class="pm-crew"><header><h3>${esc(g.name)}</h3><small>${esc(g.trade)} · ${g.rows.length} activities</small></header>${g.rows.map(card).join("")}</section>`,
      )
      .join("")}</div>`;
  const days = Array.from({ length: 14 }, (_, i) => addDays(from, i));
  const groups = new Map();
  for (const r of rows) {
    const key =
      (all ? r.project_number + " · " : "") + (r.phase || "Unphased work");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return `<div class="pm-timeline" role="region" aria-label="Two-week project timeline" tabindex="0"><div class="pm-time-head"><strong>Activity / assigned crew</strong><div class="pm-days">${days.map((d) => `<span class="${d === today ? "pm-today" : ""}">${new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", day: "numeric", timeZone: "UTC" })}</span>`).join("")}</div></div>${[
    ...groups,
  ]
    .map(
      ([phase, items]) =>
        `<section><h3 class="pm-phase">${esc(phase)} <span>${items.filter((r) => r.status === "complete").length}/${items.length} complete</span></h3>${items
          .map((r) => {
            const span = windowSpan(r.window_start, r.window_end, from);
            return `<div class="pm-time-row"><div class="pm-time-label"><strong>${esc(r.title)}</strong><small>${esc(people(r))}</small>${timing(r)}<div class="pm-flags">${badge(r)}</div>${button(r)}</div><div class="pm-track">${span ? `<div class="pm-bar pm-${r.status}" style="grid-column:${span.first + 1}/span ${span.length}" title="${esc(r.title)} · ${esc(r.window_start)} to ${esc(r.window_end)}"><span>${esc(r.status.replaceAll("_", " "))}</span></div>` : ""}</div></div>`;
          })
          .join("")}</section>`,
    )
    .join("")}</div>`;
}
