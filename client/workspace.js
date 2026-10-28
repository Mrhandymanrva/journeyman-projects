import { bindFinancialSections } from "./financialsSections.js";
import { revealLinkedItem } from "./home.js";
import { bindFieldStart, fieldStartHtml } from "./fieldRelease.js";
import { createPermitOffices } from "./permitOffices.js";
import {openProjectDeletion} from "./projectDeletion.js";
import {createAccounting} from "./accounting.js";
import { createProjectControls } from "./projectControls.js";
import { scheduleProgress, appointmentReadWindow } from "./scheduleProgress.js";
import { createUsers } from "./users.js";
import { createSubcontractors } from "./subcontractors.js";
import { issues } from "./scheduleBoard.js";
import { roleTitle } from "./roleTitles.js";
import {
  LABOR_PAGE_ID,
  PRECON_ROLE_NOTE,
  PROJECT_PAGE_ALIASES,
  PROJECT_PAGE_ID,
  PROJECT_PAGE_ORDER,
  SHOW_COMMUNICATIONS_TAB,
  navEntries,
  workspacePages,
} from "./workspaceNav.js";
export function createWorkspace({
  api,
  el,
  esc,
  can,
  current,
  planning,
  openDrawer,
  closeDrawer,
  field,
  onProjectDeleted,
  reload,
  renderHome,
  onNeedProject,
}) {
  const offices = createPermitOffices({
    api,
    esc,
    can,
    openDrawer,
    closeDrawer,
  });
  const accounting=createAccounting({api,el,esc,can,current,openDrawer,closeDrawer});
  const users = createUsers({ api, el, esc, openDrawer, closeDrawer, can });
  const controls = createProjectControls({
    api,
    el,
    esc,
    can,
    current,
    openDrawer,
    closeDrawer,
  });
  const pages = workspacePages;
  const icons = {
    plan: "▥",
    documents: "▧",
    risks: "△",
    communications: "◉",
    users: "♙",
    settings: "⚙",
    dashboard: "▦",
    bids: "◇",
    resources: "♧",
    financials: "＄",
    logs: "▧",
    [PROJECT_PAGE_ID]: "⌂",
    offices: "▣",
  };
  let active = "dashboard",
    data = null,
    epoch = 0;
  const shell = el("shell");
  const sidebar = document.createElement("aside");
  sidebar.className = "workspace-sidebar";
  sidebar.innerHTML = `<a class="workspace-brand" href="#home"><span class="brand-mark">J</span><span>Journeyman<small>PROJECTS</small></span></a><div id="project-context"></div><p class="nav-label">WORKSPACE</p><nav aria-label="Project workspace"><a href="#home" data-page="home"><span aria-hidden="true">⌂</span>Home</a>${navEntries(
    SHOW_COMMUNICATIONS_TAB,
  )
    .map(
      ([id, [name]]) =>
        `<a href="#${id}" data-page="${id}"><span aria-hidden="true">${icons[id]}</span>${name}</a>`,
    )
    .join(
      "",
    )}</nav><div class="sidebar-note"><span class="connection-dot"></span>ServiceTitan connected projects<small>One project. One place to manage the work.</small></div>`;
  document.body.prepend(sidebar);
  el("project-context").append(el("switch"), el("project-new"));
  document.querySelector(".mark span").textContent = "Project workspace";
  const main = document.createElement("div");
  main.className = "workspace-content";
  main.innerHTML = `<header class="workspace-page-heading"><div><p class="nav-label">PROJECT WORKSPACE</p><h1 id="workspace-title" tabindex="-1">Dashboard</h1><p id="workspace-description"></p></div><span id="workspace-date"></span></header>${Object.keys(
    pages,
  )
    .map(
      (id) =>
        `<section id="page-${id}" class="workspace-page" aria-label="${pages[id][0]}" ${id === "dashboard" ? "" : "hidden"}></section>`,
    )
    .join("")}`;
  shell.append(main);
  function move(id, page, card = false) {
    const node = el(id);
    el("page-" + page).append(card ? node.closest(".card") : node);
  }
  el("page-dashboard").innerHTML =
    '<div id="dashboard-overview"></div><div class="dashboard-grid"><div id="dashboard-agenda" class="card"></div><div id="dashboard-attention"></div><div id="dashboard-recent" class="card"></div><div class="card dashboard-financial"><div class="card-h"><h2>Financial snapshot</h2><a href="#financials">View financials →</a></div><div id="dashboard-stats" class="card-b"></div></div></div>';
  el("dashboard-stats").append(el("pstats"));
  el("page-dashboard").insertAdjacentHTML(
    "afterbegin",
    '<div id="dashboard-controls"></div>',
  );
  const handoffCard = el("csr-handoff");
  if (handoffCard) el("page-dashboard").prepend(handoffCard);
  el("page-financials").insertAdjacentHTML(
    "beforeend",
    '<div id="project-payables"></div><div id="project-reserves"></div>',
  );
  el("page-" + PROJECT_PAGE_ID).append(el("blockers").closest(".card"));
  el("blockers").closest(".card").querySelector(".lbl").textContent =
    "Needs attention";
  const planViews = {
    gantt: "Gantt & scheduled work",
    tasks: "Tasks & WBS",
    roadmap: "Roadmap & milestones",
    goals: "Goals & key results",
    status: "RAG status",
    burndown: "Burndown",
  };
  let planView = "gantt";
  el("page-plan").innerHTML =
    '<div class="control-tabs" role="group" aria-label="Plan views">' +
    Object.entries(planViews)
      .map(
        ([id, name]) =>
          '<button class="btn" data-plan-view="' +
          id +
          '" aria-pressed="' +
          (id === planView) +
          '">' +
          name +
          "</button>",
      )
      .join("") +
    '</div><div id="plan-scheduled-work"></div><div id="plan-controls" hidden></div>';
  el("plan-scheduled-work").append(document.querySelector(".pm-workspace"));
  el("plan-scheduled-work").append(el("subs").closest(".card"));
  async function renderPlan() {
    const scheduled = planView === "gantt";
    el("plan-scheduled-work").hidden = !scheduled;
    el("plan-controls").hidden = scheduled;
    document
      .querySelectorAll("[data-plan-view]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.planView === planView),
        ),
      );
    if (scheduled) await planning.refresh();
    else await controls.mount("plan", "plan-controls", planView);
  }
  document.querySelectorAll("[data-plan-view]").forEach((button) => {
    button.onclick = () => {
      planView = button.dataset.planView;
      const url = new URL(location.href);
      url.searchParams.delete("plan");
      url.searchParams.delete("item");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
      void enter("plan");
    };
  });
  function planFromQuery() {
    const requested = new URLSearchParams(location.search).get("plan");
    if (requested && Object.prototype.hasOwnProperty.call(planViews, requested))
      planView = requested;
  }
  for (const id of ["budget", "pos", "cos", "closeout", "draws"])
    move(id, "financials", true);
  move("notice", "financials");
  move("logs", "logs", true);
  for (const id of ["stagebar", "gates"]) move(id, PROJECT_PAGE_ID);
  move("labor", LABOR_PAGE_ID, true);
  move("st-financials", "financials", true);
  const laborCard = el("labor")?.closest(".card");
  const budgetCard = el("budget")?.closest(".card");
  const financialsCard = el("st-financials")?.closest(".card");
  if (financialsCard && budgetCard)
    budgetCard.insertAdjacentElement("beforebegin", financialsCard);
  if (laborCard && budgetCard)
    budgetCard.insertAdjacentElement("afterend", laborCard);
  if (!el("fin-summary")) {
    el("page-financials").insertAdjacentHTML(
      "afterbegin",
      '<div id="fin-summary" class="fin-summary" aria-label="Project financials"></div>',
    );
  }
  bindFinancialSections(el("page-financials"));
  move("permits", PROJECT_PAGE_ID, true);
  el("page-" + PROJECT_PAGE_ID).insertAdjacentHTML(
    "afterbegin",
    `<p class="hint precon-role-note" id="precon-role-note">${PRECON_ROLE_NOTE}</p><div class="card" id="project-facts"></div>`,
  );
  el("project-facts").insertAdjacentHTML(
    "afterend",
    '<div class="card" id="precon"></div>',
  );
  orderProjectPage();
  function orderProjectPage() {
    const page = el("page-" + PROJECT_PAGE_ID);
    for (const id of PROJECT_PAGE_ORDER) {
      const node = el(id);
      if (!node) continue;
      const card = node.closest(".card");
      const target = card && page.contains(card) ? card : node;
      if (target.parentElement === page) page.append(target);
    }
    const note = el("precon-role-note");
    if (note) page.prepend(note);
  }
  const toolbar = document.createElement("div");
  toolbar.className = "workspace-resource-tabs";
  toolbar.innerHTML =
    '<button class="btn" id="resource-directory">Subcontractor directory</button><button class="btn" id="resource-crews">Technicians & crews</button>';
  el("page-resources").append(toolbar);
  el("page-resources").insertAdjacentHTML(
    "beforeend",
    '<div id="resources-content" class="card workspace-records"></div>',
  );
  el("page-bids").innerHTML =
    '<div id="bids-content" class="card workspace-records"></div>';
  el("page-settings").innerHTML = '<div id="company-settings"></div>';
  document.querySelector(".grid")?.remove();
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const nice = (v) =>
    v
      ? new Date(String(v).slice(0, 10) + "T12:00:00").toLocaleDateString(
          "en-US",
          { month: "short", day: "numeric" },
        )
      : "Not set";
  function show(id) {
    active = pages[id] ? id : "dashboard";
    for (const key of Object.keys(pages))
      el("page-" + key).hidden = key !== active;
    document.querySelectorAll("[data-page]").forEach((a) => {
      if (a.dataset.page === active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    el("workspace-title").textContent = pages[active][0];
    el("workspace-description").textContent = pages[active][1];
    el("workspace-date").textContent = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }
  function mountedSubs() {
    const ticket = epoch;
    return createSubcontractors({
      api,
      el,
      esc,
      can,
      current,
      field,
      projectScoped: true,
      openDrawer: (title, body, mount) => {
        if (ticket !== epoch || !["resources", "bids"].includes(active)) return;
        closeDrawer();
        if (title === "Subcontractors") show("resources");
        else if (title === "Bid requests" || title === "Request quotes / bids")
          show("bids");
        history.replaceState(null, "", "#" + active);
        // Only one subcontractor workflow is mounted at a time, preserving unique form IDs.
        el(
          active === "bids" ? "resources-content" : "bids-content",
        ).replaceChildren();
        const target = el(
          active === "bids" ? "bids-content" : "resources-content",
        );
        target.innerHTML =
          `<div class="workspace-record-title"><h2>${esc(title)}</h2></div>` +
          body;
        mount?.();
      },
    });
  }
  function canonicalPage(id) {
    if (id === "schedule") {
      planView = "gantt";
      return "plan";
    }
    if (PROJECT_PAGE_ALIASES.includes(id)) return PROJECT_PAGE_ID;
    return id;
  }
  async function openHome() {
    active = "home";
    epoch++;
    controls.cancel();
    closeDrawer();
    const url = new URL(location.href);
    url.searchParams.delete("project");
    url.searchParams.delete("plan");
    url.searchParams.delete("item");
    url.hash = "home";
    const next = url.pathname + url.search + url.hash;
    if (location.pathname + location.search + location.hash !== next)
      history.replaceState(null, "", next);
    el("shell").hidden = true;
    const home = el("home");
    if (home) home.hidden = false;
    document.querySelectorAll("[data-page]").forEach((a) => {
      if (a.dataset.page === "home") a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    if (renderHome) await renderHome();
  }
  async function enter(id) {
    if (id === "home") {
      await openHome();
      return;
    }
    epoch++;
    controls.cancel();
    closeDrawer();
    planFromQuery();
    const next = canonicalPage(id);
    if (next !== id) {
      const url = new URL(location.href);
      url.hash = next;
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    id = next;
    show(id);
    el("resources-content").replaceChildren();
    el("bids-content").replaceChildren();
    if (!data && active !== "users" && active !== "settings") {
      const opened = onNeedProject ? await onNeedProject() : false;
      if (!opened) await openHome();
      return;
    }
    const home = el("home");
    if (home) home.hidden = true;
    el("shell").hidden = false;
    if (active === "users") {
      await users.render();
      return;
    }
    if (active === "settings") {
      if (!can("manage_company_settings")) {
        if (!data) await openHome();
        else show("dashboard");
        return;
      }
      await accounting.renderSettings();
      return;
    }
    if (!data) return;
    try {
      if (active === "plan") await renderPlan();
      else if (["documents", "risks", "communications"].includes(active))
        await controls.mount(active, "page-" + active);
      else if (active === "financials") {
        await controls.mount("reserves", "project-reserves");
        await accounting.render();
      }
      else if (active === "dashboard")
        void controls.dashboard("dashboard-controls");
      else if (active === "resources") await mountedSubs().directory();
      else if (active === "bids") await mountedSubs().bidList();
      else if (active === "offices") {
        const ticket = epoch;
        await offices.render(el("page-offices"), () => ticket === epoch);
      }
    } catch (error) {
      el(
        active === "plan"
          ? planView === "gantt"
            ? "planning-rows"
            : "plan-controls"
          : active === "bids"
            ? "bids-content"
            : "resources-content",
      ).textContent = error.message;
    }
    revealLinkedItem();
  }
  window.addEventListener("hashchange", () => {
    const id = location.hash.slice(1);
    if (!id || id === "home") {
      void openHome();
      return;
    }
    void enter(id);
  });
  document.querySelectorAll("[data-page]").forEach((a) =>
    a.addEventListener("click", (e) => {
      if (location.hash === "#" + a.dataset.page) {
        e.preventDefault();
        void enter(a.dataset.page);
      }
    }),
  );
  el("resource-directory").onclick = () => void enter("resources");
  let showInactiveCrews = false;
  el("resource-crews").onclick = async () => {
    const ticket = ++epoch,
      target = el("resources-content");
    target.textContent = "Loading technicians and crews...";
    try {
      const rows = await api(
        "/resources" + (showInactiveCrews ? "?include_inactive=true" : ""),
      );
      if (ticket !== epoch) return;
      target.innerHTML = `<div class="workspace-record-title"><div><h2>Technicians & trade crews</h2><p>Manage PM crews here. Imported technicians are managed in ServiceTitan.</p></div>${can("advance_stage") ? '<div><button class="btn" id="crew-sync">Refresh ST technicians</button> <button class="btn primary" id="crew-add">Add trade crew</button></div>' : ""}</div><label><input type="checkbox" id="crew-inactive" ${showInactiveCrews ? "checked" : ""}> Show removed / inactive resources</label><div class="sub-table"><table><thead><tr><th>Name</th><th>Type</th><th>Trade</th><th>Company / source</th><th>Actions</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.name)}${!r.active ? "<small>Inactive</small>" : ""}</td><td>${esc(r.kind)}</td><td>${esc(r.trade || "")}</td><td>${esc(r.source_system_id ? "ServiceTitan" : r.vendor_name || "PM crew")}</td><td>${can("advance_stage") && !r.source_system_id ? `<button class="btn sm" data-crew-edit="${r.id}">Edit</button> <button class="btn sm" data-crew-toggle="${r.id}">${r.active ? "Remove" : "Restore"}</button>` : "Managed in ST"}</td></tr>`).join("") || '<tr><td colspan="5">No matching resources.</td></tr>'}</tbody></table></div><p class="hint">Remove hides a crew from new scheduling selections. Existing assignments remain in project history.</p>`;
      el("crew-inactive").onchange = (e) => {
        showInactiveCrews = e.target.checked;
        el("resource-crews").click();
      };
      el("crew-add")?.addEventListener("click", () => editCrew());
      target
        .querySelectorAll("[data-crew-edit]")
        .forEach(
          (b) =>
            (b.onclick = () =>
              editCrew(rows.find((r) => r.id === b.dataset.crewEdit))),
        );
      target.querySelectorAll("[data-crew-toggle]").forEach(
        (b) =>
          (b.onclick = async () => {
            b.disabled = true;
            try {
              const r = rows.find((r) => r.id === b.dataset.crewToggle);
              await api("/resources/" + r.id, {
                method: "PATCH",
                body: JSON.stringify({ active: !r.active }),
              });
              if (ticket === epoch) el("resource-crews").click();
            } catch (error) {
              const p = document.createElement("p");
              p.textContent = error.message;
              target.prepend(p);
              b.disabled = false;
            }
          }),
      );
      el("crew-sync")?.addEventListener("click", async (e) => {
        e.target.disabled = true;
        try {
          await api("/technicians/refresh", { method: "POST" });
          if (ticket === epoch) el("resource-crews").click();
        } catch (error) {
          const p = document.createElement("p");
          p.textContent = error.message;
          target.prepend(p);
          e.target.disabled = false;
        }
      });
    } catch (error) {
      if (ticket === epoch) target.textContent = error.message;
    }
  };
  async function editCrew(r = null) {
    try {
      const catalog = await api("/planning-catalog"),
        vendors = [];
      for (let page = 1; ; page++) {
        const rows = await api("/vendors?per_page=200&page=" + page);
        vendors.push(...rows);
        if (rows.length < 200) break;
      }
      const trades = [
        ...new Set([...catalog.trades, ...(r?.trade ? [r.trade] : [])]),
      ];
      openDrawer(
        r ? "Edit resource" : "Add trade crew",
        `<form id="crew-form">${field("Name", `<input id="crew-name" required maxlength="200" value="${esc(r?.name || "")}">`)}${field("Type", `<select id="crew-kind"><option value="crew">Internal crew</option><option value="subcontractor" ${r?.kind === "subcontractor" ? "selected" : ""}>Subcontractor crew</option>${r?.kind === "employee" ? '<option value="employee" selected>Local employee</option>' : ""}</select>`)}${field("Trade", `<select id="crew-trade"><option value="">Not specified</option>${trades.map((t) => `<option ${t === r?.trade ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`)}${field("Vendor / subcontractor company", `<select id="crew-vendor"><option value="">None</option>${vendors.map((v) => `<option value="${v.id}" ${v.id === r?.vendor_id ? "selected" : ""}>${esc(v.legal_name)}</option>`).join("")}${r?.vendor_id && !vendors.some((v) => v.id === r.vendor_id) ? `<option value="${r.vendor_id}" selected>${esc(r.vendor_name || "Archived company")}</option>` : ""}</select>`)}<p class="err" id="crew-error" role="alert"></p><button class="btn primary" id="crew-save">Save resource</button></form>`,
      );
      el("crew-form").onsubmit = async (e) => {
        e.preventDefault();
        el("crew-save").disabled = true;
        try {
          await api("/resources" + (r ? "/" + r.id : ""), {
            method: r ? "PATCH" : "POST",
            body: JSON.stringify({
              name: el("crew-name").value.trim(),
              kind: el("crew-kind").value,
              trade: el("crew-trade").value || null,
              vendor_id: el("crew-vendor").value || null,
            }),
          });
          closeDrawer();
          el("resource-crews").click();
        } catch (error) {
          el("crew-error").textContent = error.message;
          el("crew-save").disabled = false;
        }
      };
    } catch (error) {
      openDrawer(
        "Resource could not load",
        "<p>" + esc(error.message) + "</p>",
      );
    }
  }
  let scheduleTicket = 0;
  function paintSchedule(d, appointments, ready) {
    const p = d.detail,
      day = today(),
      progress = scheduleProgress({
        activities: d.schedule || [],
        appointments,
        preconTasks: p.precon?.tasks || [],
        today: day,
      }),
      unfinished = (d.schedule || []).filter(
        (s) => s.status !== "cancelled" && s.status !== "complete",
      ),
      attention = unfinished.filter((s) => issues(s, day).length),
      pct = progress.percent === null ? "—" : progress.percent + "%";
    el("dashboard-overview").dataset.scheduleReady = ready ? "true" : "false";
    el("dashboard-overview").innerHTML =
      `<div class="dashboard-metrics"><a href="#plan"><span>Next 7 days</span><strong>${progress.week.length}</strong><small>on the schedule</small></a><a href="#plan"><span>Needs coordination</span><strong>${attention.length}</strong><small>activities with a flag</small></a><a href="#plan"><span>Project progress</span><strong>${pct}</strong><small>${progress.complete} of ${progress.total} schedule items complete</small><small class="metric-source">${esc(progress.caption)}</small></a><a href="#${PROJECT_PAGE_ID}"><span>Target completion</span><strong class="metric-date">${nice(p.scheduled_end)}</strong><small>${p.source_project_status ? "From ServiceTitan" : "Project target date"}</small></a></div>`;
    el("dashboard-agenda").innerHTML =
      `<div class="card-h"><h2>Coming up this week</h2><a href="#plan">View project plan →</a></div><div class="card-b">${
        progress.week
          .slice(0, 5)
          .map(
            (s) =>
              `<button class="agenda-row" data-week-kind="${esc(s.kind)}" data-agenda="${esc(s.id)}"><span class="agenda-date">${nice(s.start)}</span><span><strong>${esc(s.title)}</strong><small>${esc(s.detail || "No crew assigned")}</small></span><span class="status-pill">${esc(s.status)}</span></button>`,
          )
          .join("") ||
        '<div class="workspace-empty"><strong>Nothing on the schedule in the next 7 days</strong><p>Open the project plan to schedule the next phase of work.</p><a href="#plan">Go to project plan →</a></div>'
      }</div>`;
    el("dashboard-agenda")
      .querySelectorAll("[data-agenda]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            if (b.dataset.weekKind === "precon") {
              location.assign("#" + PROJECT_PAGE_ID);
              return;
            }
            const row =
              b.dataset.weekKind === "activity"
                ? d.schedule.find((s) => s.id === b.dataset.agenda)
                : null;
            if (row && can("advance_stage")) planning.activity(row);
            else location.assign("#plan");
          }),
      );
  }
  function render(d) {
    data = d;
    const requested = location.hash.slice(1);
    if (pages[requested]) active = requested;
    else if (active === "home" || !pages[active]) active = "dashboard";
    const home = el("home");
    if (home) home.hidden = true;
    const p = d.detail,
      day = today();
    paintSchedule(d, [], false);
    const ticket = ++scheduleTicket;
    const window = appointmentReadWindow(day, p);
    api(
      `/projects/${p.id}/plan-appointments?from=${window.from}&to=${window.to}`,
    )
      .then((source) => {
        if (ticket !== scheduleTicket || data !== d) return;
        paintSchedule(d, source?.rows || [], true);
      })
      .catch(() => {
        if (ticket !== scheduleTicket || data !== d) return;
        paintSchedule(d, [], true);
      });
    el("dashboard-attention").innerHTML =
      `<div class="card"><div class="card-h"><h2>Needs attention</h2><a href="#${PROJECT_PAGE_ID}">View all →</a></div><div class="card-b" id="dashboard-issues"></div></div>`;
    const issueRows = [...el("blockers").children];
    for (const row of issueRows.slice(0, 3))
      el("dashboard-issues").append(row.cloneNode(true));
    if (issueRows.length > 3)
      el("dashboard-issues").insertAdjacentHTML(
        "beforeend",
        `<a class="more-issues" href="#${PROJECT_PAGE_ID}">` +
          (issueRows.length - 3) +
          " more items to review →</a>",
      );
    el("dashboard-recent").innerHTML =
      `<div class="card-h"><h2>Recent site updates</h2><a href="#logs">View daily logs →</a></div><div class="card-b">${
        d.logs
          .slice(0, 3)
          .map(
            (l) =>
              `<div class="update-row"><span class="update-dot"></span><div><strong>${esc(l.author || "Site update")} <small>· ${nice(l.log_date)}</small></strong><p>${esc(l.work_completed || "Daily log recorded")}</p></div></div>`,
          )
          .join("") ||
        '<div class="workspace-empty"><strong>No site updates yet</strong><p>Add a daily log to capture progress, deliveries and issues.</p><a href="#logs">Go to daily logs →</a></div>'
      }</div>`;
    el("project-facts").innerHTML =
      `<div class="card-h"><h2>Project information</h2><div><button class="btn" id="project-source">ServiceTitan connection</button> ${can("delete_project") ? '<button class="btn" id="project-delete">Delete project</button>' : ""}</div></div><dl class="project-facts">${[
        ["Project number", p.project_number],
        ["Customer", p.source_customer_name],
        [
          "Service address",
          [p.address_line1, p.city, p.region, p.postal_code]
            .filter(Boolean)
            .join(", "),
        ],
        ["ST status", p.source_project_status],
        [roleTitle("project_manager"), p.pm_name],
        ["Logged start", nice(p.scheduled_start)],
        ["Target completion", nice(p.scheduled_end)],
      ]
        .map(
          ([k, v]) => `<div><dt>${k}</dt><dd>${esc(v || "Not set")}</dd></div>`,
        )
        .join(
          "",
        )}</dl>${fieldStartHtml({
        fieldStart: p.field_start,
        canRefresh: can("refresh_field_start"),
        canOverride: can("set_field_start"),
        esc,
      })}${p.source_project_summary ? `<p class="project-summary">${esc(p.source_project_summary.replace(/<[^>]*>/g, " "))}</p>` : ""}`;
    bindFieldStart(el("project-facts"), {
      onRefresh: async () => {
        await api(`/projects/${p.id}/field-start/refresh`, { method: "POST" });
        if (reload) await reload();
      },
      onOverride: async (date) => {
        await api(`/projects/${p.id}/field-start`, {
          method: "PUT",
          body: JSON.stringify({ date }),
        });
        if (reload) await reload();
      },
    });
    el("project-source").onclick = () => el("st-project-open").click();
    if (el("project-delete")) el("project-delete").onclick = () => openProjectDeletion(p,{api,el,esc,openDrawer,closeDrawer,onProjectDeleted});
    void enter(active);
  }
  if (location.hash === "#schedule" || PROJECT_PAGE_ALIASES.includes(location.hash.slice(1))) {
    const url = new URL(location.href);
    url.hash =
      location.hash === "#schedule" ? "plan" : PROJECT_PAGE_ID;
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  if (pages[location.hash.slice(1)]) show(location.hash.slice(1));
  return {
    render,
    openHome,
    openUsers: () => enter("users"),
    hasPage: (id) => Boolean(pages[id]),
  };
}
