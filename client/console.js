import { bindFieldRelease, fieldReleaseHtml } from "./fieldRelease.js";
import {
  INSPECTION_RESULTS,
  PRECON_STATUSES,
  PRECON_TYPES,
  bindPrecon,
  preconHtml,
} from "./precon.js";
import { roleTitle } from "./roleTitles.js";
import { createWorkspace } from "./workspace.js";
import { createSTProjectConnector } from "./stProjectConnector.js";
import { createPlanning } from "./planning.js";
/** Project data and workflows. workspace.js organizes them into dashboard and navigation views. */

const API = "/api/v1/projects";
const TOKEN_KEY = "jp.token";
let setupToken = location.hash.startsWith("#setup=")
  ? location.hash.slice(7)
  : null;
if (setupToken) history.replaceState(null, "", location.pathname);

const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
const signed = (n) =>
  (n < 0 ? "âˆ’" : "+") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
const el = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

let token = localStorage.getItem(TOKEN_KEY) || "";
let projects = [];
let current = null;
let selectionRevision = 0;
let session = null;
let devLoginEnabled = false;

// ---------------------------------------------------------------- transport

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const text = await res.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, {
        error: {
          message: res.ok
            ? "The server returned a response that was not JSON."
            : `Request failed (${res.status}). The server did not return JSON.`,
        },
      });
    }
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body.data;
}

// ------------------------------------------------------------------ sign in

function showSignIn(message) {
  el("signin").hidden = false;
  el("boot").hidden = true;
  el("signin-error").textContent = message || "";
  el("signin-identity").hidden = !!setupToken;
  el("signin-email").required = !setupToken;
  el("signin-tenant").required = !setupToken;
  el("signin-confirm-label").hidden = !setupToken;
  el("signin-confirm").required = !!setupToken;
  el("signin-dev-label").hidden = !!setupToken || !devLoginEnabled;
  el("signin-reset-help").hidden = !!setupToken;
  el("signin-title").textContent = setupToken
    ? "Choose your password"
    : "Sign in";
  el("signin-submit").textContent = setupToken ? "Set password" : "Sign in";
  el("signin-help").textContent = setupToken
    ? "Use at least 8 characters. A memorable passphrase works well."
    : "Use your company account, email and password.";
  el("signin-token").autocomplete = setupToken
    ? "new-password"
    : "current-password";
}

el("signin-dev").onchange = () => {
  el("signin-secret-label").textContent = el("signin-dev").checked
    ? "Administrator access token"
    : "Password";
};
el("signin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  el("signin-error").textContent = "";
  try {
    const dev = !setupToken && el("signin-dev").checked;
    if (setupToken && el("signin-token").value !== el("signin-confirm").value)
      throw new Error("Passwords do not match.");
    const payload = setupToken
      ? { token: setupToken, password: el("signin-token").value }
      : {
          email: el("signin-email").value.trim(),
          tenant_slug: el("signin-tenant").value.trim(),
          [dev ? "access_token" : "password"]: el("signin-token").value,
        };
    const res = await fetch(
      setupToken
        ? "/api/v1/auth/setup"
        : dev
          ? "/api/v1/dev/session"
          : "/api/v1/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const body = await res.json();
    if (!res.ok) throw new ApiError(res.status, body);
    el("signin-token").value = "";
    el("signin-confirm").value = "";
    if (setupToken) {
      setupToken = null;
      localStorage.removeItem(TOKEN_KEY);
      token = "";
      el("signin-dev").checked = false;
      el("signin-email").value = body.data.email;
      el("signin-tenant").value = body.data.account;
      showSignIn("Password saved. Sign in with your email and new password.");
      return;
    }
    token = dev ? body.data.token : "";
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    el("signin").hidden = true;
    el("boot").hidden = false;
    await boot();
  } catch (err) {
    el("signin-error").textContent = err.message;
  }
});

async function signOut() {
  await fetch("/api/v1/auth/logout", { method: "POST" });
  localStorage.removeItem(TOKEN_KEY);
  token = "";
  location.reload();
}

// --------------------------------------------------------------------- boot

async function boot() {
  try {const cfg=(await (await fetch('/api/v1/auth/config')).json()).data||{};devLoginEnabled=!!cfg.devLoginEnabled;const sso=el('signin-sso');if(sso){sso.hidden=!cfg.ssoEnabled;sso.href=(cfg.ssoStart||'/sso/start')+'?next='+encodeURIComponent(location.pathname+location.search);}} catch {devLoginEnabled=false;}
  if(!devLoginEnabled) el('signin-dev').checked=false;
  if (setupToken) {
    showSignIn();
    return;
  }
  el("boot").hidden = false;
  el("boot").className = "state";
  el("boot").textContent = "Loading…";
  try {
    session = await api("/session");
    el("tenant").textContent = session.tenant.display_name;
    el("who").hidden = false;
    el("who").innerHTML =
      `${esc(session.staff.full_name)} · ${esc(roleTitle(session.staff.role))}` +
      `<button type="button" id="signout">sign out</button>`;
    el("signout").addEventListener("click", signOut);

    document.querySelector('[data-page="users"]').hidden = !can("manage_users");
    document.querySelector('[data-page="settings"]').hidden = !can(
      "manage_company_settings",
    );
    projects = await loadProjects();
    if (projects.length === 0) {
      el("boot").textContent =
        "No projects yet. Choose Add from ServiceTitan to get started.";
      if (location.hash === "#users") await workspace.openUsers();
      return;
    }
    renderSwitch();
    const linkedProject = new URLSearchParams(location.search).get("project");
    if (linkedProject && !projects.some((p) => p.id === linkedProject))
      throw Error(
        "You do not have access to the project in this document link.",
      );
    current =
      projects.find((p) => p.id === linkedProject) ??
      projects.find(
        (p) =>
          p.id ===
          localStorage.getItem("jp.activeProject." + session.tenant.id),
      ) ??
      projects[0];
    await select(current.id);
  } catch (err) {
    if (err.status === 401) {
      showSignIn(token ? "That session is no longer valid." : "");
      return;
    }
    if (err.code === "module_not_entitled") {
      // The one thing a lapsed tenant must still be told: why. The
      // entitlements table is tenant-isolated but deliberately not
      // entitlement-gated so this message can exist at all.
      el("boot").className = "state bad";
      el("boot").textContent = err.message;
      return;
    }
    el("boot").className = "state bad";
    el("boot").textContent = err.message;
  }
}

async function loadProjects() {
  const all = [];
  for (let page = 1; ; page++) {
    const rows = await api("/projects?per_page=200&page=" + page);
    all.push(...rows);
    if (rows.length < 200) return all;
  }
}
function renderSwitch() {
  el("switch").innerHTML =
    '<label class="project-menu-label" for="project-search">Search projects</label>' +
    '<input id="project-search" type="search" placeholder="Project name or number" autocomplete="off" aria-controls="active-project" aria-describedby="project-search-status">' +
    '<label class="project-menu-label" for="active-project">Active project</label>' +
    '<select id="active-project" aria-label="Active project"></select>' +
    '<span id="project-search-status" role="status" aria-live="polite"></span>';
  el("project-search").addEventListener("input", filterProjects);
  el("project-search").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.target.value = "";
      filterProjects();
    }
  });
  el("active-project").addEventListener("change", (event) => {
    if (event.target.value) select(event.target.value);
  });
  filterProjects();
}

function filterProjects() {
  const query = el("project-search").value.trim().toLocaleLowerCase();
  const matches = projects.filter((project) =>
    [project.name, project.project_number].some((value) =>
      String(value ?? "")
        .toLocaleLowerCase()
        .includes(query),
    ),
  );
  const picker = el("active-project");
  const activeMatches = matches.some((project) => project.id === current?.id);
  picker.innerHTML =
    (!activeMatches
      ? '<option value="">' +
        (matches.length ? "Select a project…" : "No matching projects") +
        "</option>"
      : "") +
    matches
      .map(
        (project) =>
          '<option value="' +
          esc(project.id) +
          '">' +
          esc(project.project_number + " — " + project.name) +
          "</option>",
      )
      .join("");
  picker.value = activeMatches ? current.id : "";
  picker.disabled = matches.length === 0;
  el("project-search-status").textContent = query
    ? matches.length
      ? matches.length +
        (matches.length === 1 ? " matching project" : " matching projects")
      : "No matches. Try another name or number."
    : "";
}

const shortName = (name) => String(name).split(" — ")[0];

function pipColour(p) {
  if (p.exception_count === undefined) return "#C3CBC5";
  if (p.exception_count === 0) return "#1D7A4C";
  return p.exception_severity === "bad" ? "#B4231F" : "#F58220";
}

// ------------------------------------------------------------------- select

async function select(projectId) {
  const revision = ++selectionRevision;
  el("shell").hidden = true;
  el("boot").hidden = false;
  el("boot").className = "state";
  el("boot").textContent = "Loading…";

  try {
    const [
      detail,
      cost,
      margin,
      budget,
      exceptions,
      drawData,
      permits,
      schedule,
      pos,
      logs,
      cos,
      closeout,
      labor,
    ] = await Promise.all([
      api(`/projects/${projectId}`),
      api(`/projects/${projectId}/cost-position`),
      api(`/projects/${projectId}/margin`).catch(() => null),
      api(`/projects/${projectId}/budget`),
      api(`/projects/${projectId}/exceptions`),
      api(`/projects/${projectId}/draws`),
      api(`/projects/${projectId}/permits`),
      api(`/projects/${projectId}/schedule`),
      api(`/projects/${projectId}/purchase-orders`),
      api(`/projects/${projectId}/daily-logs`),
      api(`/projects/${projectId}/change-orders`),
      api(`/projects/${projectId}/closeout`),
      api(`/projects/${projectId}/labor`),
    ]);

    if (revision !== selectionRevision) return;
    current = { id: projectId, ...detail };
    localStorage.setItem("jp.activeProject." + session.tenant.id, projectId);
    if (el("project-search")) filterProjects();
    el("boot").hidden = true;
    el("shell").hidden = false;
    render({
      detail,
      cost,
      margin,
      budget,
      exceptions,
      drawData,
      permits,
      schedule,
      pos,
      logs,
      cos,
      closeout,
      labor,
    });
  } catch (err) {
    if (revision !== selectionRevision) return;
    el("boot").className = "state bad";
    el("boot").textContent = err.message;
  }
}

// ------------------------------------------------------------------- render

function render(d) {
  if (current && d.cos)
    current.sold_estimates = d.cos.unmatched_sold_estimates ?? [];
  const p = d.detail;

  el("pcode").textContent = [
    p.project_number,
    // Only when there is actually a system holding that id. A tenant running
    // this module standalone has no job number to show, and "Manual entry job
    // 260171" is a sentence about nothing.
    p.external_system_id && p.external_job_id
      ? `${d.drawData.revenue_system} job ${p.external_job_id}`
      : null,
  ]
    .filter(Boolean)
    .join("  ·  ");
  el("pname").textContent = p.name;
  el("paddr").textContent = [
    p.source_customer_name,
    addressLine(p),
    p.source_project_status,
  ]
    .filter(Boolean)
    .join(" · ");
  el("footnote").textContent =
    "ServiceTitan is the official project record repository. Publish PM document revisions to ST; saved drafts stay in this workspace.";

  renderStats(p, d.margin, d.cost);
  renderNotice(d.budget, d.drawData);
  renderStageBar(p, p.gates);
  renderGates(p);
  renderBudget(d.cost, d.budget);
  renderPurchaseOrders(d.pos);
  renderChangeOrders(d.cos);
  renderCloseout(d.closeout);
  renderLabor(d.labor);
  renderSubs(d.schedule);
  void planning.render(d.schedule);
  renderLogs(d.logs);
  renderBlockers(d.exceptions, d.schedule, d.drawData);
  renderPermits(d.permits);
  renderDraws(d.drawData);
  workspace.render(d);
  renderPrecon(d.detail);
}

