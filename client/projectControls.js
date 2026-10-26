import { goalKeyResultHelpHtml } from "./goalHelp.js";
import { projectTemplates, templateContent } from "./projectTemplates.js";
const day = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const label = (s) => String(s ?? "").replaceAll("_", " ");
const pct = (v) => Math.round(Math.max(0, Math.min(100, v)));
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
export function createProjectControls({
  api,
  el,
  esc,
  can,
  current,
  openDrawer,
  closeDrawer,
}) {
  let state = { records: [], history: [], baseline: null },
    staff = [],
    resources = [],
    jobs = [],
    page = "plan",
    tab = "tasks",
    folder = "",
    showArchived = false,
    epoch = 0,
    projectId = null;
  const active = (kind) =>
    state.records.filter((r) => r.kind === kind && (showArchived || r.active));
  const writable = (k) =>
    can(
      k === "document"
        ? "manage_project_documents"
        : k === "reserve"
          ? "manage_project_reserves"
          : "manage_project_controls",
    );
  const url = () => "/projects/" + projectId + "/controls";
  const person = (id) =>
    staff.find((s) => s.id === id)?.full_name ?? "Unassigned";
  const name = (id) =>
    state.records.find((r) => r.id === id)?.data.title ?? "—";
  const money = (n) =>
    Number(n).toLocaleString("en-US", {
      style: "currency",
      currency: current()?.currency || "USD",
    });
  const status = (s) =>
    `<span class="control-status status-${esc(s)}">${esc(label(s))}</span>`;
  const rollupTone = {
    done: "complete",
    late: "red",
    at_risk: "amber",
    on_track: "green",
  };
  const rollupText = {
    done: "Done",
    late: "Late",
    at_risk: "At risk",
    on_track: "On track",
  };
  const rollupBadge = (rollup) =>
    rollup?.status
      ? `<span class="control-status status-${esc(rollupTone[rollup.status] ?? rollup.status)}">${esc(rollupText[rollup.status] ?? label(rollup.status))}</span>`
      : "";
  const btn = (text, action, id = "", extra = "") =>
    `<button class="btn" data-control-action="${action}" data-record="${id}" ${extra}>${text}</button>`;
  const edits = (r) =>
    `${writable(r.kind) ? btn("Edit", "edit", r.id) : ""}${writable(r.kind) && r.kind === "milestone" ? btn(r.active ? "Delete" : "Restore", r.active ? "delete-milestone" : "restore-milestone", r.id) : ""}${btn("History", "history", r.id)}${r.kind !== "document" ? btn("Record / ST", "read", r.id) : ""}`;
  const records = () => state.records.filter((r) => r.active);
  const children = (id) =>
    records().filter((r) => r.kind === "task" && r.data.parent_id === id);
  const leaves = () =>
    records().filter((r) => r.kind === "task" && !children(r.id).length);
  function progress(r) {
    const kids = children(r.id);
    return kids.length
      ? Math.round(kids.reduce((s, c) => s + progress(c), 0) / kids.length)
      : r.data.state === "complete"
        ? 100
        : 0;
  }
  function orderedTasks() {
    const result = [];
    const walk = (parent, depth, prefix) => {
      active("task")
        .filter((r) => r.data.parent_id === parent)
        .sort(
          (a, b) =>
            a.data.sort_order - b.data.sort_order ||
            a.data.start_on.localeCompare(b.data.start_on) ||
            a.data.title.localeCompare(b.data.title),
        )
        .forEach((r, i) => {
          const code = prefix ? prefix + "." + (i + 1) : String(i + 1);
          result.push({ ...r, depth, code });
          walk(r.id, depth + 1, code);
        });
    };
    walk(null, 0, "");
    return result;
  }
  async function mount(next, targetId, selectedTab) {
    if (selectedTab) tab = selectedTab;
    page = next;
    const ticket = ++epoch;
    projectId = current()?.id;
    if (!projectId) return;
    const target = el(targetId);
    target.innerHTML = '<p class="control-empty">Loading project controls…</p>';
    try {
      const data = await Promise.all([
        api(url()),
        api("/staff"),
        api("/resources"),
        api("/projects/" + projectId + "/jobs"),
      ]);
      if (ticket !== epoch || projectId !== current()?.id) return;
      [state, staff, resources, jobs] = data;
      draw(target);
      const params = new URLSearchParams(location.search);
      const linkedDoc = params.get("document");
      if (
        page === "documents" &&
        linkedDoc &&
        params.get("project") === projectId
      ) {
        const document = state.records.find(
          (r) => r.id === linkedDoc && r.kind === "document",
        );
        if (!document)
          throw Error(
            "This document is unavailable or you do not have access.",
          );
        params.delete("project");
        params.delete("document");
        window.history.replaceState(
          null,
          "",
          location.pathname + (params.size ? "?" + params : "") + location.hash,
        );
        if (document.file_name) await openFile(document);
        else await readDocument(document);
      }
    } catch (e) {
      if (ticket === epoch) target.textContent = e.message;
    }
  }
  function draw(target) {
    let body = "";
    if (page === "plan") {
      body =
        tab === "tasks"
          ? taskList()
          : tab === "roadmap"
            ? roadmap()
            : tab === "goals"
              ? goals()
              : tab === "status"
                ? reports()
                : burndown();
    } else if (page === "documents") body = documents();
    else if (page === "risks") body = risks();
    else if (page === "communications") body = communications();
    else if (page === "reserves") body = reserves();
    target.innerHTML = `<div class="control-workspace"><label class="control-archive-toggle"><input type="checkbox" id="control-archived" ${showArchived ? "checked" : ""}> Include archived records</label>${body}<p class="err" id="control-error" role="alert"></p></div>`;
    bind(target);
  }
  const header = (title, hint, kind) =>
    `<header class="control-heading"><div><h2>${title}</h2><p>${hint}</p></div>${writable(kind) ? btn("Add " + label(kind), "new", kind) : ""}</header>`;
  const empty = (text) => `<div class="control-empty">${text}</div>`;
  function taskList() {
    return (
      header(
        "Task checklist & work breakdown",
        "Break the project into work packages and dated tasks. Child tasks determine package progress.",
        "task",
      ) +
      `<div class="control-toolbar"><span>${leaves().filter((r) => r.data.state === "complete").length} / ${leaves().length} active tasks complete</span></div><div class="control-table"><table><thead><tr><th>Done</th><th>WBS / task</th><th>Owner / crew</th><th>Dates</th><th>Progress</th><th>Actions</th></tr></thead><tbody>${
        orderedTasks()
          .map((r) => {
            const d = r.data,
              group = children(r.id).length;
            return `<tr id="item-${esc(r.id)}" class="${r.active ? "" : "control-archived"}"><td><input aria-label="Complete ${esc(d.title)}" type="checkbox" data-task-check="${r.id}" ${progress(r) === 100 ? "checked" : ""} ${group || !writable("task") || !r.active ? "disabled" : ""}></td><td style="padding-left:${12 + Math.min(r.depth, 8) * 16}px"><small>${r.code}</small> <strong>${esc(d.title)}</strong>${!r.active ? " (archived)" : ""}<small>${d.dependency_ids.length ? "After: " + esc(d.dependency_ids.map(name).join(", ")) : ""}${d.milestone_id ? " · Milestone: " + esc(name(d.milestone_id)) : ""}</small></td><td>${esc(person(d.owner_id))}<small>${esc(resources.find((x) => x.id === d.resource_id)?.name ?? "")}${d.job_link_id ? " · ST job " + esc(jobs.find((j) => j.id === d.job_link_id)?.source_job_number ?? jobs.find((j) => j.id === d.job_link_id)?.external_job_id ?? "") : ""}</small></td><td>${esc(d.start_on)} → ${esc(d.due_on)}<small>${d.completed_on ? "Completed " + esc(d.completed_on) : d.due_on < day() ? "Overdue" : ""}</small></td><td>${group ? progress(r) + "%" : status(d.state)}</td><td>${edits(r)}</td></tr>`;
          })
          .join("") ||
        '<tr><td colspan="6">No tasks yet. Add a work package, then assign child tasks to it.</td></tr>'
      }</tbody></table></div>`
    );
  }
  function roadmap() {
    const rows = active("milestone").sort((a, b) =>
      a.data.due_on.localeCompare(b.data.due_on),
    );
    return (
      header(
        "Roadmap & milestones",
        "Status is calculated from linked tasks. Done when every linked task is done, otherwise late, at risk, or on track.",
        "milestone",
      ) +
      `<div class="control-roadmap">${
        rows
          .map((r) => {
            const linked = records().filter(
              (t) => t.kind === "task" && t.data.milestone_id === r.id,
            );
            const done =
              r.rollup?.done ??
              linked.filter((t) => t.data.state === "complete").length;
            const total = r.rollup?.total ?? linked.length;
            const count = total
              ? `${done} of ${total} tasks done`
              : "No linked tasks";
            return `<article class="card" id="item-${esc(r.id)}"><small>${esc(r.data.due_on)}</small><h3>${esc(r.data.title)}${r.active ? "" : " (archived)"}</h3>${rollupBadge(r.rollup) || status(r.data.state)}<p>${esc(r.data.success_criteria || r.data.description || "Add acceptance criteria.")}</p><p>${esc(person(r.data.owner_id))}${r.data.goal_id ? " · " + esc(name(r.data.goal_id)) : ""}</p><p>${esc(count)}</p>${edits(r)}</article>`;
          })
          .join("") ||
        empty(
          "Add milestones such as permit approval, rough-in inspection, substantial completion and handover.",
        )
      }</div>`
    );
  }
  function goals() {
    return (
      header(
        "Objectives & key results",
        "The percent is the share of linked milestones that are done. Key results are optional.",
        "goal",
      ) +
      `<div class="control-roadmap">${
        active("goal")
          .map((r) => {
            const roll = r.rollup;
            const progress =
              roll && roll.percent != null
                ? `<div class="control-kr"><strong>Milestones done</strong><p>${roll.done} of ${roll.total} · ${pct(roll.percent)}%</p><progress max="100" value="${pct(roll.percent)}">${pct(roll.percent)}%</progress></div>`
                : `<p class="hint">No linked milestones yet.</p>`;
            const results = (r.data.key_results ?? []).length
              ? (r.data.key_results ?? [])
                  .map((k) => {
                    const p = pct(
                      (100 * (k.current - k.start)) / (k.target - k.start),
                    );
                    return `<div class="control-kr"><strong>${esc(k.name)}</strong><p>${k.current} / ${k.target} ${esc(k.unit)} · ${p}%</p><progress max="100" value="${p}">${p}%</progress></div>`;
                  })
                  .join("")
              : '<p class="hint">No key results. Add start, target, current, and a unit when you want a measured number.</p>';
            return `<article class="card"><h3>${esc(r.data.title)}${r.active ? "" : " (archived)"}</h3><p>${esc(r.data.description)}</p>${rollupBadge(roll) || status(r.data.state)}${progress}<small>Owner: ${esc(person(r.data.owner_id))} · Target ${r.data.due_on}</small>${results}${edits(r)}</article>`;
          })
          .join("") ||
        empty("Add an objective and a target date. Key results are optional.")
      }</div>`
    );
  }
  function reports() {
    const rows = active("report").sort(
      (a, b) =>
        b.data.as_of.localeCompare(a.data.as_of) ||
        b.created_at.localeCompare(a.created_at),
    );
    return (
      header(
        "RAG status reports",
        "Green = on track · Amber = needs attention · Red = intervention needed. Assessments are recorded by the project team.",
        "report",
      ) +
      rows
        .map(
          (r) =>
            `<article class="card control-report"><div class="control-heading"><h3>${esc(r.data.title)}${r.active ? "" : " (archived)"}</h3><span>${esc(r.data.as_of)} · ${esc(person(r.data.owner_id))}</span></div><div class="control-rag-grid">${["overall", "scope", "schedule", "cost", "quality"].map((k) => `<div><small>${label(k)}</small>${status(r.data[k])}</div>`).join("")}</div><p>${esc(r.data.description)}</p><div class="control-columns">${[
              ["Achievements", r.data.achievements],
              ["Next steps", r.data.next_steps],
              ["Decisions needed", r.data.decisions],
            ]
              .map(
                ([k, v]) =>
                  `<div><h4>${k}</h4><p class="control-pre">${esc(v || "—")}</p></div>`,
              )
              .join(
                "",
              )}</div>${edits(r)}${btn("Export report", "export", r.id)}</article>`,
        )
        .join("") +
      (rows.length
        ? ""
        : empty("No status assessment yet. Record the first project update."))
    );
  }
  function burndown() {
    const b = state.baseline,
      h = state.history;
    let body = `<header class="control-heading"><div><h2>Task burndown</h2><p>Remaining leaf tasks versus a saved target. New scope changes the actual line, not the original target.</p></div>${writable("task") ? btn(b ? "Start new baseline" : "Record baseline", "baseline") : ""}</header>`;
    if (!b)
      return (
        body +
        empty(
          "Add tasks, then record a baseline and target finish date. No historical progress is invented.",
        )
      );
    const start = b.start_on,
      end = [b.finish_on, h.at(-1)?.on_date ?? start].sort().at(-1);
    const duration = Math.max(1, days(start, end)),
      max = Math.max(1, b.total, ...h.map((p) => p.remaining)),
      x = (d) => 60 + (days(start, d) / duration) * 780,
      y = (n) => 240 - (n / max) * 190;
    body += `<div class="control-chart"><svg viewBox="0 0 920 300" role="img" aria-label="Remaining task burndown"><line x1="60" y1="240" x2="850" y2="240" stroke="var(--chart-axis)"/><line x1="60" y1="45" x2="60" y2="240" stroke="var(--chart-axis)"/><text fill="var(--ink)" x="25" y="50">${max}</text><text fill="var(--ink)" x="35" y="244">0</text><path d="M${x(start)} ${y(b.total)} L${x(b.finish_on)} 240" stroke="var(--chart-axis)" stroke-width="2" stroke-dasharray="6 4" fill="none"/><polyline points="${h.map((p) => x(p.on_date) + "," + y(p.remaining)).join(" ")}" stroke="var(--chart-line)" stroke-width="3" fill="none"/>${h.map((p) => `<circle cx="${x(p.on_date)}" cy="${y(p.remaining)}" r="5" fill="var(--chart-line)"><title>${p.on_date}: ${p.remaining} remaining / ${p.total} tasks in scope</title></circle>`).join("")}<text fill="var(--ink)" x="60" y="272">${start}</text><text fill="var(--ink)" x="840" y="272" text-anchor="end">${end}</text></svg></div><p>Solid line: recorded remaining tasks · Dashed line: baseline target (${b.total} remaining → 0 by ${b.finish_on}).</p><p class="hint">One observation is retained per day when tasks change. Gaps connect recorded observations; they are not daily measurements. A new baseline preserves the old records and starts a new chart.</p><div class="control-table"><table><thead><tr><th>Recorded date</th><th>Tasks in scope</th><th>Remaining</th></tr></thead><tbody>${h.map((p) => `<tr><td>${p.on_date}</td><td>${p.total}</td><td>${p.remaining}</td></tr>`).join("")}</tbody></table></div>`;
    return body;
  }
  function documents() {
    const rows = active("document").filter(
      (r) => !folder || r.data.folder === folder,
    );
    return (
      header(
        "Project documents",
        "Upload and open project files, or create a document from a template. Sync link to ST saves the title, description and secure PM link in project notes. Files up to 8 MB.",
        "document",
      ) +
      `<div class="control-toolbar">${writable("document") ? '<button class="btn primary" id="document-upload">Upload document</button>' : ""}<label>Folder<select id="control-folder"><option value="">All folders</option>${["charter_scope", "contracts_changes", "permits", "plans_specs", "photos", "reports", "closeout", "other"].map((f) => `<option value="${f}" ${f === folder ? "selected" : ""}>${label(f)}</option>`).join("")}</select></label>${
        writable("document")
          ? `<label>Start from template<select id="control-template"><option value="">Choose a template…</option>${Object.entries(
              projectTemplates,
            )
              .map(([k, t]) => `<option value="${k}">${t.name}</option>`)
              .join("")}</select></label>`
          : ""
      }</div><div class="document-library">${rows.map((r) => `<article class="card document-card"><small class="document-eyebrow">${esc(label(r.data.folder))} · REVISION ${r.version}</small><h3>${esc(r.data.title)}${r.active ? "" : " (archived)"}</h3><p>${esc(r.data.description)}</p><p>${r.file_name ? esc(r.file_name) + " · " + Math.round(r.file_size / 1024) + " KB" : "Editable project document"}</p><p class="document-sync">${r.st_state ? esc(label(r.st_state)) + " in ST · " + esc(r.st_format) + " revision " + r.st_version + (r.st_version < r.version ? " · Newer draft not published" : "") : "File / record saved in PM"}</p>${r.st_link_state ? '<p class="document-sync">ST link: ' + esc(label(r.st_link_state)) + " - revision " + r.st_link_version + (r.st_link_version < r.version ? " (newer changes need sync)" : "") + "</p>" : ""}${edits(r)}${writable(r.kind) && r.active ? btn("Sync link to ST", "sync-link", r.id) : ""}${r.file_name ? btn("Open file", "open-file", r.id) : ""}${btn(r.file_name ? "Record details" : "Preview", "read", r.id)}${btn(r.file_name ? "Export record PDF" : "Export PDF", "pdf", r.id)}${writable(r.kind) && r.active ? btn("Publish / ST status", "publish", r.id) : ""}${r.file_name ? btn("Download file", "download", r.id) : writable("document") ? btn("Attach file", "upload", r.id) : ""}${r.data.template === "change_request" ? '<p><a href="#financials">Record the change order in Financials →</a></p>' : ""}</article>`).join("") || empty("Upload a document or choose a template. Files stay with the selected project.")}</div>`
    );
  }
  function risks() {
    const rows = active("risk");
    return (
      header(
        "Risk register & ROAM",
        "Score likelihood × impact from 1–5. ROAM: Resolved, Owned, Accepted, Mitigated.",
        "risk",
      ) +
      `<div class="control-roam">${[
        "unassessed",
        "owned",
        "mitigated",
        "accepted",
        "resolved",
      ]
        .map(
          (k) =>
            `<section><h3>${label(k)} <span>${rows.filter((r) => r.data.roam === k).length}</span></h3>${
              rows
                .filter((r) => r.data.roam === k)
                .map(
                  (r) =>
                    `<article><strong>${esc(r.data.title)}${r.active ? "" : " (archived)"}</strong><p>${esc(person(r.data.owner_id))}</p><p>Score ${r.data.likelihood * r.data.impact} · Review ${r.data.review_on}</p>${edits(r)}</article>`,
                )
                .join("") || "<p>No risks</p>"
            }</section>`,
        )
        .join(
          "",
        )}</div><div class="control-table"><table><thead><tr><th>Risk / trigger</th><th>Likelihood</th><th>Impact</th><th>Score</th><th>Response</th><th>Owner / review</th></tr></thead><tbody>${rows.map((r) => `<tr><td><strong>${esc(r.data.title)}${r.active ? "" : " (archived)"}</strong><small>${esc(r.data.trigger)}</small></td><td>${r.data.likelihood}</td><td>${r.data.impact}</td><td>${r.data.likelihood * r.data.impact}</td><td>${esc(r.data.response || "Not recorded")}</td><td>${esc(person(r.data.owner_id))}<small>${r.data.review_on}</small></td></tr>`).join("") || '<tr><td colspan="6">No risks recorded.</td></tr>'}</tbody></table></div>`
    );
  }
  function communications() {
    return (
      header(
        "Communication & check-in plan",
        "Plan audiences, delivery channels and cadence. Log a delivery after it happens; this screen does not send messages.",
        "communication",
      ) +
      `<div class="control-roadmap">${
        active("communication")
          .sort((a, b) =>
            (a.data.next_on ?? "9999").localeCompare(b.data.next_on ?? "9999"),
          )
          .map(
            (r) =>
              `<article class="card"><h3>${esc(r.data.title)}${r.active ? "" : " (archived)"}</h3><p>${esc(r.data.audience)}</p><p>${esc(label(r.data.channel))} · ${esc(label(r.data.cadence))} · ${esc(person(r.data.owner_id))}</p><p>Next: ${r.data.next_on ?? "As needed"} ${r.data.next_on && r.data.next_on < day() ? status("amber") : ""}</p><p>Last delivered: ${r.data.last_delivered_on ?? "Not recorded"}</p><p class="control-pre">${esc(r.data.delivery_notes)}</p>${edits(r)}${writable("communication") ? btn("Log delivery", "deliver", r.id) : ""}</article>`,
          )
          .join("") ||
        empty(
          "Add the customer update, weekly trade coordination and site check-in plans.",
        )
      }</div>`
    );
  }
  function reserves() {
    if (!can("view_margin")) return "";
    const rows = active("reserve");
    const allocated = rows
        .filter((r) => r.active)
        .reduce((s, r) => s + r.data.allocated, 0),
      drawn = rows
        .filter((r) => r.active)
        .reduce((s, r) => s + r.data.drawn, 0);
    return (
      header(
        "Reserves & financial buffers",
        "Planning allowances tracked separately from budget, commitments and actual costs. Drawing a reserve does not post a bill or change ST/QB.",
        "reserve",
      ) +
      `<div class="control-metrics"><div><small>Allocated</small><strong>${money(allocated)}</strong></div><div><small>Drawn / designated</small><strong>${money(drawn)}</strong></div><div><small>Remaining</small><strong>${money(allocated - drawn)}</strong></div></div><div class="control-table"><table><thead><tr><th>Reserve</th><th>Category / risk</th><th>Allocated</th><th>Drawn</th><th>Remaining</th><th>Actions</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.data.title)}${r.active ? "" : " (archived)"}</td><td>${esc(label(r.data.category))}<small>${r.data.risk_id ? esc(name(r.data.risk_id)) : ""}</small></td><td>${money(r.data.allocated)}</td><td>${money(r.data.drawn)}</td><td>${money(r.data.allocated - r.data.drawn)}</td><td>${edits(r)}</td></tr>`).join("") || '<tr><td colspan="6">No reserve allocations recorded.</td></tr>'}</tbody></table></div>`
    );
  }
  async function reload() {
    await mount(
      page,
      page === "reserves"
        ? "project-reserves"
        : page === "plan"
          ? "plan-controls"
          : "page-" + page,
    );
  }
  async function save(r, data, active = true) {
    const result = await api(url() + (r ? "/" + r.id : ""), {
      method: r ? "PATCH" : "POST",
      body: JSON.stringify(
        r ? { version: r.version, data, active } : { kind: formKind, data },
      ),
    });
    return result;
  }
  let formKind = "task";
  function bind(target) {
    target.querySelectorAll("[data-control-action]").forEach(
      (b) =>
        (b.onclick = async () => {
          const action = b.dataset.controlAction,
            id = b.dataset.record,
            r = state.records.find((x) => x.id === id);
          try {
            if (action === "tab") {
              tab = id;
              draw(target);
            } else if (action === "new") form(id);
            else if (action === "edit") form(r.kind, r);
            else if (action === "delete-milestone") {
              const count = state.records.filter(t => t.kind === "task" && t.data.milestone_id === r.id).length;
              if (!window.confirm(`Delete "${r.data.title}" from the project plan?${count ? ` Its ${count} linked task(s) will be kept and unlinked.` : ""} You can restore the milestone using Include archived records.`)) return;
              b.disabled = true;
              await api(url() + "/" + r.id, {method:"DELETE",body:JSON.stringify({version:r.version})});
              await reload();
            } else if (action === "restore-milestone") {
              b.disabled = true;
              await save(r,r.data,true);
              await reload();
            }
            else if (action === "baseline") baselineForm();
            else if (action === "history") await history(r);
            else if (action === "deliver") deliver(r);
            else if (action === "upload") upload(r);
            else if (action === "sync-link") await syncDocumentLink(r);
            else if (action === "open-file") await openFile(r);
            else if (action === "download") {
              const f = await api(url() + "/" + r.id + "/file");
              downloadFile(f);
            } else if (action === "read") await readDocument(r);
            else if (action === "pdf") await exportPdf(r);
            else if (action === "publish") await publicationPanel(r);
            else if (action === "export") await exportPdf(r);
          } catch (e) {
            b.disabled = false;
            el("control-error").textContent = e.message;
          }
        }),
    );
    target.querySelectorAll("[data-task-check]").forEach(
      (c) =>
        (c.onchange = async () => {
          const r = state.records.find((x) => x.id === c.dataset.taskCheck);
          c.disabled = true;
          try {
            await save(r, {
              ...r.data,
              state: c.checked ? "complete" : "in_progress",
              completed_on: c.checked ? day() : null,
            });
            await reload();
          } catch (e) {
            c.checked = !c.checked;
            c.disabled = false;
            el("control-error").textContent = e.message;
          }
        }),
    );
    el("control-archived")?.addEventListener("change", (e) => {
      showArchived = e.target.checked;
      draw(target);
    });
    el("control-folder")?.addEventListener("change", (e) => {
      folder = e.target.value;
      draw(target);
    });
    el("document-upload")?.addEventListener("click", () => upload());
    el("control-template")?.addEventListener("change", (e) => {
      if (e.target.value) form("document", null, e.target.value);
    });
  }
  // Form and export helpers are kept together below so every view shares validation and version checks.
  const select = (key, title, values, value, multiple = false) =>
    `<label>${title}<select id="cf-${key}" ${multiple ? 'multiple size="4"' : ""}>${!multiple ? '<option value="">Select…</option>' : ""}${values
      .map((v) => {
        const [id, text] = Array.isArray(v) ? v : [v, label(v)];
        return `<option value="${esc(id)}" ${(multiple ? (value ?? []).includes(id) : value === id) ? "selected" : ""}>${esc(text)}</option>`;
      })
      .join("")}</select></label>`;
  const input = (key, title, value = "", type = "text", required = false) =>
    `<label>${title}<input id="cf-${key}" type="${type}" value="${esc(value ?? "")}" ${required ? "required" : ""} ${type === "number" ? 'step="any"' : ""}></label>`;
  const area = (key, title, value = "", rows = 4) =>
    `<label>${title}<textarea id="cf-${key}" rows="${rows}">${esc(value ?? "")}</textarea></label>`;
  const opts = (k) =>
    records()
      .filter((r) => r.kind === k)
      .map((r) => [r.id, r.data.title]);
  function form(k, r = null, template = "") {
    formKind = k;
    const d = r?.data ?? {},
      dt = day();
    let html =
      input(
        "title",
        "Title",
        d.title || (template ? projectTemplates[template].name : ""),
        "text",
        true,
      ) +
      select(
        "owner_id",
        "Responsible PM user",
        staff.map((s) => [s.id, s.full_name]),
        d.owner_id,
      ) +
      area("description", "Description / rationale", d.description);
    if (k === "task")
      html += select(
        "state",
        "Status",
        ["not_started", "in_progress", "blocked", "complete"],
        d.state ?? "not_started",
      );
    if (k === "goal")
      html +=
        '<p class="hint">The percent is calculated from milestones that are done. It cannot be typed in.</p>';
    if (k === "milestone")
      html +=
        '<p class="hint">Status is calculated from linked tasks. It cannot be set here.</p>';
    if (k === "task")
      html +=
        `<div class="control-columns">${input("start_on", "Start", d.start_on ?? dt, "date", true)}${input("due_on", "Finish / due", d.due_on ?? dt, "date", true)}${input("completed_on", "Actual completion", d.completed_on, "date")}</div>` +
        select(
          "parent_id",
          "WBS parent / work package",
          opts("task").filter(([id]) => id !== r?.id),
          d.parent_id,
        ) +
        select(
          "dependency_ids",
          "Predecessor tasks (Ctrl/Cmd to select several)",
          leaves()
            .filter((x) => x.id !== r?.id)
            .map((x) => [x.id, x.data.title]),
          d.dependency_ids ?? [],
          true,
        ) +
        select("milestone_id", "Milestone", opts("milestone"), d.milestone_id) +
        select(
          "resource_id",
          "Technician / trade crew",
          resources
            .filter((x) => x.active !== false)
            .map((x) => [x.id, x.name]),
          d.resource_id,
        ) +
        select(
          "job_link_id",
          "Related ST job",
          jobs
            .filter((x) => x.source_active !== false)
            .map((x) => [
              x.id,
              x.source_job_number ?? x.external_job_id ?? x.id,
            ]),
          d.job_link_id,
        ) +
        input(
          "sort_order",
          "Order within work package",
          d.sort_order ?? 0,
          "number",
        );
    if (k === "goal")
      html +=
        input("due_on", "Target date", d.due_on ?? dt, "date", true) +
        "<h3>Measurable key results</h3>" +
        goalKeyResultHelpHtml() +
        '<div id="cf-key-results"></div><button class="btn" type="button" id="cf-add-kr">Add key result</button>';
    if (k === "milestone")
      html +=
        input("due_on", "Target date", d.due_on ?? dt, "date", true) +
        select("goal_id", "Project goal", opts("goal"), d.goal_id) +
        area(
          "success_criteria",
          "Acceptance / success criteria",
          d.success_criteria,
        );
    if (k === "risk")
      html +=
        select(
          "likelihood",
          "Likelihood (1 low – 5 high)",
          [1, 2, 3, 4, 5].map((n) => [String(n), String(n)]),
          String(d.likelihood ?? 3),
        ) +
        select(
          "impact",
          "Impact (1 low – 5 high)",
          [1, 2, 3, 4, 5].map((n) => [String(n), String(n)]),
          String(d.impact ?? 3),
        ) +
        select(
          "roam",
          "ROAM classification",
          ["unassessed", "resolved", "owned", "accepted", "mitigated"],
          d.roam ?? "unassessed",
        ) +
        input("review_on", "Next review", d.review_on ?? dt, "date", true) +
        area("trigger", "Warning signs / trigger", d.trigger) +
        area("response", "Response, mitigation and contingency", d.response);
    if (k === "communication")
      html +=
        input("audience", "Audience / recipients", d.audience, "text", true) +
        select(
          "channel",
          "Delivery channel",
          ["email", "phone", "onsite", "meeting", "portal"],
          d.channel ?? "email",
        ) +
        select(
          "cadence",
          "Cadence",
          ["once", "daily", "weekly", "fortnightly", "monthly", "as_needed"],
          d.cadence ?? "weekly",
        ) +
        input("next_on", "Next update / check-in", d.next_on ?? dt, "date") +
        input(
          "last_delivered_on",
          "Last delivered",
          d.last_delivered_on,
          "date",
        ) +
        area("delivery_notes", "Latest delivery notes", d.delivery_notes);
    if (k === "reserve")
      html +=
        select(
          "category",
          "Reserve category",
          ["contingency", "management_reserve", "schedule_buffer"],
          d.category ?? "contingency",
        ) +
        input(
          "allocated",
          "Allocated amount",
          d.allocated ?? 0,
          "number",
          true,
        ) +
        input(
          "drawn",
          "Amount drawn / designated",
          d.drawn ?? 0,
          "number",
          true,
        ) +
        select("risk_id", "Related risk", opts("risk"), d.risk_id) +
        "<p>Amounts are planning allocations. Existing cost and change-order approval rules still apply.</p>";
    if (k === "document")
      html +=
        select(
          "folder",
          "Folder",
          [
            "charter_scope",
            "contracts_changes",
            "permits",
            "plans_specs",
            "photos",
            "reports",
            "closeout",
            "other",
          ],
          d.folder ?? projectTemplates[template]?.folder ?? "other",
        ) +
        area(
          "content",
          "Document / form content",
          d.content ?? (template ? templateContent(template, current()) : ""),
          18,
        ) +
        '<p class="hint">Use ## for section headings, - for lists, **bold** for emphasis, and pipe-separated tables. Preview and PDF export format these automatically. Save a revision before publishing to ST.</p>';
    if (k === "report")
      html +=
        input("as_of", "Reporting date", d.as_of ?? dt, "date", true) +
        ["overall", "scope", "schedule", "cost", "quality"]
          .map((key) =>
            select(
              key,
              label(key) + " status",
              ["not_assessed", "green", "amber", "red"],
              d[key] ?? "not_assessed",
            ),
          )
          .join("") +
        area("achievements", "Achievements", d.achievements) +
        area("next_steps", "Next steps / commitments", d.next_steps) +
        area("decisions", "Decisions / help needed", d.decisions);
    openDrawer(
      r ? "Edit " + label(k) : "Add " + label(k),
      `<form id="control-form">${html}${r ? `<label><input id="cf-active" type="checkbox" ${r.active ? "checked" : ""}> Active (uncheck to archive)</label>` : ""}<p class="err" id="cf-error" role="alert"></p><button class="btn primary" id="cf-save">Save ${label(k)}</button></form>`,
    );
    if (k === "goal") {
      const add = (
        v = { name: "", start: 0, target: 100, current: 0, unit: "%" },
      ) => {
        const row = document.createElement("fieldset");
        row.className = "control-key-result";
        row.innerHTML = `<label>Key result<input data-kr="name" required value="${esc(v.name)}"></label><div class="control-columns">${["start", "target", "current"].map((n) => `<label>${label(n)}<input data-kr="${n}" type="number" step="any" required value="${v[n]}"></label>`).join("")}</div><label>Unit<input data-kr="unit" value="${esc(v.unit)}"></label><button type="button" class="btn">Remove key result</button>`;
        row.querySelector("button").onclick = () => row.remove();
        el("cf-key-results").append(row);
      };
      (d.key_results ?? []).forEach(add);
      el("cf-add-kr").onclick = () => add();
    }
    el("control-form").onsubmit = async (e) => {
      e.preventDefault();
      const data = {};
      el("control-form")
        .querySelectorAll('[id^="cf-"]')
        .forEach((n) => {
          const key = n.id.slice(3);
          if (
            ["active", "error", "save", "key-results", "add-kr"].includes(
              key,
            ) ||
            !["INPUT", "SELECT", "TEXTAREA"].includes(n.tagName)
          )
            return;
          data[key] = n.multiple
            ? [...n.selectedOptions].map((o) => o.value)
            : n.type === "number"
              ? Number(n.value)
              : n.value;
        });
      for (const key of [
        "owner_id",
        "parent_id",
        "milestone_id",
        "resource_id",
        "job_link_id",
        "goal_id",
        "risk_id",
        "completed_on",
        "next_on",
        "last_delivered_on",
      ])
        if (key in data) data[key] = data[key] || null;
      if (k === "risk") {
        data.likelihood = Number(data.likelihood);
        data.impact = Number(data.impact);
      }
      if (k === "document") data.template = d.template ?? template;
      if (k === "goal")
        data.key_results = [...el("cf-key-results").children]
          .map((row) =>
            Object.fromEntries(
              [...row.querySelectorAll("[data-kr]")].map((n) => [
                n.dataset.kr,
                n.type === "number" ? Number(n.value) : n.value,
              ]),
            ),
          )
          .filter((row) => String(row.name ?? "").trim());
      el("cf-save").disabled = true;
      try {
        await save(r, data, r ? el("cf-active").checked : true);
        closeDrawer();
        await reload();
      } catch (error) {
        if (el("cf-error"))
          el("cf-error").textContent =
            error.message +
            (error.details?.map?.((d) => d.message).join("; ") ?? "");
        if (el("cf-save")) el("cf-save").disabled = false;
      }
    };
  }
  function baselineForm() {
    openDrawer(
      "Record burndown baseline",
      `<form id="cb-form"><p>This starts a new baseline from today's remaining leaf tasks. Previous baselines remain stored.</p>${input("finish", "Target finish date", day(), "date", true)}<p class="err" id="cb-error"></p><button class="btn primary">Record baseline</button></form>`,
    );
    el("cb-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(url() + "/baseline", {
          method: "POST",
          body: JSON.stringify({ finish_on: el("cf-finish").value }),
        });
        closeDrawer();
        await reload();
      } catch (err) {
        el("cb-error").textContent = err.message;
      }
    };
  }
  async function history(r) {
    const rows = await api(url() + "/" + r.id + "/history");
    openDrawer(
      "History: " + r.data.title,
      rows
        .map(
          (x) =>
            `<article><strong>${esc(label(x.action))}</strong><p>${esc(x.actor ?? "Staff")} · ${esc(new Date(x.occurred_at).toLocaleString())}</p>${x.action === "communication_delivered" ? `<p>${esc(x.after_data?.delivery_notes)}</p>` : ""}</article>`,
        )
        .join("") || empty("No history recorded."),
    );
  }
  function deliver(r) {
    openDrawer(
      "Log communication delivery",
      `<form id="cd-form"><p>${esc(r.data.title)}${r.active ? "" : " (archived)"} — record what was delivered and any follow-up actions.</p>${area("notes", "Delivery notes")}<p class="err" id="cd-error"></p><button class="btn primary">Record delivery today</button></form>`,
    );
    el("cd-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(url() + "/" + r.id + "/deliver", {
          method: "POST",
          body: JSON.stringify({
            version: r.version,
            notes: el("cf-notes").value,
          }),
        });
        closeDrawer();
        await reload();
      } catch (err) {
        el("cd-error").textContent = err.message;
      }
    };
  }
  function upload(r = null) {
    const uploadUrl = url();
    const creating = !r;
    openDrawer(
      creating ? "Upload project document" : "Attach project file",
      `<form id="cu-form"><p>${creating ? "Upload a file to this project. After upload, use Sync link to ST to save its description and secure link in project notes." : esc(r.data.title) + ". One attachment per document record."}</p><label>File<input type="file" id="cu-file" required accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.txt,.csv"></label><p class="hint">PDF, Word (.docx), Excel (.xlsx), JPG, PNG, TXT or CSV. Maximum 8 MB.</p>${creating ? '<label>Document title<input id="cu-title" maxlength="200" required></label><label>Folder<select id="cu-folder">' + ["charter_scope", "contracts_changes", "permits", "plans_specs", "photos", "reports", "closeout", "other"].map((f) => '<option value="' + f + '" ' + (f === (folder || "other") ? "selected" : "") + ">" + label(f) + "</option>").join("") + '</select></label><label>Notes<textarea id="cu-notes" maxlength="20000" rows="3"></textarea></label>' : ""}<p class="err" id="cu-error" role="alert"></p><button class="btn primary" id="cu-save">Upload document</button></form>`,
    );
    el("cu-file").onchange = () => {
      if (creating && !el("cu-title").value)
        el("cu-title").value = (el("cu-file").files[0]?.name || "").slice(
          0,
          200,
        );
    };
    el("cu-form").onsubmit = async (e) => {
      e.preventDefault();
      el("cu-save").disabled = true;
      try {
        const f = el("cu-file").files[0];
        if (!f || f.size > 8388608) throw Error("Choose a file up to 8 MB.");
        const types = {
          pdf: "application/pdf",
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          txt: "text/plain",
          csv: "text/csv",
          docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        };
        const media_type = types[f.name.split(".").at(-1).toLowerCase()];
        if (!media_type) throw Error("Unsupported file type.");
        const content = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(f);
        });
        if (!r) {
          r = await api(uploadUrl, {
            method: "POST",
            body: JSON.stringify({
              kind: "document",
              data: {
                title: el("cu-title").value.trim(),
                folder: el("cu-folder").value,
                description: el("cu-notes").value,
              },
            }),
          });
          for (const id of ["cu-title", "cu-folder", "cu-notes"])
            el(id).disabled = true;
        }
        el("cu-save").textContent = "Uploading…";
        await api(uploadUrl + "/" + r.id + "/file", {
          method: "POST",
          body: JSON.stringify({ file_name: f.name, media_type, content }),
        });
        if (creating && url() === uploadUrl) folder = r.data.folder;
        closeDrawer();
        await reload();
      } catch (err) {
        el("cu-error").textContent =
          err.message +
          (creating && r
            ? " Document details saved. Retry the file upload here, or use Attach file on the saved document."
            : "");
        el("cu-save").textContent = "Retry upload";
        el("cu-save").disabled = false;
      }
    };
  }
  function blobDownload(blob, name) {
    const href = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = href;
    a.download = name.replace(/[\\/]/g, "_");
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  }
  function downloadFile(f) {
    const raw = atob(f.content.replace(/\s/g, ""));
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    blobDownload(new Blob([bytes], { type: f.media_type }), f.file_name);
  }
  function text(r) {
    if (r.kind === "document") return r.data.content || r.data.description;
    return (
      "# " +
      r.data.title +
      "\n\n" +
      Object.entries(r.data)
        .filter(([k]) => !["title", "owner_id"].includes(k))
        .map(
          ([k, v]) =>
            label(k) + ": " + (typeof v === "object" ? JSON.stringify(v) : v),
        )
        .join("\n\n")
    );
  }
  function downloadText(r) {
    blobDownload(
      new Blob([text(r)], { type: "text/plain;charset=utf-8" }),
      r.data.title + ".txt",
    );
  }
  async function exportPdf(r) {
    const f = await api(url() + "/" + r.id + "/pdf");
    downloadFile(f);
  }
  async function syncDocumentLink(r) {
    const base = url(),
      ticket = epoch;
    openDrawer(
      "Sync document link to ServiceTitan",
      "<p>Saving the document title, description and secure link in ST project notes…</p>",
    );
    try {
      const result = await api(base + "/" + r.id + "/sync-link", {
        method: "POST",
        body: JSON.stringify({ version: r.version }),
      });
      if (ticket !== epoch) return;
      await reload();
      openDrawer(
        "ServiceTitan document link",
        '<p role="status">' +
          esc(result.message) +
          "</p><p>ST note revision: " +
          result.version +
          '</p><p><a href="' +
          esc(result.url) +
          '">Open linked document</a></p><p>The link requires a PM login with access to this project. The file remains in PM; ST holds its description and link.</p>',
      );
    } catch (error) {
      if (ticket === epoch)
        openDrawer(
          "Document link not synchronized",
          '<p role="alert">' +
            esc(error.message) +
            "</p><p>Your document remains saved in PM. Use Sync link to ST again to check or retry.</p>",
        );
    }
  }
  async function openFile(r) {
    const ticket = epoch;
    const f = await api(url() + "/" + r.id + "/file");
    if (ticket !== epoch) return;
    const bytes = Uint8Array.from(atob(f.content.replace(/\s/g, "")), (c) =>
      c.charCodeAt(0),
    );
    const type = f.media_type;
    const previewable = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "text/plain",
      "text/csv",
    ].includes(type);
    const href = previewable
      ? URL.createObjectURL(new Blob([bytes], { type }))
      : null;
    const content =
      type === "application/pdf"
        ? '<div id="uploaded-pdf"><div class="document-actions"><button class="btn" id="pdf-prev" disabled>Previous page</button><span id="pdf-page" role="status">Loading PDF…</span><button class="btn" id="pdf-next" disabled>Next page</button></div><p id="pdf-error" role="alert"></p><canvas id="pdf-canvas" aria-label="Uploaded PDF page" style="max-width:100%;height:auto;border:1px solid var(--rule)"></canvas><details><summary>Page text</summary><pre id="pdf-text" style="white-space:pre-wrap"></pre></details></div>'
        : type === "image/png" || type === "image/jpeg"
          ? '<img src="' +
            href +
            '" alt="' +
            esc(f.file_name) +
            '" style="display:block;max-width:100%;height:auto">'
          : type === "text/plain" || type === "text/csv"
            ? '<pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:70vh;overflow:auto">' +
              esc(new TextDecoder().decode(bytes)) +
              "</pre>"
            : "<p>This file opens in Word, Excel, or another compatible application. Download it, then open the downloaded file.</p>";
    openDrawer(
      f.file_name,
      '<section id="uploaded-file-view"><p>Original uploaded file · ' +
        esc(f.file_name) +
        '</p><div class="document-actions"><button class="btn primary" id="uploaded-file-download">Download original file</button>' +
        (href && type === "application/pdf"
          ? '<a class="btn" href="' +
            href +
            '" target="_blank" rel="noopener">Open PDF in new tab</a>'
          : "") +
        "</div>" +
        content +
        "</section>",
    );
    el("uploaded-file-download").onclick = () => downloadFile(f);
    if (type === "application/pdf")
      void renderUploadedPdf(bytes, el("uploaded-pdf"));
    if (href) {
      const view = el("uploaded-file-view");
      const observer = new MutationObserver(() => {
        if (!view.isConnected) {
          URL.revokeObjectURL(href);
          observer.disconnect();
        }
      });
      observer.observe(view.parentNode, { childList: true });
    }
  }
  async function renderUploadedPdf(bytes, view) {
    let task,
      pdf,
      disposed = false,
      pageNumber = 1,
      busy = false;
    const observer = new MutationObserver(() => {
      if (!view.isConnected) {
        disposed = true;
        void task?.destroy();
        observer.disconnect();
      }
    });
    observer.observe(view.parentNode.parentNode, {
      childList: true,
      subtree: true,
    });
    const get = (id) => view.querySelector("#" + id);
    async function renderPage() {
      if (busy || disposed) return;
      busy = true;
      get("pdf-prev").disabled = get("pdf-next").disabled = true;
      try {
        const page = await pdf.getPage(pageNumber);
        if (disposed) return;
        const unscaled = page.getViewport({ scale: 1 });
        const scale = Math.min(
          2,
          1200 / Math.max(unscaled.width, unscaled.height),
        );
        const viewport = page.getViewport({ scale });
        const canvas = get("pdf-canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport })
          .promise;
        const text = await page.getTextContent();
        if (disposed) return;
        get("pdf-text").textContent = text.items
          .map((item) => item.str || "")
          .join(" ");
        get("pdf-page").textContent =
          "Page " + pageNumber + " of " + pdf.numPages;
      } catch {
        if (!disposed)
          get("pdf-error").textContent =
            "This PDF could not be displayed. Download the original file to open it.";
      } finally {
        busy = false;
        if (!disposed) {
          get("pdf-prev").disabled = pageNumber <= 1;
          get("pdf-next").disabled = pageNumber >= pdf.numPages;
        }
      }
    }
    try {
      const pdfjs = await import("/pdfjs/build/pdf.mjs");
      if (disposed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/build/pdf.worker.mjs";
      task = pdfjs.getDocument({
        data: bytes,
        isEvalSupported: false,
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        wasmUrl: "/pdfjs/wasm/",
      });
      pdf = await task.promise;
      if (disposed) return;
      get("pdf-prev").onclick = () => {
        if (!busy && pageNumber > 1) {
          pageNumber--;
          void renderPage();
        }
      };
      get("pdf-next").onclick = () => {
        if (!busy && pageNumber < pdf.numPages) {
          pageNumber++;
          void renderPage();
        }
      };
      await renderPage();
    } catch {
      if (!disposed) {
        get("pdf-page").textContent = "Preview unavailable";
        get("pdf-error").textContent =
          "Unable to preview this PDF (it may be encrypted or damaged). Download the original file to open it.";
      }
    }
  }
  async function readDocument(r) {
    const ticket = epoch;
    const result = await api(url() + "/" + r.id + "/preview");
    if (ticket !== epoch) return;
    openDrawer(
      r.data.title,
      '<div class="document-actions"><button class="btn primary" id="document-pdf">Export PDF</button>' +
        (writable(r.kind) && r.active
          ? '<button class="btn" id="document-st">Publish / ST status</button>'
          : "") +
        '</div><p class="err" id="document-error" role="alert"></p>' +
        result.html,
    );
    el("document-pdf").onclick = async (e) => {
      e.target.disabled = true;
      try {
        await exportPdf(r);
      } catch (error) {
        el("document-error").textContent = error.message;
      } finally {
        e.target.disabled = false;
      }
    };
    el("document-st")?.addEventListener(
      "click",
      () =>
        void publicationPanel(r).catch((error) => {
          if (el("document-error"))
            el("document-error").textContent = error.message;
        }),
    );
  }
  async function publicationPanel(r) {
    const ticket = epoch,
      base = url() + "/" + r.id;
    const [historyResult, targetResult] = await Promise.allSettled([
      api(base + "/publications"),
      api(base + "/publish-targets"),
    ]);
    if (ticket !== epoch) return;
    if (historyResult.status !== "fulfilled") throw historyResult.reason;
    const history = historyResult.value,
      targets = targetResult.status === "fulfilled" ? targetResult.value : null;
    openDrawer(
      "ServiceTitan record publishing",
      '<div class="publication-intro"><h3>' +
        esc(r.data.title) +
        "</h3><p>Revision " +
        r.version +
        " · " +
        esc(current().project_number) +
        "</p><p>The file is stored on the ST job you choose below. A note on its ST project records the filename, revision and attachment ID. This does not populate ST’s separate Project Documents folder.</p></div>" +
        (targets
          ? '<form id="publish-form"><p><strong>ST project ' +
            esc(targets.project.number) +
            "</strong> · " +
            esc(targets.project.name || "") +
            '</p><label>Destination job<select id="publish-job" required><option value="">Select an ST project job</option>' +
            targets.jobs
              .map(
                (j) =>
                  '<option value="' +
                  esc(j.id) +
                  '">Job ' +
                  esc(j.number) +
                  " · " +
                  esc(
                    (j.summary || "").replace(/<[^>]*>/g, " ").slice(0, 100),
                  ) +
                  "</option>",
              )
              .join("") +
            '</select></label><label>File to publish<select id="publish-format"><option value="pdf">Formatted PDF of this record</option>' +
            (r.file_name
              ? '<option value="original">Original attachment: ' +
                esc(r.file_name) +
                "</option>"
              : "") +
            '</select></label><p>Editing here creates a new draft revision. Publishing stores a snapshot in ST; it does not replace earlier revisions or grant approval.</p><button class="btn primary" id="publish-submit" ' +
            (!targets.writesEnabled || !targets.jobs.length ? "disabled" : "") +
            ">Publish revision to ST</button>" +
            (!targets.writesEnabled
              ? "<p>" +
                esc(
                  targets.accessError ||
                    "ST writes are disabled for this account.",
                ) +
                "</p>"
              : !targets.jobs.length
                ? "<p>Add a job to this project in ST before publishing an attachment.</p>"
                : "") +
            "</form>"
          : '<p class="err">' +
            esc(targetResult.reason?.message || "ST connector unavailable") +
            "</p>") +
        '<p id="publish-message" role="status"></p><h3>Publication history</h3><div class="publication-history">' +
        (history
          .map(
            (p) =>
              "<article><strong>" +
              esc(label(p.state)) +
              " · " +
              esc(p.format) +
              " revision " +
              p.record_version +
              "</strong><p>" +
              esc(p.file_name) +
              "</p><small>ST project " +
              esc(p.external_project_id) +
              " / job " +
              esc(p.external_job_id) +
              (p.attachment_id ? " / attachment " + esc(p.attachment_id) : "") +
              "</small><p>" +
              esc(p.message || "Publishing started; receipt pending") +
              '</p><button class="btn" data-publication-check="' +
              p.id +
              '">Check ST receipt</button></article>',
          )
          .join("") ||
          "<p>No revisions published. This record is currently saved only in PM.</p>") +
        "</div>",
    );
    el("publish-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      el("publish-submit").disabled = true;
      el("publish-message").textContent = "Publishing to ST…";
      try {
        const result = await api(base + "/publish", {
          method: "POST",
          body: JSON.stringify({
            version: r.version,
            job_id: el("publish-job").value,
            format: el("publish-format").value,
          }),
        });
        if (ticket !== epoch) return;
        const originalProject = projectId;
        await reload();
        if (current()?.id !== originalProject) return;
        await publicationPanel(r);
        if (el("publish-message"))
          el("publish-message").textContent = result.message;
      } catch (error) {
        if (el("publish-message"))
          el("publish-message").textContent = error.message;
      } finally {
        if (el("publish-submit"))
          el("publish-submit").disabled =
            !targets?.writesEnabled || !targets?.jobs.length;
      }
    });
    document.querySelectorAll("[data-publication-check]").forEach(
      (button) =>
        (button.onclick = async () => {
          button.disabled = true;
          try {
            await api(
              base +
                "/publications/" +
                button.dataset.publicationCheck +
                "/check",
              { method: "POST", body: "{}" },
            );
            if (ticket === epoch) await publicationPanel(r);
          } catch (error) {
            if (el("publish-message"))
              el("publish-message").textContent = error.message;
            button.disabled = false;
          }
        }),
    );
  }
  async function dashboard(targetId) {
    // The schedule tile is the only project-progress number.
    // This slot used to render a second row from WBS task counts.
    const node = el(targetId);
    if (node) node.replaceChildren();
  }
  return {
    mount,
    dashboard,
    cancel: () => {
      epoch++;
      for (const id of [
        "plan-controls",
        "page-documents",
        "page-risks",
        "page-communications",
        "project-reserves",
      ])
        el(id)?.replaceChildren();
    },
  };
}
