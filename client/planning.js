import { createSubcontractors } from "./subcontractors.js";
import { renderScheduleBoard, issues } from "./scheduleBoard.js";
import { createSourceViews } from "./sources.js";
// Project planning UI. Scheduling resources are independent of login accounts.
export function createPlanning({
  api,
  el,
  esc,
  can,
  current,
  openDrawer,
  submit,
  field,
  messageSlot,
  refresh,
}) {
  const sourceViews = createSourceViews({
    api,
    el,
    esc,
    can,
    current,
    openDrawer,
  });
  const subcontractors = createSubcontractors({
    current,
    api,
    el,
    esc,
    can,
    openDrawer,
    submit,
    field,
    messageSlot,
  });
  let projectRows = [];
  let stRows = [];
  const stCache = new Map();
  el("planning-range").insertAdjacentHTML(
    "afterend",
    '<button class="btn sm" id="planning-st-refresh">Refresh ST jobs</button>',
  );
  el("planning-rows").insertAdjacentHTML(
    "beforebegin",
    '<p class="hint" id="planning-st-status" role="status"></p>',
  );
  el("planning-st-refresh").addEventListener("click", () => void lookahead());
  let generation = 0;
  const day = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const addDays = (date, n) => {
    const d = new Date(date + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const options = (rows, ids = []) =>
    rows
      .map(
        (r) =>
          `<option value="${r.id}" ${ids.includes(r.id) ? "selected" : ""}>${esc(r.name ?? r.title)}</option>`,
      )
      .join("");
  async function render(rows) {
    projectRows = rows;
    stRows = [];
    stCache.clear();
    if (!el("planning-from").value) el("planning-from").value = day();
    for (const id of ["planning-new", "planning-resource", "planning-job"])
      el(id).hidden = !can("advance_stage");

    const live = rows.filter((r) => r.status !== "cancelled");
    const complete = live.filter((r) => r.status === "complete").length;
    el("planning-summary").innerHTML = [
      [live.length, "Activities"],
      [complete, "Complete"],
      [
        live.filter((r) => issues(r, day()).includes("Unassigned")).length,
        "Unassigned",
      ],
      [live.filter((r) => issues(r, day()).length).length, "Need attention"],
    ]
      .map(
        ([value, label]) =>
          "<div><strong>" + value + "</strong><span>" + label + "</span></div>",
      )
      .join("");
    const phases = [
      ...new Set([
        ...rows.map((r) => r.phase).filter(Boolean),
        "ServiceTitan jobs",
      ]),
    ].sort();
    const previous = el("planning-phase").value;
    el("planning-phase").innerHTML =
      '<option value="">All phases</option>' +
      phases
        .map((p) => '<option value="' + esc(p) + '">' + esc(p) + "</option>")
        .join("");
    if (phases.includes(previous)) el("planning-phase").value = previous;
    if (!el("plan-scheduled-work")) await lookahead();
  }
  async function lookahead() {
    const revision = ++generation;
    const project = current();
    const from = el("planning-from").value || day();
    const to = addDays(from, 13);
    el("planning-range").textContent = `${from} – ${to}`;
    el("planning-rows").textContent = "Loading schedule…";
    try {
      const all = el("planning-all").checked;
      el("planning-st-status").textContent =
        "Reading scheduled jobs and technician assignments from ServiceTitan…";
      const key = project.id + ":" + all + ":" + from + ":" + to;
      const [pmResult, stResult] = await Promise.allSettled([
        all
          ? api(`/schedule-lookahead?from=${from}&to=${to}`)
          : Promise.resolve(
              projectRows.filter(
                (r) =>
                  r.window_start <= to &&
                  r.window_end >= from &&
                  r.status !== "cancelled",
              ),
            ),
        api(
          (all
            ? "/servicetitan/schedule"
            : "/projects/" + project.id + "/servicetitan/schedule") +
            "?from=" +
            from +
            "&to=" +
            to,
        ),
      ]);
      if (revision !== generation) return;
      if (pmResult.status === "rejected") throw pmResult.reason;
      let source;
      if (stResult.status === "fulfilled") {
        source = stResult.value;
        stCache.set(key, source);
        el("planning-st-status").textContent = !source.configured
          ? "ServiceTitan is not configured for this account."
          : !source.linkedProjects
            ? "Connect this project to ServiceTitan to include technician jobs."
            : source.rows.length +
              " ST appointments · Times shown in America/New_York · Refreshed " +
              new Date(source.observedAt).toLocaleTimeString();
      } else {
        source = stCache.get(key);
        el("planning-st-status").textContent =
          "ST schedule could not refresh. " +
          (source
            ? "Showing the last successful ST read from " +
              new Date(source.observedAt).toLocaleString() +
              ". "
            : "Only PM activities are shown. ") +
          stResult.reason.message;
      }
      stRows = source?.rows ?? [];
      let rows = [...pmResult.value, ...stRows];
      if (revision !== generation) return;
      const phase = el("planning-phase").value;
      const filter = el("planning-filter").value;
      rows = rows.filter(
        (r) =>
          (!phase || r.phase === phase) &&
          (filter === "all" ||
            (filter === "unassigned"
              ? issues(r, day()).includes("Unassigned")
              : issues(r, day()).length > 0)),
      );
      rows = rows
        .map((r) => ({ ...r, project_id: r.project_id ?? project.id }))
        .sort((a, b) => a.window_start.localeCompare(b.window_start));
      const visible = rows.filter((r) => r.status !== "cancelled");
      el("planning-summary").innerHTML = [
        [visible.length, "Activities in view"],
        [
          visible.filter((r) => r.source === "servicetitan").length,
          "ST appointments",
        ],
        [visible.filter((r) => r.status === "complete").length, "Complete"],
        [
          visible.filter((r) => issues(r, day()).length).length,
          "Need attention",
        ],
      ]
        .map(
          ([n, label]) =>
            `<div><strong>${n}</strong><span>${label}</span></div>`,
        )
        .join("");
      el("planning-rows").innerHTML = renderScheduleBoard({
        rows,
        from,
        view: el("planning-view").value,
        all,
        projectId: project.id,
        editable: can("advance_stage"),
        esc,
        today: day(),
      });
      el("planning-rows")
        .querySelectorAll("[data-st-appointment]")
        .forEach((b) =>
          b.addEventListener("click", () => {
            const r = stRows.find((r) => r.id === b.dataset.stAppointment);
            if (!r) return;
            const time = (v) =>
              new Date(v).toLocaleString("en-US", {
                timeZone: r.time_zone,
                dateStyle: "medium",
                timeStyle: "short",
              });
            openDrawer(
              "ServiceTitan appointment",
              `<h3>${esc(r.title)}</h3><p>${esc(r.project_name)}</p><p><strong>${esc(time(r.appointment_start))} → ${esc(time(r.appointment_end))}</strong><br>America/New_York · ${esc(r.source_status)}</p><p>Technicians: ${esc(r.resources.map((x) => x.name).join(", ") || "Unassigned")}</p><p>${esc(r.summary?.replace(/<[^>]*>/g, " ") || "")}</p><p>This appointment is owned by ServiceTitan. Refresh the schedule after changes in ST.</p>${r.project_id === current().id && r.job_link_id ? '<button class="btn" id="st-schedule-dispatch">Open dispatch review</button>' : ""}`,
              () =>
                el("st-schedule-dispatch")?.addEventListener("click", () =>
                  sourceViews.dispatch(r.job_link_id, r.title),
                ),
            );
          }),
        );
      el("planning-rows")
        .querySelectorAll("[data-plan-edit]")
        .forEach((b) =>
          b.addEventListener("click", () =>
            activity(projectRows.find((r) => r.id === b.dataset.planEdit)),
          ),
        );
    } catch (e) {
      if (revision === generation) el("planning-rows").textContent = e.message;
    }
  }
  async function activity(item) {
    const projectId = current().id;
    try {
      const [resources, jobs, vendors, catalog, directory] = await Promise.all([
        api("/resources"),
        api(`/projects/${projectId}/jobs`),
        api("/vendors?per_page=200"),
        api("/planning-catalog"),
        api("/technicians"),
      ]);
      if (current().id !== projectId) return;
      const choices = (values, value) =>
        '<option value="">Select…</option>' +
        [...new Set([...values, ...(value ? [value] : [])])]
          .map(
            (v) =>
              '<option value="' +
              esc(v) +
              '" ' +
              (v === value ? "selected" : "") +
              ">" +
              esc(v) +
              "</option>",
          )
          .join("");
      const availableTechs = [
        ...directory.technicians,
        ...(item?.resources ?? [])
          .filter(
            (r) =>
              r.kind === "employee" &&
              !directory.technicians.some((t) => t.id === r.id),
          )
          .map((r) => ({ ...r, name: r.name + " (previous assignment)" })),
      ];
      const predecessors = projectRows.filter((r) => r.id !== item?.id);
      const dependencies = item?.dependencies ?? [];
      openDrawer(
        item ? "Edit activity" : "Schedule activity",
        `${messageSlot}
        ${field(
          "Activity type",
          `<select id="plan-type">${choices(
            catalog.activities.map((a) => a.name),
            item?.activity_type,
          )}<option value="Custom">Custom activity</option></select>`,
        )}
        ${field("Activity / scope detail", `<input id="plan-title" value="${esc(item?.title ?? "")}" maxlength="200">`)}
        ${field("Phase", `<select id="plan-phase">${choices(catalog.phases, item?.phase)}</select>`)}
        ${field("Trade", `<select id="plan-trade">${choices(catalog.trades, item?.trade)}</select>`)}
        <div class="two">${field("Start", `<input id="plan-start" type="date" value="${esc(item?.window_start ?? day())}">`)}${field("End", `<input id="plan-end" type="date" value="${esc(item?.window_end ?? day())}">`)}</div>
        ${field("Active ServiceTitan technicians — select one or more", `<select id="plan-technicians" multiple size="5">${availableTechs.map((r) => `<option value="${r.id}" ${item?.resources?.some((x) => x.id === r.id) ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>`)}
        <p class="hint">${directory.configured ? "Select multiple technicians with Ctrl. Refresh the directory to get the latest active technicians." : "ST technician connection is not configured yet."}</p>
        <button class="btn sm" id="tech-refresh" type="button" ${directory.configured ? "" : "disabled"}>Refresh ST technicians</button>
        <fieldset class="pm-resource-picker"><legend>Trade crews</legend>
        ${
          resources
            .filter((r) => r.kind !== "employee")
            .map(
              (r) =>
                `<label><input type="checkbox" data-resource="${r.id}" ${item?.resources?.some((x) => x.id === r.id) ? "checked" : ""}><span><strong>${esc(r.name)}</strong><small>${esc(r.trade || r.kind)}</small></span></label>`,
            )
            .join("") || "<p>No trade crews added.</p>"
        }</fieldset>
        ${field("Vendor", `<select id="plan-vendor"><option value="">None</option>${vendors.map((v) => `<option value="${v.id}" ${v.id === item?.vendor_id ? "selected" : ""}>${esc(v.legal_name)}</option>`).join("")}</select>`)}
        ${item?.staff_id ? `<p class="hint">Existing staff assignment: ${esc(item.staff_name)}. This is preserved.</p>` : ""}
        ${field(
          "Linked job",
          `<select id="plan-job"><option value="">None</option>${options(
            jobs.filter(
              (j) => j.source_active !== false || j.id === item?.job_link_id,
            ),
            [item?.job_link_id],
          )}</select>`,
        )}
        <fieldset><legend>Finish-to-start predecessors</legend><p class="hint">The successor starts after the predecessor's last day, plus any waiting days.</p>
        ${
          predecessors
            .map((p) => {
              const d = dependencies.find((d) => d.predecessor_id === p.id);
              return `<div class="planning-dependency"><label><input type="checkbox" data-pred="${p.id}" ${d ? "checked" : ""}> ${esc(p.title)}</label><label>Waiting days <input type="number" data-lag="${p.id}" min="0" max="365" value="${d?.lag_days ?? 0}"></label></div>`;
            })
            .join("") ||
          '<p class="hint">Add another activity to create a dependency.</p>'
        }</fieldset>
        ${field("Status", `<select id="plan-status">${["proposed", "confirmed", "in_progress", "complete", "cancelled"].map((v) => `<option ${v === (item?.status ?? "proposed") ? "selected" : ""} value="${v}">${v.replace("_", " ")}</option>`).join("")}</select>`)}
        ${item ? '<button class="btn" id="plan-impact" type="button">Preview downstream impact</button><div id="plan-impact-results" role="status"></div>' : ""}
        <div class="actions right"><button class="btn primary" id="plan-save" type="button">Save activity</button></div>`,
        () => {
          el("plan-type").addEventListener("change", () => {
            const chosen = catalog.activities.find(
              (a) => a.name === el("plan-type").value,
            );
            if (chosen) {
              el("plan-title").value = chosen.name;
              el("plan-phase").value = chosen.phase;
              el("plan-trade").value = chosen.trade;
            }
          });
          el("tech-refresh").addEventListener("click", async (e) => {
            e.target.disabled = true;
            try {
              await api("/technicians/refresh", { method: "POST" });
              const d = await api("/technicians");
              const selected = [...el("plan-technicians").selectedOptions].map(
                (o) => o.value,
              );
              const previous = Array.from(
                el("plan-technicians").selectedOptions,
                (o) => ({ id: o.value, name: o.textContent }),
              );
              const choices = [
                ...d.technicians,
                ...previous.filter(
                  (o) => !d.technicians.some((t) => t.id === o.id),
                ),
              ];
              el("plan-technicians").innerHTML = choices
                .map(
                  (r) =>
                    '<option value="' +
                    r.id +
                    '" ' +
                    (selected.includes(r.id) ? "selected" : "") +
                    ">" +
                    esc(r.name) +
                    "</option>",
                )
                .join("");
            } catch (error) {
              e.target.textContent = error.message;
            } finally {
              e.target.disabled = false;
            }
          });
          el("plan-impact")?.addEventListener("click", async (e) => {
            e.target.disabled = true;
            try {
              const r = await api(
                "/projects/" + projectId + "/schedule-proposal",
                {
                  method: "POST",
                  body: JSON.stringify({
                    activity_id: item.id,
                    start: el("plan-start").value,
                  }),
                },
              );
              el("plan-impact-results").innerHTML =
                "<p>" +
                esc(r.calendar) +
                ". Preview only; no dates changed.</p>" +
                r.changes
                  .map(
                    (c) =>
                      "<p><strong>" +
                      esc(c.title) +
                      "</strong><br>" +
                      esc(c.before.start) +
                      " → " +
                      esc(c.after.start) +
                      " (finish " +
                      esc(c.after.end) +
                      ")</p>",
                  )
                  .join("");
              if (r.changes.length) {
                const apply = document.createElement("button");
                apply.type = "button";
                apply.className = "btn";
                apply.textContent = "Apply revised PM dates";
                el("plan-impact-results").append(apply);
                apply.addEventListener("click", async () => {
                  apply.disabled = true;
                  try {
                    await api("/projects/" + projectId + "/schedule-proposal", {
                      method: "POST",
                      body: JSON.stringify({
                        activity_id: item.id,
                        start: el("plan-start").value,
                        apply: true,
                        expected: r.fingerprint,
                      }),
                    });
                    el("plan-impact-results").textContent =
                      "PM plan updated. Review linked ST appointments before publishing dispatch changes.";
                    el("plan-save").disabled = true;
                    await refresh();
                  } catch (error) {
                    el("plan-impact-results").textContent = error.message;
                  }
                });
              }
            } catch (error) {
              el("plan-impact-results").textContent = error.message;
            } finally {
              e.target.disabled = false;
            }
          });
          el("plan-save").addEventListener("click", (e) =>
            submit(e.target, () =>
              api(
                item
                  ? `/schedule/${item.id}`
                  : `/projects/${projectId}/schedule`,
                {
                  method: item ? "PATCH" : "POST",
                  body: JSON.stringify({
                    title: el("plan-title").value.trim(),
                    phase: el("plan-phase").value || null,
                    trade: el("plan-trade").value || null,
                    activity_type: el("plan-type").value || null,
                    window_start: el("plan-start").value,
                    window_end: el("plan-end").value,
                    resource_ids: [
                      ...[...el("plan-technicians").selectedOptions].map(
                        (o) => ({ dataset: { resource: o.value } }),
                      ),
                      ...document.querySelectorAll("[data-resource]:checked"),
                    ].map((r) => r.dataset.resource),
                    vendor_id: el("plan-vendor").value || null,
                    job_link_id: el("plan-job").value || null,
                    status: el("plan-status").value,
                    dependencies: [
                      ...document.querySelectorAll("[data-pred]:checked"),
                    ].map((p) => ({
                      predecessor_id: p.dataset.pred,
                      lag_days: Number(
                        document.querySelector(`[data-lag="${p.dataset.pred}"]`)
                          .value,
                      ),
                    })),
                  }),
                },
              ),
            ),
          );
        },
      );
    } catch (e) {
      el("planning-rows").textContent = e.message;
    }
  }
  async function resource() {
    try {
      const [vendors, crewCatalog] = await Promise.all([
        api("/vendors?per_page=200"),
        api("/planning-catalog"),
      ]);
      openDrawer(
        "Add trade crew",
        `${messageSlot}
        ${field("Name", '<input id="res-name" maxlength="200" placeholder="Alex / Tile crew A">')}
        ${field("Type", '<select id="res-kind"><option value="crew">Internal crew</option><option value="subcontractor">Subcontractor crew</option></select>')}
        ${field("Trade", `<select id="res-trade">${crewCatalog.trades.map((t) => `<option>${esc(t)}</option>`).join("")}</select>`)}
        ${field("Vendor — required for subcontractors", `<select id="res-vendor"><option value="">None</option>${vendors.map((v) => `<option value="${v.id}">${esc(v.legal_name)}</option>`).join("")}</select>`)}
        <p class="hint">This creates a scheduling resource. It does not create a login or connect a technician to the dispatch system.</p>
        <button class="btn primary" id="res-save" type="button">Add resource</button>`,
        () =>
          el("res-save").addEventListener("click", (e) =>
            submit(e.target, () =>
              api("/resources", {
                method: "POST",
                body: JSON.stringify({
                  name: el("res-name").value.trim(),
                  kind: el("res-kind").value,
                  trade: el("res-trade").value.trim() || null,
                  vendor_id: el("res-vendor").value || null,
                }),
              }),
            ),
          ),
      );
    } catch (e) {
      el("planning-rows").textContent = e.message;
    }
  }
  async function jobs() {
    const projectId = current().id;
    try {
      const [systems, links, source] = await Promise.all([
        api("/external-systems"),
        api(`/projects/${projectId}/jobs`),
        api(`/projects/${projectId}/servicetitan`),
      ]);
      openDrawer(
        "Project job links",
        `${messageSlot}<p class="hint">${source.connection ? "Jobs come from ServiceTitan. Use ServiceTitan project → Refresh to update this list." : "Connect this project to ServiceTitan to pull its jobs."}</p>
        ${links.map((j) => `<div class="row"><div class="row-b"><strong>${esc(j.title)}</strong><div class="row-m">${esc(j.system_name)} · ${esc(j.source_job_number || j.external_job_id)} · ${esc(j.source_job_status || "")}${j.source_active === false ? " · No longer on this ST project" : ""}</div></div>${j.source_active === false ? "" : `<button class="btn sm" data-dispatch="${j.id}" type="button">Dispatch</button>`}${source.connection ? "" : `<button class="btn sm" data-unlink="${j.id}" type="button">Unlink</button>`}</div>`).join("") || "<p>No jobs linked yet.</p>"}
        ${
          source.connection
            ? ""
            : ` ${field("Job title", '<input id="job-title" maxlength="200">')}
        ${field("System", `<select id="job-system">${systems.map((s) => `<option value="${s.id}">${esc(s.display_name)}</option>`).join("")}</select>`)}
        ${field("External job ID", '<input id="job-external" maxlength="200">')}
        <button class="btn primary" id="job-save" type="button" ${systems.length ? "" : "disabled"}>Link job</button>`
        }`,
        () => {
          document
            .querySelectorAll("[data-dispatch]")
            .forEach((b) =>
              b.addEventListener("click", () =>
                sourceViews.dispatch(
                  b.dataset.dispatch,
                  links.find((j) => j.id === b.dataset.dispatch)?.title ??
                    "Job",
                ),
              ),
            );
          el("job-save")?.addEventListener("click", (e) =>
            submit(e.target, () =>
              api(`/projects/${projectId}/jobs`, {
                method: "POST",
                body: JSON.stringify({
                  title: el("job-title").value.trim(),
                  external_system_id: el("job-system").value,
                  external_job_id: el("job-external").value.trim(),
                }),
              }),
            ),
          );
          document.querySelectorAll("[data-unlink]").forEach((b) =>
            b.addEventListener("click", (e) =>
              submit(e.target, () =>
                api(`/projects/${projectId}/jobs/${b.dataset.unlink}`, {
                  method: "DELETE",
                }),
              ),
            ),
          );
        },
      );
    } catch (e) {
      el("planning-rows").textContent = e.message;
    }
  }
  el("planning-vendors").addEventListener("click", subcontractors.directory);
  el("planning-new").addEventListener("click", () => activity());
  el("planning-resource").addEventListener("click", resource);
  el("planning-job").addEventListener("click", jobs);
  el("planning-from").addEventListener("change", lookahead);
  el("planning-all").addEventListener("change", lookahead);
  for (const id of ["planning-view", "planning-phase", "planning-filter"])
    el(id).addEventListener("change", lookahead);
  el("planning-prev").addEventListener("click", () => {
    el("planning-from").value = addDays(
      el("planning-from").value || day(),
      -14,
    );
    void lookahead();
  });
  el("planning-next").addEventListener("click", () => {
    el("planning-from").value = addDays(el("planning-from").value || day(), 14);
    void lookahead();
  });
  el("planning-today").addEventListener("click", () => {
    el("planning-from").value = day();
    void lookahead();
  });
  return { render, activity, resource, refresh: lookahead };
}