function addressLine(p) {
  const parts = [`${p.address_line1}, ${p.city}`];
  const pm = p.pm_name || null;
  if (pm) parts.push(`PM: ${pm}`);
  parts.push(dayLine(p) || String(p.stage).replace(/_/g, " "));
  return parts.join(" · ");
}

function dayLine(p) {
  if (!p.actual_start || !p.scheduled_end) return null;
  const start = new Date(p.actual_start);
  const end = new Date(p.scheduled_end);
  const day = Math.floor((Date.now() - start) / 86400000) + 1;
  const total = Math.round((end - start) / 86400000) + 1;
  if (!Number.isFinite(day) || !Number.isFinite(total) || total <= 0)
    return null;
  return `Day ${day} of ${total}`;
}

function renderStats(p, margin, cost) {
  const billed = cost.reduce((s, r) => s + (r.actual_cost || 0), 0);
  const committed = cost.reduce((s, r) => s + (r.total_committed || 0), 0);
  const contract = margin?.has_budget
    ? margin.revised_contract
    : p.contract_value;
  const target = p.target_margin;
  const projected = margin?.has_budget ? margin.projected_margin : null;
  const delta =
    projected === null || target === null ? null : projected - target;

  const marginCell =
    projected === null
      ? `<span class="v num">—</span><span class="sub">no budget yet</span>`
      : `<span class="v num ${delta < -0.05 ? "neg" : delta < -0.005 ? "warn" : "pos"}">${(
          projected * 100
        ).toFixed(1)}%</span>
         <span class="sub">${delta === null ? "No target set" : (delta * 100).toFixed(1) + " pts vs. target"}</span>`;

  el("pstats").innerHTML = `
    <div class="stat"><span class="lbl">Contract</span><span class="v num">${contract === null ? "Not imported" : money(contract)}</span><span class="sub">incl. approved COs</span></div>
    <div class="stat"><span class="lbl">Committed</span><span class="v num">${money(
      committed,
    )}</span><span class="sub">${money(billed)} billed</span></div>
    <div class="stat"><span class="lbl">Target margin</span><span class="v num">${target === null ? "Not set" : (target * 100).toFixed(0) + "%"}</span><span class="sub">set at Gate 0</span></div>
    <div class="stat"><span class="lbl">Projected margin</span>${marginCell}</div>`;
}

function renderNotice(budget, drawData) {
  const notices = [];
  if (budget.baseline_frozen) {
    notices.push(
      `<div class="banner warn"><b>Budget baseline frozen</b>Gate ${budget.frozen_by_gate} was approved, so budget lines are locked. Changes after the freeze belong on a change order.</div>`,
    );
  }
  if (
    !drawData.verification_available &&
    drawData.draws.some((x) => x.external_invoice_number)
  ) {
    notices.push(
      `<div class="banner warn"><b>Invoice numbers are recorded, not verified</b>${esc(
        drawData.revenue_system,
      )} does not support an invoice lookback, so these numbers are asserted by whoever typed them. Still a control — just an unverified one.</div>`,
    );
  }
  el("notice").innerHTML = notices.join("");
}

function renderGates(project) {
  // Count and content are tenant configuration. The mock's five-entry
  // GATE_LABELS array is gone; this reads what the tenant actually has.
  const gates = project.gates || [];
  const currentIndex = gates.findIndex((g) => g.status !== "approved");
  const stage = currentIndex === -1 ? gates.length : currentIndex;
  const released = Boolean(project.field_release?.released);

  el("gates").innerHTML = gates
    .map((g, i) => {
      const cls = i < stage ? "done" : i === stage ? "now" : "next";
      const meta =
        g.status === "approved"
          ? "Approved"
          : g.status === "rejected"
            ? "Rejected"
            : i === stage
              ? "Open"
              : "Not started";
      const outstanding = (g.checklist || []).filter((c) => !c.done).length;
      const detail =
        outstanding > 0 && i === stage ? ` · ${outstanding} outstanding` : "";
      const releaseMark =
        Number(g.gate_number) === 2
          ? released
            ? " · Field release recorded"
            : " · No field release"
          : "";
      const approver = roleTitle(g.approver_role);
      return `<div class="gate ${cls} actionable" data-gate="${g.gate_number}">
      <div class="stamp">${i < stage ? "✓" : g.gate_number}</div>
      <div class="gate-t"><span class="n">${esc(g.title)}</span>
      <span class="m">Gate ${g.gate_number} · ${meta}${detail}${approver ? ` · ${esc(approver)}` : ""}${releaseMark}</span></div>
    </div>`;
    })
    .join("");

  const gate2 = gates.find((g) => Number(g.gate_number) === 2);
  const releasePanel = fieldReleaseHtml({
    release: project.field_release,
    canRelease: can("record_field_release"),
    esc,
    items: gate2?.checklist || [],
    fieldStart: project.field_start,
  });
  const gate2Node = el("gates").querySelector('.gate[data-gate="2"]');
  if (gate2Node) gate2Node.insertAdjacentHTML("afterend", releasePanel);
  else el("gates").insertAdjacentHTML("beforeend", releasePanel);
  bindFieldRelease(el("gates").querySelector(".field-release"), {
    onRelease: (note) => saveFieldRelease(note, false),
    onUndo: (note) => saveFieldRelease(note, true),
  });

  // Every gate opens, not just the current one: a rejected gate two stages back
  // is exactly the thing someone needs to get at.
  document.querySelectorAll("#gates .gate").forEach((node) =>
    node.addEventListener("click", () => {
      const gate = gates.find(
        (g) => String(g.gate_number) === node.dataset.gate,
      );
      if (gate) gateDrawer(gate);
    }),
  );
}

async function saveFieldRelease(note, undo) {
  await api(
    `/projects/${current.id}/field-release${undo ? "/undo" : ""}`,
    {
      method: "POST",
      body: JSON.stringify({ note: note || null }),
    },
  );
  closeDrawer();
  await select(current.id);
}

function renderBudget(cost, budget) {
  if (cost.length === 0) {
    el("budget").innerHTML = `<div class="state">No budget lines yet.</div>`;
    el("btag").textContent = "No budget";
    el("btag").className = "tag";
    return;
  }

  const freeze = {
    frozen: Boolean(budget?.baseline_frozen),
    gateNumber: budget?.frozen_by_gate,
  };
  const editable = can("edit_budget_before_freeze");
  el("budget-add").hidden = !editable || freeze.frozen;

  const maxScale = Math.max(
    ...cost.map((r) =>
      Math.max(r.baseline || 0, (r.actual_cost || 0) + (r.committed_open || 0)),
    ),
  );

  el("budget").innerHTML = cost
    .map((r) => {
      const b = r.baseline || 0;
      const a = r.actual_cost || 0;
      const k = r.committed_open || 0;
      const tot = a + k;
      const v = b - tot;
      const S = maxScale * 1.04 || 1;
      const within = Math.min(tot, b);
      const over = Math.max(0, tot - b);
      const actW = (Math.min(a, b) / S) * 100;
      const comW = (Math.max(0, within - Math.min(a, b)) / S) * 100;
      const ovrW = (over / S) * 100;
      const cls = v < 0 ? "over" : tot > 0 && v > 0 ? "und" : "";
      const unbudgeted = r.description === "Unbudgeted labor";
      const label = unbudgeted
        ? "Unbudgeted labor"
        : `<span class="c">${esc(r.cost_code)}</span>${esc(r.description)}`;
      const detail = Array.isArray(r.lines)
        ? `<ul class="labor-lines">${r.lines
            .map(
              (line) =>
                `<li><span>${esc(line.description)}</span><span>${laborMoney(line.amount)}</span></li>`,
            )
            .join("")}</ul>`
        : "";
      return `<div class="brow ${editable && !unbudgeted ? "editable" : ""}" data-code="${esc(r.cost_code)}"${unbudgeted ? ' data-unbudgeted="true" id="unbudgeted-labor"' : ""}>
      <div class="btop">
        <div class="bname">${label}
          ${editable && !unbudgeted ? '<span class="edit-hint">edit</span>' : ""}</div>
        <div class="bnum">${money(b)}</div>
        <div class="bnum ${cls}">${tot === 0 ? "—" : signed(v)}</div>
      </div>
      ${detail}
      <div class="track">
        <div class="seg act" style="width:${actW}%"></div>
        <div class="seg com" style="left:${actW}%;width:${comW}%"></div>
        <div class="seg over" style="left:${actW + comW}%;width:${ovrW}%"></div>
        <div class="tick" style="left:${(b / S) * 100}%"></div>
      </div>
    </div>`;
    })
    .join("");

  if (editable) {
    document.querySelectorAll("#budget .brow").forEach((node) =>
      node.addEventListener("click", () => {
        if (node.dataset.unbudgeted) return;
        const line = (budget?.lines ?? []).find(
          (l) => l.code === node.dataset.code,
        );
        if (line) budgetLineDrawer(line, freeze);
      }),
    );
  }

  const over = cost.filter(
    (r) => (r.actual_cost || 0) + (r.committed_open || 0) > r.baseline,
  ).length;
  const bt = el("btag");
  bt.textContent = over
    ? `${over} code${over > 1 ? "s" : ""} over`
    : "All codes within budget";
  bt.className = "tag " + (over ? "warn" : "ok");
}

function renderSubs(schedule) {
  const withVendor = schedule;
  el("sched-new").hidden = !can("advance_stage");
  if (withVendor.length === 0) {
    el("subs").innerHTML = `<div class="state">Nothing scheduled.</div>`;
    el("stag").textContent = "0 assigned";
    return;
  }

  el("subs").innerHTML = withVendor
    .map((s) => {
      const blocked =
        s.vendor_schedulable === false ||
        s.resources?.some((r) => !r.schedulable);
      const pip = blocked
        ? "bad"
        : s.status === "confirmed" || s.status === "complete"
          ? "ok"
          : s.status === "proposed"
            ? "warn"
            : "idle";
      const meta = `${esc(s.title)} · ${window_(s)} ${esc(s.status)}`;
      const right = blocked
        ? Number(s.expired_count) > 0
          ? "compliance expired"
          : "documents missing"
        : s.next_expiry
          ? `COI to ${monthYear(s.next_expiry)}`
          : "—";
      const rc = blocked ? "bad" : s.status === "proposed" ? "warn" : "";
      return `<div class="row" data-sched="${s.id}" style="cursor:pointer"><span class="pip ${pip}"></span><div class="row-b">
      <div class="row-t">${esc([...(s.resources ?? []).map((r) => r.name), s.vendor_name, s.staff_name].filter(Boolean).join(", ") || "Unassigned")}</div><div class="row-m">${meta}</div></div>
      <div class="row-r ${rc}">${esc(right)}</div></div>`;
    })
    .join("");
  document.querySelectorAll("#subs [data-sched]").forEach((node) =>
    node.addEventListener("click", () => {
      const item = withVendor.find((s) => s.id === node.dataset.sched);
      if (item && can("advance_stage")) void planning.activity(item);
    }),
  );
  el("stag").textContent = `${withVendor.length} assigned`;
  el("sched-new").hidden = !can("advance_stage");
}

