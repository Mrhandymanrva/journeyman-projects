import { roleTitle } from "./roleTitles.js";
import { SCHEDULE_CAPTION } from "./scheduleDefinition.js";

/**
 * Where to land after sign-in.
 * A ?project= link opens that project. A hash for a project page opens the
 * last project when one is remembered. Otherwise Home.
 */
export function landingChoice({
  search,
  hash,
  rememberedProjectId,
  projectPages,
}) {
  const projectId = new URLSearchParams(search || "").get("project");
  if (projectId) return { kind: "project", projectId };
  const page = String(hash || "").replace(/^#/, "");
  if (
    page &&
    page !== "home" &&
    Array.isArray(projectPages) &&
    projectPages.includes(page) &&
    rememberedProjectId
  ) {
    return { kind: "project", projectId: rememberedProjectId };
  }
  return { kind: "home" };
}

export function revealLinkedItem() {
  const id = new URLSearchParams(location.search).get("item");
  if (!id) return;
  const node = document.getElementById("item-" + id);
  if (node) node.scrollIntoView({ block: "center" });
}

const STAGE_LABELS = {
  handoff: "Handoff",
  precon: "Precon",
  mobilization: "Mobilization",
  execution: "Execution",
  closeout: "Closeout",
  complete: "Complete",
  cancelled: "Cancelled",
};

const TYPE_LABELS = {
  wbs_task: "WBS task",
  precon_task: "Precon task",
  milestone: "Milestone",
  permit_milestone: "Permit milestone",
  activity: "Gantt activity",
  appointment: "ServiceTitan appointment",
};

const LIFECYCLE_LABELS = {
  open: "Open",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function homeShellHtml() {
  return `<header class="workspace-page-heading home-heading"><div><p class="nav-label">HOME</p><h1>Projects</h1><p>Every project you can open, at a glance.</p></div></header>
<div class="home-layout">
  <section class="card home-projects" aria-label="Projects">
    <div class="card-h home-card-h">
      <div><h2>Projects</h2><p class="home-count" id="home-count"></p></div>
      <div class="home-filters">
        <div class="home-status" role="radiogroup" aria-label="Project status">
          <button type="button" class="chip" data-home-status="open" aria-pressed="true">Open</button>
          <button type="button" class="chip" data-home-status="completed" aria-pressed="false">Completed</button>
          <button type="button" class="chip" data-home-status="all" aria-pressed="false">All</button>
          <button type="button" class="chip" data-home-status="cancelled" aria-pressed="false">Cancelled</button>
        </div>
        <label>Stage <select id="home-stage" aria-label="Stage"><option value="">All stages</option></select></label>
        <label>PM <select id="home-pm" aria-label="Project manager"><option value="">All project managers</option></select></label>
        <label class="home-search-label">Search <input id="home-search" type="search" placeholder="Name, number, or customer" autocomplete="off"></label>
      </div>
    </div>
    <div class="card-b home-table-wrap" id="home-projects-body"></div>
  </section>
  <div class="home-side">
    <section class="card" id="home-due" aria-label="Due today and overdue">
      <div class="card-h"><div><h2>Due today / overdue</h2><p class="home-count">${SCHEDULE_CAPTION}.</p></div></div>
      <div class="card-b" id="home-due-body"></div>
    </section>
    <section class="card home-handoff-slot" id="home-handoffs" data-slot="new-handoffs" aria-label="New hand-offs">
      <div class="card-h"><div><h2>New hand-offs <span class="handoff-badge" id="home-handoff-count" data-count="0">0</span></h2><p class="home-count">Submitted, waiting for the Project Coordinator.</p></div></div>
      <div class="card-b" id="home-handoff-body" data-handoff-body></div>
    </section>
  </div>
</div>`;
}

function stageLabel(stage) {
  return STAGE_LABELS[stage] || String(stage || "").replace(/_/g, " ");
}

function formatDay(iso) {
  if (!iso) return "—";
  const [year, month, day] = String(iso).slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return "—";
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function ownerLabel(item) {
  if (item.owner_name) return item.owner_name;
  if (item.owner_role) return roleTitle(item.owner_role);
  return "Unassigned";
}

export function projectTableHtml(projects, esc) {
  if (!projects.length) {
    return '<p class="home-empty">No projects match these filters.</p>';
  }
  const rows = projects
    .map((project) => {
      const milestone = project.next_milestone;
      const health = project.health || { score: 100, band: "green" };
      const band = ["green", "yellow", "red"].includes(health.band)
        ? health.band
        : "green";
      const bandLabel = band === "yellow" ? "Yellow" : band === "red" ? "Red" : "Green";
      const reasons = Array.isArray(health.reasons)
        ? health.reasons.map((reason) => reason.detail).filter(Boolean).join(". ")
        : "";
      return `<tr class="home-row" data-home-project="${esc(project.id)}" tabindex="0">
        <th scope="row"><a href="/?project=${esc(project.id)}#dashboard">${esc(project.name)}</a><small>${esc(project.project_number)}</small></th>
        <td>${esc(project.customer || "—")}</td>
        <td>${esc(stageLabel(project.stage))}</td>
        <td>${esc(LIFECYCLE_LABELS[project.lifecycle] || project.lifecycle)}</td>
        <td>${esc(project.pm_name || "—")}</td>
        <td><span class="health-band health-${band}" title="${esc(reasons || "Health score " + health.score)}">${bandLabel} · ${esc(health.score)}</span></td>
        <td>${milestone ? esc(milestone.title) : "—"}</td>
        <td>${milestone ? esc(formatDay(milestone.due_on)) : "—"}</td>
      </tr>`;
    })
    .join("");
  return `<table class="home-table"><thead><tr><th>Project</th><th>Customer</th><th>Stage</th><th>Status</th><th>PM</th><th>Health</th><th>Next milestone</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const OFFICE_LABELS = {
  richmond: "Richmond",
  hampton_newport_news: "Hampton-Newport News",
};

function handoffWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function handoffListHtml(items, esc, canAcknowledge) {
  if (!items.length) {
    return '<p class="home-empty">No hand-offs are waiting.</p>';
  }
  return items
    .map((item) => {
      const office =
        OFFICE_LABELS[item.office] || item.office_label || item.office || "";
      const when = handoffWhen(item.submitted_at);
      const customer = String(item.customer_name || "").trim() || "Not in ServiceTitan";
      const meta = [customer, office, when].filter(Boolean).join(" · ");
      const action = canAcknowledge
        ? `<button class="btn sm" type="button" data-handoff-acknowledge="${esc(item.project_id)}">Acknowledge</button>`
        : "";
      return `<article class="handoff-row">
        <a href="${esc(item.href || "/?project=" + item.project_id + "#dashboard")}">${esc(item.project_name)}</a>
        <p>${esc(meta)}</p>
        <p class="handoff-scope">${esc(item.scope_summary || "")}</p>
        ${action}
      </article>`;
    })
    .join("");
}

export function dueListHtml(items, esc) {
  if (!items.length) {
    return '<p class="home-empty">Nothing is due today or overdue.</p>';
  }
  return items
    .map((item) => {
      const flag = item.overdue ? "Overdue" : "Due today";
      return `<a class="due-row${item.overdue ? " overdue" : ""}" href="${esc(item.href)}">
        <span class="due-project">${esc(item.project_name)}</span>
        <span class="due-type">${esc(TYPE_LABELS[item.item_type] || item.item_type)}</span>
        <span class="due-title">${esc(item.title)}</span>
        <span class="due-date">${esc(formatDay(item.due_on))}</span>
        <span class="due-owner">${esc(ownerLabel(item))}</span>
        <span class="due-flag">${flag}</span>
      </a>`;
    })
    .join("");
}

export function createHome({ el, esc, api, openProject, can }) {
  const filters = { status: "open", stage: "", pm_id: "", q: "" };
  let searchTimer = 0;
  let painted = false;

  function root() {
    return el("home");
  }

  function paintShell() {
    const node = root();
    if (!node || painted) return;
    painted = true;
    node.innerHTML = homeShellHtml();
    node.querySelectorAll("[data-home-status]").forEach((button) => {
      button.addEventListener("click", () => {
        filters.status = button.dataset.homeStatus;
        void refreshBoard();
      });
    });
    node.querySelector("#home-stage").addEventListener("change", (event) => {
      filters.stage = event.target.value;
      void refreshBoard();
    });
    node.querySelector("#home-pm").addEventListener("change", (event) => {
      filters.pm_id = event.target.value;
      void refreshBoard();
    });
    node.querySelector("#home-search").addEventListener("input", (event) => {
      filters.q = event.target.value.trim();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => void refreshBoard(), 200);
    });
    node.addEventListener("click", (event) => {
      const acknowledge = event.target.closest("[data-handoff-acknowledge]");
      if (acknowledge) {
        event.preventDefault();
        void acknowledgeHandoff(acknowledge.dataset.handoffAcknowledge, acknowledge);
        return;
      }
      const due = event.target.closest("a.due-row");
      if (due) {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        const url = new URL(due.getAttribute("href"), location.origin);
        history.pushState(null, "", url.pathname + url.search + url.hash);
        const projectId = url.searchParams.get("project");
        if (projectId) void openProject(projectId);
        return;
      }
      const row = event.target.closest("[data-home-project]");
      if (!row) return;
      const anchor = event.target.closest("a");
      if (anchor) event.preventDefault();
      const url = new URL(location.href);
      url.searchParams.set("project", row.dataset.homeProject);
      url.searchParams.delete("plan");
      url.searchParams.delete("item");
      url.hash = "dashboard";
      history.pushState(null, "", url.pathname + url.search + url.hash);
      void openProject(row.dataset.homeProject);
    });
    node.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const row = event.target.closest("[data-home-project]");
      if (!row) return;
      event.preventDefault();
      row.click();
    });
  }

  function syncStatus() {
    root().querySelectorAll("[data-home-status]").forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.homeStatus === filters.status),
      );
    });
  }

  function fillSelect(id, current, options, allLabel) {
    const select = root().querySelector("#" + id);
    const value = select.value || current;
    select.innerHTML =
      `<option value="">${esc(allLabel)}</option>` +
      options
        .map(
          (option) =>
            `<option value="${esc(option.value)}">${esc(option.label)}</option>`,
        )
        .join("");
    select.value = [...select.options].some((option) => option.value === value)
      ? value
      : "";
  }

  async function refreshBoard() {
    paintShell();
    syncStatus();
    const params = new URLSearchParams();
    params.set("status", filters.status || "open");
    if (filters.stage) params.set("stage", filters.stage);
    if (filters.pm_id) params.set("pm_id", filters.pm_id);
    if (filters.q) params.set("q", filters.q);
    const body = root().querySelector("#home-projects-body");
    try {
      const board = await api("/home?" + params.toString());
      fillSelect(
        "home-stage",
        filters.stage,
        (board.facets?.stages || []).map((stage) => ({
          value: stage,
          label: stageLabel(stage),
        })),
        "All stages",
      );
      fillSelect(
        "home-pm",
        filters.pm_id,
        (board.facets?.project_managers || []).map((pm) => ({
          value: pm.id,
          label: pm.name,
        })),
        "All project managers",
      );
      const count = board.projects.length;
      root().querySelector("#home-count").textContent =
        count + (count === 1 ? " project" : " projects");
      body.innerHTML = projectTableHtml(board.projects, esc);
    } catch (error) {
      body.textContent = error.message;
    }
  }

  async function refreshDue() {
    paintShell();
    const body = root().querySelector("#home-due-body");
    try {
      const due = await api("/home/due");
      body.innerHTML = dueListHtml(due.items || [], esc);
    } catch (error) {
      body.textContent = error.message;
    }
  }

  async function refreshHandoffs() {
    paintShell();
    const body = root().querySelector("#home-handoff-body");
    const badge = root().querySelector("#home-handoff-count");
    try {
      const waiting = await api("/home/handoffs");
      const items = waiting.items || [];
      const count = Number.isFinite(waiting.count) ? waiting.count : items.length;
      if (badge) {
        badge.textContent = String(count);
        badge.dataset.count = String(count);
        badge.setAttribute(
          "aria-label",
          count === 1 ? "1 new hand-off" : count + " new hand-offs",
        );
      }
      body.innerHTML = handoffListHtml(items, esc, can?.("acknowledge_csr_handoff"));
    } catch (error) {
      body.textContent = error.message;
    }
  }

  async function acknowledgeHandoff(projectId, button) {
    button.disabled = true;
    try {
      await api("/projects/" + projectId + "/handoff/acknowledge", {
        method: "POST",
      });
      await refreshHandoffs();
    } catch (error) {
      button.disabled = false;
      const note = document.createElement("p");
      note.className = "home-empty";
      note.textContent = error.message;
      root().querySelector("#home-handoff-body").prepend(note);
    }
  }

  async function render() {
    paintShell();
    await Promise.all([refreshBoard(), refreshDue(), refreshHandoffs()]);
  }

  return { render };
}