const window_ = (s) =>
  `${shortDate(s.window_start)}–${shortDate(s.window_end)} ·`;
const shortDate = (d) => (d ? String(d).slice(5).replace("-", "/") : "");
const monthYear = (d) =>
  d ? `${String(d).slice(5, 7)}/${String(d).slice(0, 4)}` : "";

function renderBlockers(exceptions, schedule, drawData) {
  const rows = [];

  for (const s of schedule) {
    if (s.vendor_id && s.vendor_schedulable === false) {
      rows.push({
        s: "bad",
        t: `${s.vendor_name} — compliance not current`,
        m: `${s.title} · scheduling blocked by system`,
        r:
          Number(s.expired_count) > 0
            ? `${s.expired_count} expired`
            : `${s.missing_count} missing`,
        rc: "bad",
      });
    }
  }

  for (const d of exceptions.draws) {
    rows.push({
      s: "bad",
      t: `${d.label} approved, no invoice recorded`,
      m: `Approved · revenue not yet recorded in ${drawData.revenue_system}`,
      r: `${d.days_since_approval} days`,
      rc: "bad",
    });
  }

  for (const b of exceptions.budget) {
    rows.push({
      s: "warn",
      t: `Cost code ${b.cost_code} over budget`,
      m: `${b.description} · no change order on file`,
      r: signed(b.variance),
      rc: "warn",
    });
  }

  for (const p of exceptions.permits) {
    rows.push({
      s: "warn",
      t: p.milestone,
      m: `${p.jurisdiction} · due ${p.due_on}`,
      r: `${p.days_overdue} days`,
      rc: "warn",
    });
  }

  if (exceptions.missing_daily_log) {
    rows.push({
      s: "warn",
      t: "No daily log for yesterday",
      m: "Active project · the record of what happened on site is missing",
      r: "1 day",
      rc: "warn",
    });
  }

  if (rows.length === 0) {
    rows.push({
      s: "ok",
      t: "Nothing blocking",
      m: "All gates current, all compliance valid, all draws cross-referenced",
      r: "",
    });
  }

  el("blockers").innerHTML = rows
    .map(
      (b) => `
    <div class="row"><span class="pip ${b.s}"></span><div class="row-b">
      <div class="row-t">${esc(b.t)}</div><div class="row-m">${esc(b.m)}</div></div>
      <div class="row-r ${b.rc || ""}">${esc(b.r)}</div></div>`,
    )
    .join("");

  const nb = rows.filter((b) => b.s !== "ok").length;
  const b2 = el("btag2");
  b2.textContent = nb ? `${nb} open` : "Clear";
  b2.className = "tag " + (nb ? "bad" : "ok");
}

function renderPrecon(project) {
  const root = el("precon");
  if (!root || !project) return;
  const tasks = project.precon?.tasks || [];
  root.innerHTML = preconHtml({
    precon: project.precon,
    canEdit: can("manage_precon_tasks"),
    esc,
  });
  bindPrecon(root, {
    onApply: () =>
      api(`/projects/${project.id}/precon-tasks/apply-template`, { method: "POST" }).then(
        () => select(project.id),
      ),
    onStatus: (id, status) =>
      api(`/precon-tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }).then(() => select(project.id)),
    onAdd: () => preconTaskDrawer(project, null),
    onEdit: (id) => preconTaskDrawer(project, tasks.find((task) => task.id === id)),
    onInspect: (id) => inspectionDrawer(tasks.find((task) => task.id === id)),
  });
}

async function preconTaskDrawer(project, task) {
  let offices = [];
  try {
    offices = await api("/jurisdictions");
  } catch (err) {
    offices = [];
  }
  const value = task || {};
  const typeOptions = PRECON_TYPES.map(
    ([id, label]) =>
      `<option value="${id}"${value.type === id ? " selected" : ""}>${esc(label)}</option>`,
  ).join("");
  const statusOptions = PRECON_STATUSES.map(
    ([id, label]) =>
      `<option value="${id}"${(value.status || "not_started") === id ? " selected" : ""}>${esc(label)}</option>`,
  ).join("");
  const roles = ["owner", "manager", "project_manager", "estimator", "office", "bookkeeper"];
  openDrawer(
    task ? "Edit preconstruction task" : "Add preconstruction task",
    `<form id="precon-form">
      ${field("Type", `<select id="precon-type">${typeOptions}</select>`)}
      ${field("Title", `<input id="precon-title" maxlength="200" required value="${esc(value.title || "")}">`)}
      ${field("Owner", `<select id="precon-owner">${roles.map((role) => `<option value="${role}"${value.owner_role === role ? " selected" : ""}>${esc(role.replace(/_/g, " "))}</option>`).join("")}</select>`)}
      ${field("Due", `<input id="precon-due" type="date" value="${esc(String(value.due_on || "").slice(0, 10))}">`)}
      ${field("Status", `<select id="precon-status">${statusOptions}</select>`)}
      ${field("Permit office", `<select id="precon-office"><option value="">None</option>${offices.map((office) => `<option value="${office.id}"${value.jurisdiction_id === office.id ? " selected" : ""}>${esc(office.name)}, ${esc(office.state)}</option>`).join("")}</select>`)}
      ${field("Notes", `<textarea id="precon-notes" maxlength="2000" rows="3">${esc(value.notes || "")}</textarea>`)}
      <p class="err" id="precon-error" role="alert"></p>
      <button class="btn primary" type="submit">Save task</button>
    </form>`,
    () => {
      el("precon-form").onsubmit = async (event) => {
        event.preventDefault();
        const error = el("precon-error");
        error.textContent = "";
        const button = event.target.querySelector("button");
        button.disabled = true;
        const body = {
          type: el("precon-type").value,
          title: el("precon-title").value.trim(),
          owner_role: el("precon-owner").value,
          due_on: el("precon-due").value || null,
          status: el("precon-status").value,
          jurisdiction_id: el("precon-office").value || null,
          notes: el("precon-notes").value.trim() || null,
        };
        try {
          await api(task ? `/precon-tasks/${task.id}` : `/projects/${project.id}/precon-tasks`, {
            method: task ? "PATCH" : "POST",
            body: JSON.stringify(body),
          });
          closeDrawer();
          await select(project.id);
        } catch (err) {
          error.textContent = err.message;
          button.disabled = false;
        }
      };
    },
  );
}

function inspectionDrawer(task) {
  if (!task) return;
  openDrawer(
    "Add inspection",
    `<form id="inspection-form">
      <p>${esc(task.title)}</p>
      ${field("Scheduled", `<input id="inspection-scheduled" type="date">`)}
      ${field("Occurred", `<input id="inspection-occurred" type="date">`)}
      ${field("Result", `<select id="inspection-result">${INSPECTION_RESULTS.map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join("")}</select>`)}
      ${field("Notes", `<textarea id="inspection-notes" maxlength="2000" rows="3"></textarea>`)}
      <p class="err" id="inspection-error" role="alert"></p>
      <button class="btn primary" type="submit">Save inspection</button>
    </form>`,
    () => {
      el("inspection-form").onsubmit = async (event) => {
        event.preventDefault();
        const error = el("inspection-error");
        error.textContent = "";
        const button = event.target.querySelector("button");
        button.disabled = true;
        try {
          await api(`/precon-tasks/${task.id}/inspections`, {
            method: "POST",
            body: JSON.stringify({
              scheduled_on: el("inspection-scheduled").value || null,
              occurred_on: el("inspection-occurred").value || null,
              result: el("inspection-result").value,
              notes: el("inspection-notes").value.trim() || null,
            }),
          });
          closeDrawer();
          await select(current.id);
        } catch (err) {
          error.textContent = err.message;
          button.disabled = false;
        }
      };
    },
  );
}

function renderPermits(permits) {
  const links = permits.flatMap((p) =>
    (p.milestones || []).map((m) => ({
      s:
        m.status === "complete"
          ? "done"
          : m.status === "failed"
            ? "now"
            : m.overdue || m.status === "in_progress"
              ? "now"
              : "wait",
      t: m.name,
      d: milestoneDetail(m, p),
    })),
  );

  if (links.length === 0) {
    el("permits").innerHTML =
      `<div class="state">No permit on this project.</div>`;
    el("ptag").textContent = "—";
    return;
  }

  el("permits").innerHTML = links
    .map(
      (x) => `
    <div class="link ${x.s}"><div class="t">${esc(x.t)}</div>${
      x.d ? `<div class="d">${esc(x.d)}</div>` : ""
    }</div>`,
    )
    .join("");
  const done = links.filter((x) => x.s === "done").length;
  el("ptag").textContent = `${done} of ${links.length} complete`;
}

function milestoneDetail(m, permit) {
  if (m.status === "complete") {
    // The permit number belongs on the milestone that produced it, not on
    // every line beneath it — twelve repetitions of the same number is noise
    // the eye has to step over to find the one that matters.
    const number =
      /issued/i.test(m.name) && permit.permit_number
        ? ` · ${permit.permit_number}`
        : "";
    return `Complete ${shortDate(m.completed_at?.slice(0, 10))}${number}`;
  }
  if (m.status === "failed")
    return `Failed · ${m.note || "re-inspection required"}`;
  if (m.overdue) return `Overdue · was due ${m.due_on}`;
  if (m.due_on) return `Due ${m.due_on}`;
  return permit.jurisdiction || "";
}

function serviceTitanNumberControl(dr, drawData, canRecord) {
  const verified = dr.external_invoice_verified_at;
  const recorded = dr.external_invoice_number
    ? `ServiceTitan invoice · ${esc(dr.external_invoice_number)} · ${
        verified ? "verified" : "recorded, not verified"
      }`
    : `No ServiceTitan invoice number on this draw. Recording it does not create an invoice in ${esc(
        drawData.revenue_system,
      )}.`;
  if (!canRecord) {
    return `<div class="stref"><span class="w">${recorded} Ask an owner, a manager, the project coordinator, or office to record it.</span></div>`;
  }
  return `<div class="stref${dr.external_invoice_number ? " filled" : ""}">
        <span class="w">${recorded}</span>
        <input id="st-${dr.id}" placeholder="ServiceTitan invoice #" aria-label="ServiceTitan invoice number" value="${esc(
          dr.external_invoice_number || "",
        )}">
        <button data-st-record="${dr.id}">${
          dr.external_invoice_number ? "Correct" : "Record"
        }</button>${
          dr.external_invoice_number
            ? `<button data-st-clear="${dr.id}">Clear</button>`
            : ""
        }</div>`;
}

function drawMatchLine(dr) {
  const match = dr.match;
  if (!match || match.state === "none") return "";
  if (match.state === "matched") {
    const unpaid = Number(match.balance) > 0;
    return `<div class="m">${unpaid ? "Unpaid" : "Paid"} · matched ${esc(match.invoice_number)} · balance ${money(
      match.balance,
    )}</div>`;
  }
  const suggestion = dr.suggestion;
  if (!suggestion) return "";
  const confirm = can("record_external_invoice")
    ? `<button class="btn sm" data-st-suggest="${dr.id}" data-number="${esc(
        suggestion.invoice_number,
      )}" type="button">Use ${esc(suggestion.invoice_number)}</button>`
    : "";
  return `<div class="m">Suggested ServiceTitan invoice ${esc(
    suggestion.invoice_number,
  )}. Confirming records the number here. It does not write to ServiceTitan.</div>${confirm}`;
}

function renderDraws(drawData) {
  const canRecord = can("record_external_invoice");
  const refresh = el("ar-refresh");
  if (refresh) {
    refresh.hidden = !can("refresh_ar");
    refresh.onclick = async () => {
      refresh.disabled = true;
      try {
        const result = await api(`/projects/${current.id}/servicetitan/ar-refresh`, { method: "POST" });
        if (result && result.refreshed === false) window.alert(result.message);
        await select(current.id);
      } catch (err) {
        refresh.disabled = false;
        window.alert(err.message);
      }
    };
  }

  const unused = drawData.unmatched_invoices || [];
  const unusedNote =
    unused.length > 1
      ? `<p class="note">More than one ServiceTitan invoice is unused, so none was suggested: ${unused
          .map((row) => esc(row.invoice_number))
          .join(", ")}.</p>`
      : "";
  el("draws").innerHTML = unusedNote + drawData.draws
    .map((dr) => {
      let ref = "";
      if (dr.status === "approved" && !dr.external_invoice_number) {
        // The signature interaction. In the mock this wrote to a local object;
        // here it is a real write, and it is only offered to a role that holds
        // record_external_invoice — a button that 403s is worse than no button.
        // While ServiceTitan owns revenue the local recorder is replaced by a
        // control that only stores the ServiceTitan invoice number.
        ref =
          drawData.local_invoices_allowed === false
            ? serviceTitanNumberControl(dr, drawData, canRecord)
            : canRecord
              ? `<div class="stref">
        <span class="w">No invoice recorded in ${esc(drawData.revenue_system)}</span>
        <input id="in-${dr.id}" placeholder="Invoice #" aria-label="Invoice number in the revenue system">
        <button data-record-invoice="${dr.id}" data-id="${dr.id}">Record</button></div>`
              : `<div class="stref">
        <span class="w">No invoice recorded in ${esc(
          drawData.revenue_system,
        )} — ask an owner, a manager, the project coordinator, or office to record it</span></div>`;
      } else if (dr.external_invoice_number) {
        const verified = dr.external_invoice_verified_at;
        ref =
          drawData.local_invoices_allowed === false
            ? serviceTitanNumberControl(dr, drawData, canRecord)
            : `<div class="stref filled"><span class="w">Invoiced · ${esc(
                dr.external_invoice_number,
              )} · ${verified ? "verified" : "recorded, not verified"}</span></div>`;
      } else if (dr.status === "scheduled") {
        ref = "";
      }

      const meta = [dr.trigger_milestone, dr.status]
        .filter(Boolean)
        .join(" · ");
      return `<div class="draw">
      <div class="draw-h"><span class="t">${esc(dr.label)}</span><span class="a num">${money(
        dr.amount,
      )}</span></div>
      <div class="m">${esc(meta)}</div>${drawMatchLine(dr)}${drawActionsFor(dr)}${ref}</div>`;
    })
    .join("");

  document.querySelectorAll("#draws [data-record-invoice]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const input = el("in-" + btn.dataset.id);
      const value = (input.value || "").trim();
      if (!value) {
        input.focus();
        input.style.borderColor = "#B4231F";
        return;
      }
      btn.disabled = true;
      input.disabled = true;
      try {
        await api(`/draws/${btn.dataset.id}/external-invoice`, {
          method: "POST",
          body: JSON.stringify({ external_invoice_number: value }),
        });
        await select(current.id);
      } catch (err) {
        btn.disabled = false;
        input.disabled = false;
        input.style.borderColor = "#B4231F";
        input.title = err.message;
      }
    });
  });

  document.querySelectorAll("#draws [data-st-record]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const input = el("st-" + btn.dataset.stRecord);
      const value = (input.value || "").trim();
      if (!value) {
        input.focus();
        input.style.borderColor = "#B4231F";
        return;
      }
      btn.disabled = true;
      input.disabled = true;
      try {
        await api(`/draws/${btn.dataset.stRecord}/external-invoice`, {
          method: "PATCH",
          body: JSON.stringify({ external_invoice_number: value }),
        });
        await select(current.id);
      } catch (err) {
        btn.disabled = false;
        input.disabled = false;
        input.style.borderColor = "#B4231F";
        input.title = err.message;
      }
    });
  });
  document.querySelectorAll("#draws [data-st-suggest]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api(`/draws/${btn.dataset.stSuggest}/external-invoice`, {
          method: "PATCH",
          body: JSON.stringify({ external_invoice_number: btn.dataset.number }),
        });
        await select(current.id);
      } catch (err) {
        btn.disabled = false;
        window.alert(err.message);
      }
    });
  });
  document.querySelectorAll("#draws [data-st-clear]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api(`/draws/${btn.dataset.stClear}/external-invoice`, {
          method: "PATCH",
          body: JSON.stringify({ external_invoice_number: null }),
        });
        await select(current.id);
      } catch (err) {
        btn.disabled = false;
        window.alert(err.message);
      }
    });
  });

  wireDrawActions();

  const invoiced = drawData.draws.filter(
    (d) => d.external_invoice_number,
  ).length;
  el("dtag").textContent = `${invoiced} of ${drawData.draws.length} invoiced`;
}

// ---------------------------------------------------------------------- go

// ===========================================================================
// ACTIONS
//
// The mock is a read-only reference for one screen, so everything below is
// new. It is written in the mock's idiom rather than a new one, and it obeys
// the same rule the draw control already did: a capability the session does
// not hold means the control is absent, not that the click 403s.
// ===========================================================================

const can = (capability) => (session?.capabilities ?? []).includes(capability);

const STAGE_ORDER = [
  "handoff",
  "precon",
  "mobilization",
  "execution",
  "closeout",
  "complete",
];

// ------------------------------------------------------------------ drawer

function openDrawer(title, bodyHtml, onMount) {
  el("drawer-title").textContent = title;
  el("drawer-body").innerHTML = bodyHtml;
  el("drawer").hidden = false;
  if (onMount) onMount();
  const first = el("drawer-body").querySelector("input,select,textarea,button");
  if (first) first.focus();
}

function closeDrawer() {
  el("drawer").hidden = true;
  el("drawer-body").innerHTML = "";
}

el("drawer-close").addEventListener("click", closeDrawer);
el("drawer").addEventListener("click", (e) => {
  if (e.target === el("drawer")) closeDrawer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("drawer").hidden) closeDrawer();
});

function drawerMessage(text, kind = "bad") {
  const box = el("drawer-msg");
  if (!box) return;
  box.className = text ? `msg ${kind}` : "msg";
  box.textContent = text;
}

/**
 * Runs a write, then reloads the project.
 *
 * Errors are shown with the server's own message. `compliance_blocked` already
 * names which document lapsed and when, and `baseline_frozen` names the gate
 * that froze it — rewriting either here would mean two places to keep true.
 */
async function submit(button, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Working…";
  try {
    await fn();
    closeDrawer();
    await select(current.id);
  } catch (err) {
    button.disabled = false;
    button.textContent = original;
    drawerMessage(err.message || "That did not work.");
  }
}

const field = (label, html) =>
  `<label><span class="lbl">${label}</span>${html}</label>`;
const stamp = (value) => {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return esc(value);
  return esc(
    parsed.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
  );
};
const messageSlot = '<p class="msg" id="drawer-msg"></p>';
const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------- gates

function gateHint(item) {
  if (!item || item.key === "site_ready" || typeof item.ready !== "boolean") return "";
  return item.ready
    ? `<div class="m">Ready in the project record. A person still ticks this.</div>`
    : `<div class="m">Not ready in the project record.</div>`;
}

function gateDrawer(gate) {
  const checklist = gate.checklist || [];
  const open = gate.status !== "approved";
  // Gate approval is not a fixed capability — it comes from this account's
  // template for that gate number. Owner is always allowed.
  const mayApprove =
    session.staff.role === "owner" || session.staff.role === gate.approver_role;
  const outstanding = checklist.filter((c) => !c.done).length;

  openDrawer(
    `Gate ${gate.gate_number} — ${gate.title}`,
    `${messageSlot}
     <p class="note">
       Approved by <b>${esc(
         roleTitle(gate.approver_role) || "Owner",
       )}</b>, which comes from this account's gate template rather than a fixed
       role. Currently <b>${esc(gate.status)}</b>.
       ${gate.freezes_baseline ? " Approving this gate freezes the budget baseline." : ""}
     </p>
     ${
       checklist.length
         ? `<span class="lbl">Checklist</span><div id="gate-checklist">${checklist
             .map(
               (item, i) => `<div class="check ${item.done ? "done" : ""}">
                 <input type="checkbox" id="chk-${i}" data-key="${esc(item.key)}"
                        ${item.done ? "checked" : ""} ${open ? "" : "disabled"}>
                 <div class="t"><label for="chk-${i}">${esc(item.label)}</label>
                 ${item.done_at ? `<div class="m">ticked ${esc(item.done_at.slice(0, 10))}</div>` : ""}
                 ${gateHint(item)}
                 </div></div>`,
             )
             .join("")}</div>`
         : '<p class="note">No checklist on this gate. Checklists are tenant configuration.</p>'
     }
     ${
       Number(gate.gate_number) === 2
         ? fieldReleaseHtml({
             release: current?.field_release,
             canRelease: can("record_field_release"),
             esc,
             showItems: false,
             fieldStart: current?.field_start,
           })
         : ""
     }
     ${field("Note", '<textarea id="gate-note" placeholder="Required to reject or reopen"></textarea>')}
     ${
       mayApprove
         ? ""
         : `<p class="msg">Gate ${gate.gate_number} is approved by ${esc(
             roleTitle(gate.approver_role) || "an owner",
           )}. You can tick the checklist but not sign it off.</p>`
     }
     <div class="actions right">
       ${
         mayApprove
           ? `<button class="btn danger" id="gate-reject" type="button">${
               open ? "Reject" : "Reopen"
             }</button>`
           : ""
       }
       ${
         open && mayApprove
           ? '<button class="btn primary" id="gate-approve" type="button">Approve gate</button>'
           : ""
       }
     </div>`,
    () => {
      document
        .querySelectorAll("#gate-checklist input[type=checkbox]")
        .forEach((box) => {
          box.addEventListener("change", async () => {
            box.disabled = true;
            try {
              await api(
                `/projects/${current.id}/gates/${gate.gate_number}/checklist`,
                {
                  method: "PATCH",
                  body: JSON.stringify({
                    key: box.dataset.key,
                    done: box.checked,
                  }),
                },
              );
              box.closest(".check").classList.toggle("done", box.checked);
              drawerMessage("");
            } catch (err) {
              box.checked = !box.checked;
              drawerMessage(err.message);
            } finally {
              box.disabled = false;
            }
          });
        });

      el("gate-approve")?.addEventListener("click", (e) =>
        submit(e.target, () =>
          api(`/projects/${current.id}/gates/${gate.gate_number}/approve`, {
            method: "POST",
          }),
        ),
      );

      el("gate-reject")?.addEventListener("click", (e) => {
        const note = el("gate-note").value.trim();
        if (!note) {
          drawerMessage(
            "A note is required. A gate that reopens with no record of why it closed is worse than one that stays shut.",
          );
          return;
        }
        submit(e.target, () =>
          api(`/projects/${current.id}/gates/${gate.gate_number}/reject`, {
            method: "POST",
            body: JSON.stringify({ note }),
          }),
        );
      });

      if (open && outstanding > 0) {
        drawerMessage(
          `${outstanding} checklist item${outstanding > 1 ? "s" : ""} outstanding — approval is refused until they are ticked.`,
          "",
        );
      }
      if (Number(gate.gate_number) === 2) {
        bindFieldRelease(el("drawer-body").querySelector(".field-release"), {
          onRelease: (note) => saveFieldRelease(note, false),
          onUndo: (note) => saveFieldRelease(note, true),
          onError: (err) => drawerMessage(err.message),
        });
      }
    },
  );
}

// ------------------------------------------------------------------- stage

function renderStageBar(project, gates) {
  const ordinal = STAGE_ORDER.indexOf(project.stage);
  const blocking = gates.filter(
    (g) => g.gate_number <= ordinal && g.status !== "approved",
  );
  const next = STAGE_ORDER[ordinal + 1];
  const allowed = can("advance_stage") && next && blocking.length === 0;

  const why =
    project.stage === "cancelled"
      ? "cancelled — terminal"
      : !next
        ? "complete — no further stage"
        : blocking.length
          ? `blocked: gate ${blocking[0].gate_number} (${blocking[0].title}) is ${blocking[0].status}`
          : `ready to advance to ${next}`;

  el("stagebar").innerHTML = `
    <span class="lbl">Stage</span>
    <span class="now">${esc(String(project.stage).replace(/_/g, " "))}</span>
    <span class="why ${blocking.length ? "blocked" : ""}">${esc(why)}</span>
    ${
      next && project.stage !== "cancelled"
        ? `<button class="btn primary" id="stage-advance" ${
            allowed ? "" : "disabled"
          }>Advance to ${esc(next)}</button>`
        : ""
    }`;

  el("stage-advance")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      await api(`/projects/${current.id}/stage`, {
        method: "POST",
        body: JSON.stringify({ stage: next }),
      });
      await select(current.id);
    } catch (err) {
      e.target.disabled = false;
      alert(err.message);
    }
  });
}

// ------------------------------------------------------------------ budget

function budgetLineDrawer(line, freeze) {
  if (freeze.frozen) {
    openDrawer(
      `${line.code} — ${line.description}`,
      `<p class="msg bad">The baseline was frozen when gate ${freeze.gateNumber} was approved.
       Changes after the freeze belong on a change order, not on the budget.</p>`,
    );
    return;
  }
  openDrawer(
    `${line.code} — ${line.description}`,
    `${messageSlot}
     ${field(
       "Budget amount",
       `<input id="line-amount" type="number" step="0.01" min="0" value="${line.budget_amount ?? 0}">`,
     )}
     ${field("Note", `<input id="line-note" value="${esc(line.note ?? "")}">`)}
     <div class="actions right">
       <button class="btn primary" id="line-save" type="button">Save</button>
     </div>`,
    () => {
      el("line-save").addEventListener("click", (e) =>
        submit(e.target, () =>
          api(`/projects/${current.id}/budget/${line.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              budget_amount: Number(el("line-amount").value),
              note: el("line-note").value || null,
            }),
          }),
        ),
      );
    },
  );
}

const codeOptions = (codes) =>
  codes
    .map(
      (c) =>
        `<option value="${c.id}">${esc(c.code)} — ${esc(c.description)}</option>`,
    )
    .join("");

async function addBudgetLineDrawer() {
  const codes = await api("/cost-codes");
  openDrawer(
    "Add a budget line",
    `${messageSlot}
     ${field("Cost code", `<select id="bl-code">${codeOptions(codes)}</select>`)}
     <div class="two">
       ${field(
         "Cost type",
         `<select id="bl-type">
            <option value="L">L — labour</option><option value="M">M — material</option>
            <option value="S" selected>S — subcontract</option><option value="O">O — other</option>
          </select>`,
       )}
       ${field("Amount", '<input id="bl-amount" type="number" step="0.01" min="0" value="0">')}
     </div>
     ${field("Note", '<input id="bl-note">')}
     <div class="actions right">
       <button class="btn primary" id="bl-save" type="button">Add line</button>
     </div>`,
    () => {
      el("bl-save").addEventListener("click", (e) =>
        submit(e.target, () =>
          api(`/projects/${current.id}/budget`, {
            method: "POST",
            body: JSON.stringify({
              cost_code_id: el("bl-code").value,
              cost_type: el("bl-type").value,
              budget_amount: Number(el("bl-amount").value),
              note: el("bl-note").value || null,
            }),
          }),
        ),
      );
    },
  );
}

// --------------------------------------------------------- purchase orders

function renderPurchaseOrders(pos) {
  el("potag").textContent = pos.length ? `${pos.length} raised` : "none";
  el("po-new").hidden = !can("issue_purchase_order");

  if (pos.length === 0) {
    el("pos").innerHTML = '<div class="state">No purchase orders yet.</div>';
    return;
  }

  el("pos").innerHTML = pos
    .map(
      (po) => `<div class="row po"><span class="pip ${
        po.status === "void" ? "idle" : po.open_amount > 0 ? "warn" : "ok"
      }"></span>
      <div class="row-b">
        <div class="row-t">${esc(po.po_number)} · ${esc(po.vendor ?? "counter purchase")}</div>
        <div class="row-m">${esc(po.kind || "subcontract")} · ${esc(po.cost_code)} ${esc(po.cost_code_description)} · ${esc(po.status)}</div>
        ${
          po.status !== "void"
            ? `<div class="po-actions">
                 ${
                   can("issue_purchase_order")
                     ? `<button class="btn sm" data-bill="${po.id}">Record bill</button><button class="btn sm" data-lines="${po.id}">Lines</button>`
                     : `<button class="btn sm" data-lines="${po.id}">Lines</button>`
                 }
                 <button class="btn sm" data-bills="${po.id}">Bills</button>
               </div>`
            : ""
        }
      </div>
      <div class="row-r">${money(po.amount)}<br><span style="color:var(--muted)">${money(
        po.billed,
      )} billed</span></div></div>`,
    )
    .join("");

  document
    .querySelectorAll("#pos [data-bill]")
    .forEach((b) =>
      b.addEventListener("click", () => recordBillDrawer(b.dataset.bill)),
    );
  document
    .querySelectorAll("#pos [data-bills]")
    .forEach((b) =>
      b.addEventListener("click", () => billsDrawer(b.dataset.bills)),
    );
  document
    .querySelectorAll("#pos [data-lines]")
    .forEach((b) =>
      b.addEventListener("click", () => linesDrawer(b.dataset.lines)),
    );
}

async function issuePoDrawer() {
  const [codes, vendors] = await Promise.all([
    api("/cost-codes"),
    api("/vendors?per_page=200"),
  ]);
  let graceDays = 14;
  if (can("manage_company_settings")) {
    try {
      const accountSettings = await api("/accounting/cost-type-accounts");
      graceDays = Number(accountSettings?.agreement_grace_days ?? 14);
    } catch {
      graceDays = 14;
    }
  }
  openDrawer(
    "Issue a purchase order",
    `${messageSlot}
     <p class="note">A vendor must be compliant to be issued a purchase order.
     Committing money to someone who cannot legally be put on site is the
     expensive half of that mistake, and it happens days before anyone tries to
     schedule them. A signed vendor master agreement satisfies the agreement
     gate. A per-PO subcontract is optional. With neither, a subcontract can
     still be issued for ${graceDays} days after it is created, and the screen
     shows a warning. After that, issue is blocked and the message says why.
     Certificates of insurance and the W-9 check are unchanged.</p>
     ${field("PO number", '<input id="po-number" placeholder="PO-0001">')}
     ${field(
       "Vendor",
       `<select id="po-vendor"><option value="">— counter purchase, no vendor —</option>${vendors
         .map(
           (v) =>
             `<option value="${v.id}"${v.schedulable ? "" : " disabled"}>${esc(v.legal_name)}${
               v.schedulable ? "" : " — compliance not current"
             }</option>`,
         )
         .join("")}</select>`,
     )}
     ${field("Supplier name, if no vendor", '<input id="po-supplier" placeholder="Ferguson">')}
     ${field("Cost code", `<select id="po-code">${codeOptions(codes)}</select>`)}
     <div class="two">
       ${field(
         "Cost type",
         `<select id="po-type"><option value="L">L</option><option value="M">M</option>
          <option value="S">S</option><option value="O">O</option></select>`,
       )}
       ${field("Amount", '<input id="po-amount" type="number" step="0.01" min="0" value="0">')}
     </div>
     ${field("Scope of work", '<textarea id="po-scope"></textarea>')}
     ${field("Exclusions", '<textarea id="po-excl"></textarea>')}
     ${field("Agreement signed", '<input id="po-signed" type="date">')}
     ${field("Signed agreement", `<select id="po-agreement"><option value="">— none; a warning applies for ${graceDays} days —</option></select>`)}
     ${field("ServiceTitan job", '<select id="po-st-job"><option value="">— none —</option></select>')}
     <p class="note" id="po-st-project"></p>
     <label style="display:flex;gap:8px;align-items:center;margin-bottom:16px">
       <input type="checkbox" id="po-issue" checked style="width:15px;height:15px">
       <span class="lbl" style="margin:0">Issue now rather than saving a draft</span>
     </label>
     <div class="actions right">
       <button class="btn primary" id="po-save" type="button">Create</button>
     </div>`,
    () => {
      // The cost position matches a commitment to a budget line on code AND
      // type, so a mismatch makes the money invisible. Following the code's
      // own default type is what someone means nearly every time.
      const followCode = () => {
        const chosen = codes.find((c) => c.id === el("po-code").value);
        if (chosen) el("po-type").value = chosen.default_cost_type;
      };
      el("po-code").addEventListener("change", followCode);
      followCode();
      const loadAgreement = async () => {
        const id = el("po-vendor").value;
        el("po-agreement").innerHTML = `<option value="">— none; a warning applies for ${graceDays} days —</option>`;
        if (!id) return;
        const vendor = await api(`/vendors/${id}`);
        for (const doc of vendor.documents || []) {
          if (doc.kind !== "master_agreement" && doc.kind !== "other") continue;
          el("po-agreement").insertAdjacentHTML(
            "beforeend",
            `<option value="${doc.id}">${esc(doc.kind.replaceAll("_", " "))}</option>`,
          );
        }
      };
      el("po-vendor").addEventListener("change", () => loadAgreement().catch((e) => window.alert(e.message)));
      api(`/projects/${current.id}/jobs`).then((jobs) => {
        for (const job of jobs || []) {
          el("po-st-job").insertAdjacentHTML(
            "beforeend",
            `<option value="${esc(job.external_job_id)}">${esc(job.title)} · ${esc(job.external_job_id)}</option>`,
          );
        }
      }).catch(() => {});
      api(`/projects/${current.id}/servicetitan`).then((link) => {
        if (link?.external_project_id) {
          el("po-st-project").textContent = `Connected ServiceTitan project ${link.external_project_id}. Leave the job blank unless this order belongs to one job on that project.`;
          el("po-st-project").dataset.projectId = link.external_project_id;
        }
      }).catch(() => {});

      el("po-save").addEventListener("click", (e) =>
        submit(e.target, () =>
          api(`/projects/${current.id}/purchase-orders`, {
            method: "POST",
            body: JSON.stringify({
              po_number: el("po-number").value.trim(),
              vendor_id: el("po-vendor").value || null,
              supplier_name: el("po-supplier").value.trim() || null,
              cost_code_id: el("po-code").value,
              cost_type: el("po-type").value,
              amount: Number(el("po-amount").value),
              scope_text: el("po-scope").value.trim(),
              exclusions: el("po-excl").value.trim() || null,
              agreement_document_id: el("po-agreement").value || null,
              agreement_signed_at: el("po-signed").value ? new Date(el("po-signed").value + "T12:00:00Z").toISOString() : null,
              st_job_id: el("po-st-job").value ? Number(el("po-st-job").value) : null,
              st_project_id: el("po-st-project").dataset.projectId ? Number(el("po-st-project").dataset.projectId) : null,
              issue: el("po-issue").checked,
            }),
          }).then((created) => {
            if (created.warning) window.alert(created.warning.message);
            if (created.agreement_warning) window.alert(created.agreement_warning.message);
          }),
        ),
      );
    },
  );
}

async function linesDrawer(poId) {
  const lines = await api(`/purchase-orders/${poId}/lines`);
  openDrawer(
    "Purchase order lines",
    `${messageSlot}
     ${
       lines.length
         ? `<div class="sub-table"><table><thead><tr><th>Cost</th><th>Original</th><th>Changes</th><th>Current</th><th>Billed</th></tr></thead><tbody>${lines
             .map(
               (line) => `<tr><td>${esc(line.cost_code)} ${esc(line.cost_type)}<small>${esc(line.description || "")}</small></td><td>${money(line.original_amount)}</td><td>${money(line.change_amount)}</td><td>${money(line.current_amount)}</td><td>${money(line.billed_gross)}</td></tr>`,
             )
             .join("")}</tbody></table></div>`
         : '<p class="note">No lines yet.</p>'
     }
     ${
       can("issue_purchase_order")
         ? `<p class="note">Lines can be added while the order is a draft. After it is issued, amounts change through an approved change order.</p>`
         : ""
     }`,
  );
}

async function recordBillDrawer(poId) {
  const lines = await api(`/purchase-orders/${poId}/lines`);
  const many = lines.length > 1;
  openDrawer(
    "Record a vendor bill",
    `${messageSlot}
     <p class="note">A subcontract bill past the remaining line amount is refused.
     A material overrun is recorded with a warning. Approved bills are sent to
     QuickBooks for the full amount.</p>
     ${field("Vendor invoice number", '<input id="bill-number">')}
     ${
       many
         ? lines
             .map(
               (line) =>
                 field(
                   `${line.cost_code} ${line.cost_type} · ${money(line.current_amount)} current, ${money(line.billed_gross)} billed`,
                   `<input class="bill-line" data-line="${line.id}" type="number" step="0.01" value="0">`,
                 ),
             )
             .join("")
         : field("Amount this period", '<input id="bill-amount" type="number" step="0.01" min="0" value="0">')
     }
     <div class="actions right">
       <button class="btn primary" id="bill-save" type="button">Record</button>
     </div>`,
    () => {
      el("bill-save").addEventListener("click", (e) =>
        submit(e.target, async () => {
          const body = { vendor_invoice_number: el("bill-number").value.trim() };
          if (many) {
            body.lines = [...document.querySelectorAll(".bill-line")]
              .map((input) => ({
                po_line_id: input.dataset.line,
                gross_amount: Number(input.value),
              }))
              .filter((line) => line.gross_amount !== 0);
          } else {
            body.amount = Number(el("bill-amount").value);
          }
          const result = await api(`/purchase-orders/${poId}/bills`, {
            method: "POST",
            body: JSON.stringify(body),
          });
          if (result.warning) window.alert(result.warning.message);
        }),
      );
    },
  );
}

async function billsDrawer(poId) {
  const bills = await api(`/purchase-orders/${poId}/bills`);
  openDrawer(
    "Bills against this purchase order",
    `${messageSlot}
     ${
       bills.length === 0
         ? '<p class="note">Nothing billed against it yet.</p>'
         : bills
             .map(
               (b) => `<div class="row"><span class="pip ${
                 b.status === "approved" || b.status === "paid"
                   ? "ok"
                   : b.status === "rejected"
                     ? "bad"
                     : "warn"
               }"></span>
        <div class="row-b"><div class="row-t">${esc(b.vendor_invoice_number)}</div>
          <div class="row-m">${b.po_kind === "material" && b.status === "received" && !b.qbo_id ? "Awaiting card charge" : esc(b.status)} · received ${esc(String(b.received_at).slice(0, 10))}</div>
          ${
            b.status === "received" && b.po_kind !== "material" && can("approve_vendor_bill")
              ? `<div class="po-actions">
                   <button class="btn sm" data-approve="${b.id}">Approve for payment</button>
                   <button class="btn sm danger" data-reject="${b.id}">Reject</button>
                 </div>`
              : ""
          }
        </div><div class="row-r">${money(b.amount)}</div></div>`,
             )
             .join("")
     }`,
    () => {
      document
        .querySelectorAll("[data-approve]")
        .forEach((b) =>
          b.addEventListener("click", (e) =>
            (closeDrawer(), window.location.hash="financials", document.getElementById("project-payables")?.scrollIntoView({behavior:"smooth"})),
          ),
        );
      document
        .querySelectorAll("[data-reject]")
        .forEach((b) =>
          b.addEventListener("click", (e) =>
            submit(e.target, () =>
              api(`/bills/${b.dataset.reject}/reject`, { method: "POST" }),
            ),
          ),
        );
    },
  );
}

// ---------------------------------------------------------------- schedule

async function scheduleDrawer() {
  const [codes, vendors] = await Promise.all([
    api("/cost-codes"),
    api("/vendors?per_page=200"),
  ]);
  openDrawer(
    "Schedule work",
    `${messageSlot}
     <p class="note">Confirming a window for a vendor whose compliance is not
     current is refused by a database trigger, not by this form. Proposing one is
     allowed — a PM may pencil someone in while a renewal is in flight, and
     confirmation is what actually puts them on site.</p>
     ${field("What", '<input id="sc-title" placeholder="Set tile">')}
     ${field(
       "Vendor",
       `<select id="sc-vendor"><option value="">— none —</option>${vendors
         .map((v) => `<option value="${v.id}">${esc(v.legal_name)}</option>`)
         .join("")}</select>`,
     )}
     ${field(
       "Cost code",
       `<select id="sc-code"><option value="">— none —</option>${codeOptions(codes)}</select>`,
     )}
     <div class="two">
       ${field("From", `<input id="sc-start" type="date" value="${today()}">`)}
       ${field("To", `<input id="sc-end" type="date" value="${today()}">`)}
     </div>
     ${field(
       "Status",
       `<select id="sc-status"><option value="proposed" selected>proposed</option>
        <option value="confirmed">confirmed</option></select>`,
     )}
     <div class="actions right">
       <button class="btn primary" id="sc-save" type="button">Add to schedule</button>
     </div>`,
    () => {
      el("sc-save").addEventListener("click", (e) =>
        submit(e.target, () =>
          api(`/projects/${current.id}/schedule`, {
            method: "POST",
            body: JSON.stringify({
              title: el("sc-title").value.trim(),
              vendor_id: el("sc-vendor").value || null,
              cost_code_id: el("sc-code").value || null,
              window_start: el("sc-start").value,
              window_end: el("sc-end").value,
              status: el("sc-status").value,
            }),
          }),
        ),
      );
    },
  );
}

function confirmScheduleItem(item) {
  openDrawer(
    item.title,
    `${messageSlot}
     <p class="note">${esc(item.vendor_name ?? "No vendor")} ·
     ${esc(item.window_start)} to ${esc(item.window_end)} · currently
     <b>${esc(item.status)}</b>.${
       item.vendor_schedulable === false
         ? " This vendor is not currently compliant, so confirming will be refused."
         : ""
     }</p>
     <div class="actions right">
       <button class="btn danger" id="sc-cancel" type="button">Cancel</button>
       <button class="btn primary" id="sc-confirm" type="button">Confirm window</button>
     </div>`,
    () => {
      el("sc-confirm").addEventListener("click", (e) =>
        submit(e.target, () =>
          api(`/schedule/${item.id}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "confirmed" }),
          }),
        ),
      );
      el("sc-cancel").addEventListener("click", (e) =>
        submit(e.target, () =>
          api(`/schedule/${item.id}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "cancelled" }),
          }),
        ),
      );
    },
  );
}

// --------------------------------------------------------------- daily log

function renderLogs(logs) {
  el("logtag").textContent = logs.length ? `${logs.length} logged` : "none";
  el("log-new").hidden = !can("write_daily_log");
  el("logs").innerHTML = logs.length
    ? logs
        .map(
          (
            l,
          ) => `<div class="row"><span class="pip ok"></span><div class="row-b">
            <div class="row-t">${esc(l.log_date)}</div>
            <div class="row-m">${esc(l.work_completed ?? "—")}</div></div>
            <div class="row-r">${esc(l.author)}</div></div>`,
        )
        .join("")
    : '<div class="state">No daily logs. On an active project a missing one shows up under Blocking now.</div>';
}

function dailyLogDrawer() {
  openDrawer(
    "Daily log",
    `${messageSlot}
     <p class="note">One per project per date.</p>
     ${field("Date", `<input id="dl-date" type="date" value="${today()}">`)}
     ${field("Work completed", '<textarea id="dl-work"></textarea>')}
     ${field("Delays", '<textarea id="dl-delays"></textarea>')}
     <div class="two">
       ${field("Crew on site", '<input id="dl-crew">')}
       ${field("Weather", '<input id="dl-weather">')}
     </div>
     ${field("Deliveries", '<input id="dl-deliveries">')}
     ${field("Inspections", '<input id="dl-inspections">')}
     ${field("Safety note", '<input id="dl-safety">')}
     <div class="actions right">
       <button class="btn primary" id="dl-save" type="button">Save log</button>
     </div>`,
    () => {
      el("dl-save").addEventListener("click", (e) =>
        submit(e.target, () =>
          api(`/projects/${current.id}/daily-logs`, {
            method: "POST",
            body: JSON.stringify({
              log_date: el("dl-date").value,
              work_completed: el("dl-work").value.trim() || null,
              delays: el("dl-delays").value.trim() || null,
              crew_on_site: el("dl-crew").value.trim() || null,
              weather: el("dl-weather").value.trim() || null,
              deliveries: el("dl-deliveries").value.trim() || null,
              inspections: el("dl-inspections").value.trim() || null,
              safety_note: el("dl-safety").value.trim() || null,
            }),
          }),
        ),
      );
    },
  );
}

// ------------------------------------------------------------------- draws

function drawActionsFor(draw) {
  const buttons = [];
  if (draw.status === "scheduled") {
    buttons.push(
      `<button class="btn sm" data-earn="${draw.id}">Mark milestone reached</button>`,
    );
  }
  if (draw.status === "earned" && can("approve_draw")) {
    buttons.push(
      `<button class="btn sm primary" data-approve-draw="${draw.id}">Approve</button>`,
    );
  }
  return buttons.length
    ? `<div class="po-actions">${buttons.join("")}</div>`
    : "";
}

function wireDrawActions() {
  document.querySelectorAll("#draws [data-earn]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api(`/draws/${b.dataset.earn}/earn`, { method: "POST" });
        await select(current.id);
      } catch (err) {
        b.disabled = false;
        window.alert(err.message);
      }
    }),
  );
  document.querySelectorAll("#draws [data-approve-draw]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api(`/draws/${b.dataset.approveDraw}/approve`, {
          method: "POST",
        });
        await select(current.id);
      } catch (err) {
        b.disabled = false;
        window.alert(err.message);
      }
    }),
  );
}

// ----------------------------------------------------------- project create

async function newProjectDrawer() {
  await stProjectConnector.openImport();
}

// ------------------------------------------------------------------ wiring

el("project-new").textContent = "Add from ServiceTitan";
el("project-new").addEventListener("click", newProjectDrawer);
el("budget-add").addEventListener("click", addBudgetLineDrawer);
el("po-new").addEventListener("click", issuePoDrawer);
el("sched-new").addEventListener("click", () => planning.activity());
el("log-new").addEventListener("click", dailyLogDrawer);

// ----------------------------------------------------------- change orders

let coLines = [];

function soldEstimateNote(data) {
  const rows = data.unmatched_sold_estimates || [];
  if (!rows.length) return "";
  const amount = Number(data.pending_estimate_revisions || 0);
  return `<p class="note">Sold in ServiceTitan, not in the budget yet: ${rows
    .map((row) => `${esc(row.name || row.id)} · ${money(row.customer_amount)}`)
    .join(", ")}. ${money(
    amount,
  )} is not in the revised contract until someone approves a local change order.</p>`;
}

function renderChangeOrders(data) {
  const cos = data.change_orders;
  el("cotag").textContent = cos.length
    ? `${cos.filter((c) => c.status === "approved").length} of ${cos.length} approved`
    : "none";
  el("co-new").hidden = !can("send_change_order");
  const pending = soldEstimateNote(data);

  if (cos.length === 0) {
    el("cos").innerHTML =
      '<div class="state">No change orders. This is the only sanctioned way to move a frozen budget.</div>' +
      pending;
    return;
  }

  el("cos").innerHTML = cos
    .map((co) => {
      const pip =
        co.status === "approved"
          ? "ok"
          : co.status === "rejected" || co.status === "void"
            ? "bad"
            : co.status === "sent"
              ? "warn"
              : "idle";
      const margin =
        co.customer_amount === 0
          ? "—"
          : `${Math.round(((co.customer_amount - co.cost_amount) / co.customer_amount) * 100)}%`;
      return `<div class="row" data-co="${co.id}" style="cursor:pointer">
        <span class="pip ${pip}"></span>
        <div class="row-b">
          <div class="row-t">CO ${co.co_number} · ${esc(co.description)}</div>
          <div class="row-m">${esc(co.status)}${
            co.schedule_impact_days
              ? ` · ${co.schedule_impact_days} day impact`
              : ""
          } · cost ${money(co.cost_amount)} · margin ${margin}</div>
        </div>
        <div class="row-r">${signed(co.customer_amount)}</div></div>`;
    })
    .join("") + pending;

  document.querySelectorAll("#cos [data-co]").forEach((node) =>
    node.addEventListener("click", () => {
      const co = cos.find((c) => c.id === node.dataset.co);
      if (co) changeOrderDrawer(co, data.approval_threshold, data.local_invoices_allowed);
    }),
  );
}

function changeOrderLog(co) {
  const open = co.status !== "void" && co.status !== "rejected";
  const mayEnter = open && can("record_change_order_entered");
  const maySign = open && can("record_change_order_signed");
  return `<span class="lbl">Log</span>
    <p class="note">Found, priced, entered in ServiceTitan, and signed record what already happened. Send and Approve, further down, are a different pair. Send marks that it went to the customer. Approve is the step that posts the budget.</p>
    <div class="row"><div class="row-b"><div class="row-t">Found</div><div class="row-m">${stamp(co.found_at)}</div></div></div>
    <div class="row"><div class="row-b"><div class="row-t">Priced</div><div class="row-m">${
      co.priced_at
        ? stamp(co.priced_at)
        : "Not priced yet. Owner or manager records the customer amount and the cost lines."
    }</div></div></div>
    <div class="row"><div class="row-b"><div class="row-t">Entered in ServiceTitan</div><div class="row-m">${
      co.entered_st_at
        ? `${stamp(co.entered_st_at)} · estimate ${esc(co.st_estimate_number)}`
        : "Not entered in ServiceTitan yet. Recording the number here does not write to ServiceTitan."
    }</div></div></div>
    ${
      mayEnter
        ? `${field(
            "ServiceTitan estimate number",
            `<input id="co-st-number" maxlength="80" value="${esc(co.st_estimate_number || "")}">`,
          )}
          <div class="actions"><button class="btn sm" id="co-entered" type="button">Record entered in ServiceTitan</button></div>`
        : ""
    }
    <div class="row"><div class="row-b"><div class="row-t">Signed</div><div class="row-m">The tech collected the signature. This screen records it. It does not send anything and it does not post the budget.${
      co.signed_at
        ? `<br>${stamp(co.signed_at)}${co.signature_note ? ` · ${esc(co.signature_note)}` : ""}`
        : ""
    }</div></div></div>
    ${
      maySign
        ? `${field(
            "Signature note",
            `<textarea id="co-sign-note" maxlength="2000">${esc(co.signature_note || "")}</textarea>`,
          )}
          <div class="actions"><button class="btn sm" id="co-signed" type="button">Record the signature</button></div>`
        : ""
    }`;
}

function changeOrderDrawer(co, threshold, localInvoicesAllowed) {
  const overThreshold = co.customer_amount > threshold;
  const mayApproveThis = overThreshold
    ? can("approve_change_order_over_threshold")
    : can("send_change_order");

  openDrawer(
    `CO ${co.co_number} — ${co.description}`,
    `${messageSlot}
     <p class="note">
       <b>${signed(co.customer_amount)}</b> to the customer, <b>${money(co.cost_amount)}</b> of
       cost${co.schedule_impact_days ? `, ${co.schedule_impact_days} days of schedule` : ""}.
       Currently <b>${esc(co.status)}</b>.
       ${
         localInvoicesAllowed === false
           ? " Customer invoices are created in ServiceTitan, so this change order is not invoiced from Journeyman."
           : ""
       }
       ${
         overThreshold
           ? ` Above this account's ${money(threshold)} threshold, so owner or manager only.`
           : ""
       }
     </p>
     ${changeOrderLog(co)}
     <span class="lbl">Send and approve</span>
     ${
       co.lines.length
         ? `<span class="lbl">Cost lines</span>${co.lines
             .map(
               (l) => `<div class="row"><div class="row-b">
                 <div class="row-t">${esc(l.code)} ${esc(l.cost_code_description)}</div>
                 <div class="row-m">${esc(l.cost_type)}${
                   l.description ? ` · ${esc(l.description)}` : ""
                 }</div></div>
                 <div class="row-r">${signed(l.amount)}</div></div>`,
             )
             .join("")}`
         : `<p class="msg bad">No cost lines. The customer amount will lift the revised
            contract, but none of the cost reaches the budget — it will read as margin
            that is not there.</p>`
     }
     <div class="actions right">
       ${
         co.status === "draft" && can("send_change_order")
           ? '<button class="btn primary" id="co-send" type="button">Send to customer</button>'
           : ""
       }
       ${
         co.status === "sent" && mayApproveThis
           ? '<button class="btn primary" id="co-approve" type="button">Record customer approval</button>'
           : ""
       }
       ${
         co.status !== "approved" && can("send_change_order")
           ? '<button class="btn danger" id="co-reject" type="button">Reject</button>'
           : ""
       }
     </div>
     ${
       co.status === "sent" && mayApproveThis
         ? field(
             "Date the customer agreed",
             `<input id="co-date" type="date" value="${today()}">`,
           )
         : ""
     }
     ${
       co.status === "sent" && !mayApproveThis
         ? `<p class="msg">${money(
             co.customer_amount,
           )} is above this account's approval threshold, so an owner or manager records it.</p>`
         : ""
     }`,
    () => {
      el("co-send")?.addEventListener("click", (e) =>
        submit(e.target, () =>
          api(`/change-orders/${co.id}/send`, { method: "POST" }),
        ),
      );
      el("co-approve")?.addEventListener("click", (e) =>
        submit(e.target, async () => {
          const result = await api(`/change-orders/${co.id}/approve`, {
            method: "POST",
            body: JSON.stringify({
              customer_approved_at: el("co-date").value || null,
            }),
          });
          if (result.warning) window.alert(result.warning.message);
        }),
      );
      el("co-reject")?.addEventListener("click", (e) =>
        submit(e.target, () =>
          api(`/change-orders/${co.id}/reject`, { method: "POST" }),
        ),
      );
      el("co-entered")?.addEventListener("click", (e) =>
        submit(e.target, () =>
          api(`/change-orders/${co.id}/entered`, {
            method: "POST",
            body: JSON.stringify({
              st_estimate_number: el("co-st-number").value.trim(),
            }),
          }),
        ),
      );
      el("co-signed")?.addEventListener("click", (e) =>
        submit(e.target, () =>
          api(`/change-orders/${co.id}/signed`, {
            method: "POST",
            body: JSON.stringify({ note: el("co-sign-note").value.trim() }),
          }),
        ),
      );
    },
  );
}

function laborMoney(n) {
  return (
    "$" +
    Number(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
function laborRefreshLine(data) {
  if (!data || !data.observed_at) return "Not refreshed yet.";
  const when = stamp(data.observed_at);
  if (data.source === "scheduled") return `Last refreshed ${when} (scheduled)`;
  if (data.source === "auto-hourly") return `Last refreshed ${when} (automatic)`;
  if (data.source === "manual") return `Last refreshed ${when} (manual)`;
  return `Last refreshed ${when}`;
}
function renderLabor(row) {
  const data = row || {
    hours: 0,
    uncoded_hours: 0,
    source: null,
    hours_source: null,
    lines: [],
    technicians: [],
    missing: [],
    cost_code: null,
    st_labor_code: null,
    st_labor_code_error: null,
  };
  const refresh = el("labor-refresh");
  if (refresh) refresh.hidden = !can("refresh_labor");
  if (el("labortag")) {
    el("labortag").textContent = data.hours_source
      ? String(data.hours_source).replaceAll("_", " ")
      : "none";
  }
  if (!el("labor")) return;
  const moneyLine =
    data.labor_wage === undefined
      ? ""
      : `<div class="row-m">Wage ${laborMoney(data.labor_wage)} · Burden ${laborMoney(
          data.labor_burden,
        )} · Total ${laborMoney(data.total)}</div>`;
  const techs = (data.technicians || [])
    .map((tech) => {
      const wage =
        tech.wage == null
          ? ""
          : `<div class="row-m">Labor ${laborMoney(tech.wage)} · ${esc(tech.hours)} h · ${
              tech.pay_basis === "hourly"
                ? "ServiceTitan hourly rate"
                : `${laborMoney(data.billable_rate || 188)} billable × commission`
            }</div>`;
      const burden = tech.burden_unset
        ? `<p class="note">burden not set</p>`
        : tech.burden == null
          ? ""
          : `<div class="row-m">Labor burden ${laborMoney(tech.burden)} · ${esc(tech.hours)} h × ServiceTitan burden rate</div>`;
      return `<div class="row"><div class="row-b"><div class="row-t">${esc(
        tech.technician_name || "Technician",
      )}</div><div class="row-m">${esc(tech.hours)} hours</div>${wage}${burden}</div></div>`;
    })
    .join("");
  const stCode = data.st_labor_code;
  const codeText = stCode
    ? `Labor code (from ServiceTitan Payroll > Labor Types): ${esc(stCode.code)} ${esc(stCode.name || "")}`
    : "Labor code (from ServiceTitan Payroll > Labor Types): unavailable";
  const uncoded = Number(data.uncoded_hours) > 0;
  const laborError = data.st_labor_code_error
    ? `<p class="msg" id="labor-st-error">${esc(data.st_labor_code_error)}</p>`
    : "";
  const uncodedNote =
    uncoded && !data.st_labor_code_error
      ? `<p class="msg">${Number(data.uncoded_hours).toLocaleString("en-US")} hours are not on the ServiceTitan labor code, so they are not in the budget.</p>`
      : "";
  el("labor").innerHTML = `
    <p class="note">Hours come from ServiceTitan timesheets. Commission labor is those hours times the company billable rate times the technician's ServiceTitan commission percent. Hourly technicians use those hours times their ServiceTitan hourly rate instead. Labor burden is a separate line, the same hours times the technician's burden rate. A zero hourly rate is not a missing rate when commission is set. Pay rates are not stored here. If payroll is not permitted, appointment windows are used and the last timesheet rows stay. Nothing here writes to ServiceTitan.</p>
    ${
      data.rates_forbidden
        ? `<p class="msg">The latest ServiceTitan technician read was denied. Labor dollars already priced were left as they are. A technician with neither a commission percent nor an hourly rate stays out of labor cost.</p>`
        : ""
    }
    <div class="row"><div class="row-b"><div class="row-t">${Number(data.hours || 0).toLocaleString("en-US")} hours</div>
      ${moneyLine}
      <div class="row-m">${laborRefreshLine(data)}</div>
      <div class="row-m" id="labor-st-code">${codeText}</div></div></div>
    ${laborError}
    ${uncodedNote}
    ${techs}`;
  refresh?.addEventListener("click", async () => {
    refresh.disabled = true;
    try {
      await api(`/projects/${current.id}/labor/refresh`, { method: "POST" });
      await select(current.id);
    } catch (err) {
      refresh.disabled = false;
      window.alert(err.message);
    }
  });
}

function renderCloseout(row) {
  const c = row || {};
  const may = can("manage_project_controls");
  const disabled = may ? "" : "disabled";
  el("closetag").textContent = c.warranty_start_on
    ? `warranty ${c.warranty_start_on}`
    : "open";
  el("closeout").innerHTML = `
    <p class="note">Punch, photos, the final draw invoice, the warranty date, and the review request live on this card. Nothing here emails the customer or writes to ServiceTitan. Photos stay in the photos folder. Gate 4 is still ticked by a person.</p>
    <label><input id="cl-punch" type="checkbox" ${c.punch_done_at ? "checked" : ""} ${disabled}> Punch list complete</label>
    ${field("Punch note", `<input id="cl-punch-note" value="${esc(c.punch_note || "")}" ${disabled}>`)}
    <label><input id="cl-photos" type="checkbox" ${c.photos_done_at ? "checked" : ""} ${disabled}> Final photos filed</label>
    ${field("Photo note", `<input id="cl-photos-note" value="${esc(c.photos_note || "")}" ${disabled}>`)}
    ${field(
      "Final draw invoice number",
      `<input id="cl-invoice" value="${esc(c.final_draw_invoice_number || "")}" maxlength="80" ${disabled}>`,
    )}
    ${field(
      "Warranty start",
      `<input id="cl-warranty" type="date" value="${esc(c.warranty_start_on || "")}" ${disabled}>`,
    )}
    ${field(
      "Review request",
      `<textarea id="cl-review" maxlength="2000" ${disabled}>${esc(c.review_request_note || "")}</textarea>`,
    )}
    <p class="note">The review request is a note on this project. Nobody is emailed.</p>
    ${
      may
        ? `<div class="actions"><button class="btn sm primary" id="cl-save" type="button">Save closeout</button></div>`
        : `<p class="note">Owner, manager, or the project coordinator records closeout.</p>`
    }`;
  el("cl-save")?.addEventListener("click", async (event) => {
    const button = event.target;
    button.disabled = true;
    try {
      await api(`/projects/${current.id}/closeout`, {
        method: "PUT",
        body: JSON.stringify({
          punch_done: el("cl-punch").checked,
          punch_note: el("cl-punch-note").value,
          photos_done: el("cl-photos").checked,
          photos_note: el("cl-photos-note").value,
          final_draw_invoice_number: el("cl-invoice").value.trim() || null,
          warranty_start_on: el("cl-warranty").value || null,
          review_request_note: el("cl-review").value,
        }),
      });
      await select(current.id);
    } catch (err) {
      button.disabled = false;
      window.alert(err.message);
    }
  });
}

async function raiseChangeOrderDrawer() {
  const mayPrice = can("price_change_order");
  const codes = mayPrice ? await api("/cost-codes") : [];
  coLines = [];

  openDrawer(
    "Raise a change order",
    `${messageSlot}
     <p class="note">The customer amount lifts the revised contract on approval —
     the margin view computes that from approved change orders, so nothing here
     touches the contract value. Cost lines move the budget, and the baseline
     with it, which is what makes a change order the way past a frozen budget
     rather than a note beside it.</p>
     ${field("Description", '<textarea id="co-desc" placeholder="Customer upgraded the tile selection"></textarea>')}
     <div class="two">
       ${
         mayPrice
           ? field("Customer amount", '<input id="co-amount" type="number" step="0.01" value="0">')
           : `<p class="note">Owner or manager records the customer amount and the cost lines. You can describe the change and raise the draft.</p>`
       }
       ${field("Schedule impact, days", '<input id="co-days" type="number" step="1" value="0">')}
     </div>
     ${field("Reference in the revenue system", '<input id="co-ref" placeholder="optional">')}
     ${
       mayPrice
         ? `<span class="lbl">Cost lines</span>
     <p class="note">Negative amounts are allowed — a change order that removes
     scope is still a change order, and a credit that cannot be recorded is a
     credit somebody argues about later.</p>
     <div id="co-line-list"></div>
     <div class="two">
       ${field("Cost code", `<select id="co-code">${codeOptions(codes)}</select>`)}
       ${field("Amount", '<input id="co-line-amount" type="number" step="0.01" value="0">')}
     </div>
     <div class="actions">
       <button class="btn sm" id="co-add-line" type="button">Add cost line</button>
     </div>`
         : ""
     }

     <div class="actions right">
       <button class="btn primary" id="co-save" type="button">Raise change order</button>
     </div>`,
    () => {
      const redraw = () => {
        if (!el("co-line-list")) return;
        el("co-line-list").innerHTML = coLines.length
          ? coLines
              .map(
                (l, i) => `<div class="row"><div class="row-b">
                  <div class="row-t">${esc(l.code)} ${esc(l.description)}</div>
                  <div class="row-m">${esc(l.cost_type)}</div></div>
                  <div class="row-r">${signed(l.amount)}
                  <button class="btn sm danger" data-drop="${i}">remove</button></div></div>`,
              )
              .join("")
          : '<p class="note">No cost lines yet.</p>';
        document.querySelectorAll("#co-line-list [data-drop]").forEach((b) =>
          b.addEventListener("click", () => {
            coLines.splice(Number(b.dataset.drop), 1);
            redraw();
          }),
        );
      };
      redraw();

      el("co-add-line")?.addEventListener("click", () => {
        const chosen = codes.find((c) => c.id === el("co-code").value);
        const amount = Number(el("co-line-amount").value);
        if (!chosen || !amount) {
          drawerMessage("Pick a cost code and an amount that is not zero.");
          return;
        }
        coLines.push({
          cost_code_id: chosen.id,
          // Follows the code's own default type, for the same reason the
          // purchase order form does: the cost position matches a budget line
          // on code AND type, so a mismatch lands the money nowhere.
          cost_type: chosen.default_cost_type,
          amount,
          code: chosen.code,
          description: chosen.description,
        });
        el("co-line-amount").value = "0";
        drawerMessage("");
        redraw();
      });

      el("co-save").addEventListener("click", (e) =>
        submit(e.target, () =>
          api(`/projects/${current.id}/change-orders`, {
            method: "POST",
            body: JSON.stringify({
              description: el("co-desc").value.trim(),
              customer_amount: mayPrice ? Number(el("co-amount").value) : 0,
              schedule_impact_days: Number(el("co-days").value),
              external_estimate_ref: el("co-ref").value.trim() || null,
              lines: mayPrice
                ? coLines.map(({ cost_code_id, cost_type, amount }) => ({
                    cost_code_id,
                    cost_type,
                    amount,
                  }))
                : [],
            }),
          }),
        ),
      );
    },
  );
}

el("co-new").addEventListener("click", raiseChangeOrderDrawer);

const planning = createPlanning({
  api,
  el,
  esc,
  can,
  current: () => current,
  openDrawer,
  submit,
  field,
  messageSlot,
  refresh: () => select(current.id),
});

const stProjectConnector = createSTProjectConnector({
  api,
  el,
  esc,
  can,
  openDrawer,
  current: () => current,
  onChanged: async (id) => {
    closeDrawer();
    projects = await loadProjects();
    renderSwitch();
    await select(id);
  },
});
el("st-project-open").addEventListener("click", () =>
  stProjectConnector.open(),
);

const workspace = createWorkspace({
  api,
  el,
  esc,
  can,
  current: () => current,
  planning,
  openDrawer,
  closeDrawer,
  field,
  reload: () => select(current.id),
  onProjectDeleted: async () => {
    ++selectionRevision;
    current=null;
    localStorage.removeItem('jp.activeProject.'+session.tenant.id);
    const url=new URL(location.href);url.searchParams.delete('project');history.replaceState(null,'',url);
    el('shell').hidden=true;
    projects=await loadProjects();
    renderSwitch();
    if(projects.length) await select(projects[0].id);
    else {el('boot').hidden=false;el('boot').className='state';el('boot').textContent='Project deleted. No projects remain. Choose Add from ServiceTitan to get started.';}
  },
});

void boot();
