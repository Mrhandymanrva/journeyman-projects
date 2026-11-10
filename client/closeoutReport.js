import { formRow } from "./formRows.js";

const NARRATIVE_FIELDS = [
  ["narrative.scope", "Scope summary", "Narrative summary of the scope. You can edit the pulled summary."],
  ["narrative.schedule_commentary", "Schedule commentary", "What slipped, and what mattered."],
  ["narrative.cost_commentary", "Cost commentary", "Optional note on the pulled costs."],
  ["narrative.lessons_learned", "1.2 Lessons learned", "Required to finalize."],
  ["narrative.learning_outcomes_summary", "1.3 Learning outcomes", "Optional. Briefly summarize how the learning outcomes were met."],
  ["narrative.performance_summary", "1.4 Project performance summary", "How the team communicated, collaborated, and performed."],
  ["narrative.critical_thinking", "1.5 Critical thinking review", "Optional. Specific problem-solving examples."],
];

const POST_FIELDS = [
  ["post_mortem.initial_expectations", "Initial expectations", "What was expected at the start of the project."],
  ["post_mortem.achievements_obstacles", "Achievements and obstacles", "Required to finalize. What went well and what did not."],
  ["post_mortem.roadblocks", "Roadblocks, risks and barriers", "Delays, added cost, and what made the job harder to finish."],
  ["post_mortem.additional_resources", "Additional resources", "What else would have helped."],
  ["post_mortem.root_causes", "Root causes", "Required to finalize."],
  ["post_mortem.key_takeaways", "Key takeaways", "Required to finalize."],
  ["post_mortem.action_items", "Action items", "Required to finalize."],
  ["post_mortem.next_steps", "Next steps", "Required to finalize."],
];

function blankNarrative() {
  return {
    scope: "",
    schedule_commentary: "",
    cost_commentary: "",
    lessons_learned: "",
    learning_outcomes_summary: "",
    performance_summary: "",
    critical_thinking: "",
  };
}

function blankPost() {
  return {
    initial_expectations: "",
    achievements_obstacles: "",
    roadblocks: "",
    additional_resources: "",
    root_causes: "",
    key_takeaways: "",
    action_items: "",
    next_steps: "",
  };
}

/** Values the form should show. Refresh replaces pulled tables and keeps the narrative. */
export function reportFormState(view, options = {}) {
  const saved = view.summary || null;
  const live = options.preferLive === true && view.can_edit === true && !view.finalized;
  const figures = live || !saved?.pulled_snapshot ? view.pulled : saved.pulled_snapshot;
  const narrative = { ...blankNarrative(), ...(saved?.narrative || {}) };
  if (options.draft?.narrative) Object.assign(narrative, options.draft.narrative);
  const postText = { ...blankPost(), ...(saved?.post_mortem || {}) };
  if (options.draft?.post_mortem) {
    for (const key of Object.keys(blankPost())) postText[key] = options.draft.post_mortem[key] ?? "";
  }
  const pulledMilestones = (view.pulled?.schedule?.milestones || []).map((row) => ({
    title: row.title || "",
    due_on: row.due_on,
    completed_on: row.completed_on,
    state: row.state || "",
    note: "",
  }));
  return {
    live,
    figures,
    reportDate: options.draft?.report_date || saved?.report_date || view.today || "",
    narrative,
    postText,
    roles: live || !saved ? view.pulled?.suggested_roles || [] : saved.roles || [],
    risks: live || !saved ? view.pulled?.risks || [] : saved.risks || [],
    communications: live || !saved ? view.pulled?.communications || [] : saved.communications || [],
    outcomes: options.draft?.learning_outcomes || saved?.learning_outcomes || [],
    milestones: live ? pulledMilestones : saved ? saved.post_mortem?.milestones || [] : pulledMilestones,
  };
}

export function closeoutReportHtml(view, helpers) {
  const esc = helpers.esc;
  const state = reportFormState(view || {}, helpers);
  const editable = view.can_edit === true;
  const dis = editable ? "" : "disabled";
  const costs = view.can_view_costs === true ? state.figures?.costs : null;
  const currency = state.figures?.currency || "USD";
  const warnings = Array.isArray(view.warnings) ? view.warnings : [];
  const banner =
    view.draft_banner === true
      ? `<div class="draft-banner" id="fpr-draft-banner" role="status"><strong>Draft, not final</strong>${
          warnings.length
            ? `<ul>${warnings.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`
            : ""
        }</div>`
      : "";
  return `<section class="closeout-report" id="final-project-report" data-finalized="${view.finalized ? "true" : "false"}">
    ${banner}
    <h3 id="fpr-heading">Final project report</h3>
    <p class="note">Internal report for staff. It includes cost and margin when you can see margin. Nothing here emails the customer or writes to ServiceTitan. Saving keeps a snapshot of the pulled figures. The risk register is not changed.</p>
    ${pulledBlock(
      [
        ["Project", state.figures?.cover?.name || "—"],
        ["Number", state.figures?.cover?.project_number || "—"],
        ["Customer", state.figures?.cover?.customer || "—"],
        ["Site", state.figures?.cover?.address || "—"],
        ["Stage", state.figures?.cover?.stage || "—"],
        ["Project manager", state.figures?.cover?.pm_name || "Unassigned"],
      ],
      esc,
    )}
    ${
      view.finalized
        ? `<p class="note" id="fpr-finalized">Finalized${view.finalized_label ? ` ${esc(view.finalized_label)}` : ""}${view.finalized_by ? ` by ${esc(view.finalized_by)}` : ""}. This report is read-only.</p>`
        : ""
    }
    ${formRow(
      "Report date",
      `<input id="fpr-date" data-field="report_date" type="date" value="${esc(state.reportDate)}" ${dis}>`,
      "fpr-date",
    )}
    <h4>Roles and responsibilities</h4>
    <p class="note">Pulled from the project manager, estimator, awarded subs, and schedule assignments. Edit the rows on this report.</p>
    ${table(
      "roles",
      ["Name", "Role", "Responsibilities"],
      ["name", "role", "responsibilities"],
      state.roles,
      editable,
      esc,
    )}
    ${editable ? addButton("roles", "Add person") : ""}
    <h4>1. Final project summary</h4>
    <h4 id="fpr-scope">1.1 Content summary — Scope</h4>
    ${pulledBlock(scopeLines(state.figures), esc)}
    ${area(NARRATIVE_FIELDS[0], state.narrative.scope, editable, esc)}
    <h4 id="fpr-schedule">Schedule</h4>
    ${pulledBlock(scheduleLines(state.figures), esc)}
    ${miniTable(
      ["Milestone", "Due", "Completed", "State"],
      (state.figures?.schedule?.milestones || []).map((row) => [
        row.title,
        row.due_on,
        row.completed_on,
        row.state,
      ]),
      esc,
    )}
    ${miniTable(
      ["Task", "Start", "Finish", "Completed"],
      (state.figures?.schedule?.tasks || []).map((row) => [
        row.title,
        row.start_on,
        row.due_on,
        row.completed_on,
      ]),
      esc,
    )}
    <p class="note" id="fpr-logs">${esc(logLine(state.figures))}</p>
    ${area(NARRATIVE_FIELDS[1], state.narrative.schedule_commentary, editable, esc)}
    <h4 id="fpr-costs">Costs and budget</h4>
    ${
      view.can_view_costs
        ? `${pulledBlock(costLines(costs, currency), esc)}
           <p class="note">Pulled from financials, the cost position, approved change orders, purchase orders, and vendor bills.</p>
           ${area(NARRATIVE_FIELDS[2], state.narrative.cost_commentary, editable, esc)}`
        : `<p class="note" id="fpr-costs-hidden">Cost and margin are hidden. Download and print are limited to people who can see margin.</p>`
    }
    <h4 id="fpr-risks">Risk</h4>
    <p class="note">A snapshot on this report. The live risk register is not changed.</p>
    ${table(
      "risks",
      ["Risk description", "Impact", "Probability", "Mitigation"],
      ["description", "impact", "probability", "mitigation"],
      state.risks,
      editable,
      esc,
      { impact: "number", probability: "number" },
    )}
    ${editable ? addButton("risks", "Add risk") : ""}
    <h4 id="fpr-comms">Communication strategy and methods</h4>
    <p class="note">A snapshot on this report. The live communication plan is not changed.</p>
    ${table(
      "communications",
      ["Audience", "Channel", "Cadence", "Notes"],
      ["audience", "channel", "cadence", "notes"],
      state.communications,
      editable,
      esc,
    )}
    ${editable ? addButton("communications", "Add communication") : ""}
    ${area(NARRATIVE_FIELDS[3], state.narrative.lessons_learned, editable, esc)}
    ${area(NARRATIVE_FIELDS[4], state.narrative.learning_outcomes_summary, editable, esc)}
    ${table(
      "outcomes",
      ["Outcome name", "Detail"],
      ["name", "detail"],
      state.outcomes,
      editable,
      esc,
    )}
    ${editable ? addButton("outcomes", "Add outcome") : ""}
    ${area(NARRATIVE_FIELDS[5], state.narrative.performance_summary, editable, esc)}
    ${area(NARRATIVE_FIELDS[6], state.narrative.critical_thinking, editable, esc)}
    <h4 id="fpr-postmortem">2. Post-mortem report</h4>
    ${area(POST_FIELDS[0], state.postText.initial_expectations, editable, esc)}
    <h4>Milestones</h4>
    <p class="note">Plan milestones are listed. Add events that were not on the plan.</p>
    ${table(
      "milestones",
      ["Event", "Due", "Completed", "State", "Note"],
      ["title", "due_on", "completed_on", "state", "note"],
      state.milestones,
      editable,
      esc,
      { due_on: "date", completed_on: "date" },
    )}
    ${editable ? addButton("milestones", "Add event") : ""}
    ${POST_FIELDS.slice(1)
      .map((field) => area(field, state.postText[field[0].split(".")[1]], editable, esc))
      .join("")}
    <h4>Closeout checklist</h4>
    ${pulledBlock(closeoutLines(state.figures), esc)}
    <div class="form-actions fpr-actions">
      ${
        editable
          ? `<button class="btn sm" id="fpr-refresh" type="button">Refresh from project</button>
             <button class="btn sm" id="fpr-save" type="button">Save draft</button>
             <button class="btn sm primary" id="fpr-finalize" type="button">Finalize</button>`
          : view.finalized
            ? `<button class="btn sm" id="fpr-refresh" type="button" disabled>Refresh from project</button>`
            : ""
      }
      ${
        view.can_view_costs
          ? `<button class="btn sm" id="fpr-pdf" type="button">Download PDF</button>
             <button class="btn sm" id="fpr-print" type="button">Print</button>`
          : ""
      }
    </div>
    ${
      view.can_view_costs && !view.summary
        ? `<p class="note">An unsaved download uses the current project figures and is still a draft.</p>`
        : ""
    }
  </section>`;
}

function area(field, value, editable, esc) {
  const [name, label, hint] = field;
  const id = `fpr-${name.replaceAll(".", "-")}`;
  return `${formRow(
    label,
    `<textarea id="${id}" data-field="${name}" maxlength="20000" ${editable ? "" : "disabled"}>${esc(value || "")}</textarea>
     <p class="note">${esc(hint)}</p>`,
    id,
  )}`;
}

function addButton(table, label) {
  return `<div class="form-actions"><button class="btn sm" type="button" data-add="${table}">${label}</button></div>`;
}

function table(name, headers, columns, rows, editable, esc, kinds = {}) {
  const body = (rows.length ? rows : [{}])
    .map((row) => rowHtml(name, row, columns, editable, esc, kinds))
    .join("");
  return `<div class="fpr-scroll"><table class="fpr-table"><thead><tr>${headers
    .map((header) => `<th>${esc(header)}</th>`)
    .join("")}${editable ? "<th></th>" : ""}</tr></thead><tbody data-table="${name}">${body}</tbody></table></div>`;
}

function rowHtml(name, row, columns, editable, esc, kinds) {
  const cells = columns
    .map((column) => {
      const kind = kinds[column] || "text";
      const value = row?.[column] ?? "";
      if (kind === "number") {
        return `<td><select data-col="${column}" data-kind="number" aria-label="${column}" ${editable ? "" : "disabled"}>${[""]
          .concat(["1", "2", "3", "4", "5"])
          .map(
            (option) =>
              `<option value="${option}"${String(value ?? "") === option ? " selected" : ""}>${option || "—"}</option>`,
          )
          .join("")}</select></td>`;
      }
      const type = kind === "date" ? "date" : "text";
      return `<td><input data-col="${column}" data-kind="${kind}" type="${type}" aria-label="${column}" value="${esc(value ?? "")}" ${editable ? "" : "disabled"}></td>`;
    })
    .join("");
  const hidden = name === "risks" ? `<input type="hidden" data-col="roam" value="${esc(row?.roam || "")}">` : "";
  return `<tr data-row>${cells}${editable ? `<td>${hidden}<button class="btn sm" type="button" data-remove-row>Remove</button></td>` : hidden}</tr>`;
}

function miniTable(headers, rows, esc) {
  if (!rows.length) return "";
  return `<div class="fpr-scroll"><table class="fpr-table"><thead><tr>${headers
    .map((header) => `<th>${esc(header)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${esc(cell || "—")}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function pulledBlock(lines, esc) {
  return `<dl class="closeout-pulled">${lines
    .map(
      ([label, value]) =>
        `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`,
    )
    .join("")}</dl>`;
}

function scopeLines(pulled) {
  const docs = pulled?.scope?.charter_documents || [];
  return [
    ["Project summary", pulled?.scope?.summary || "Not recorded"],
    ["Charter and scope documents", docs.length ? docs.join(", ") : "None filed"],
  ];
}

function scheduleLines(pulled) {
  const schedule = pulled?.schedule || {};
  return [
    ["Scheduled start", schedule.scheduled_start || "—"],
    ["Scheduled end", schedule.scheduled_end || "—"],
    ["Field start", schedule.field_start || "—"],
    ["Actual start", schedule.actual_start || "—"],
    ["Actual end", schedule.actual_end || "—"],
    ["Plan baseline", [schedule.plan_baseline_start, schedule.plan_baseline_finish].filter(Boolean).join(" – ") || "—"],
  ];
}

function costLines(costs, currency) {
  if (!costs) return [["Costs", "Not recorded"]];
  const amount = (value) => money(value, currency);
  return [
    ["Contract", amount(costs.contract_value)],
    ["Budgeted expense", amount(costs.budgeted_expense)],
    ["Actual expense", amount(costs.actual_expense)],
    ["Labor, actual", amount(costs.labor_actual)],
    ["Materials, actual", amount(costs.materials_actual)],
    ["Subcontractor, actual", amount(costs.subcontractor_actual)],
    ["Budgeted margin", amount(costs.budgeted_margin)],
    ["Budgeted margin percent", percent(costs.budgeted_margin_percent)],
    ["Actual margin", amount(costs.actual_margin)],
    ["Actual margin percent", percent(costs.actual_margin_percent)],
    ["Open commitments", amount(costs.committed_open)],
    ["Total committed", amount(costs.total_committed)],
    ["Variance", amount(costs.variance)],
    ["Approved change orders", amount(costs.approved_change_orders)],
    ["Purchase orders", `${costs.purchase_orders.count} · ${amount(costs.purchase_orders.total)}`],
    ["Vendor bills", `${costs.vendor_bills.count} · ${amount(costs.vendor_bills.total)}`],
  ];
}

function closeoutLines(pulled) {
  const closeout = pulled?.closeout || {};
  return [
    ["Punch list", closeout.punch_done ? "Done" : "Open"],
    ["Final photos", closeout.photos_done ? "Done" : "Open"],
    ["Photos folder", countLabel(closeout.photo_document_count, "document")],
    ["Closeout folder", countLabel(closeout.closeout_document_count, "document")],
    ["Final draw invoice", closeout.final_draw_invoice_number || "—"],
    ["Warranty start", closeout.warranty_start_on || "—"],
    ["Review request", closeout.review_request_note || "—"],
    ["Gate 4", closeout.gate_4_status || "—"],
  ];
}

function countLabel(count, singular) {
  const n = Number(count ?? 0);
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

function logLine(pulled) {
  const logs = pulled?.daily_logs || { count: 0 };
  const range = logs.first_on
    ? `, ${logs.first_on} through ${logs.last_on || logs.first_on}`
    : "";
  return `Daily logs: ${logs.count} ${logs.count === 1 ? "entry" : "entries"}${range}. Excerpts are not included.`;
}

function money(value, currency) {
  if (value == null || Number.isNaN(Number(value))) return "Not recorded";
  try {
    return Number(value).toLocaleString("en-US", { style: "currency", currency: currency || "USD" });
  } catch {
    return Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" });
  }
}

function percent(value) {
  if (value == null || Number.isNaN(Number(value))) return "Not recorded";
  return `${Number(value).toFixed(2)}%`;
}

export function closeoutReportPayload(root) {
  const field = (name) => root.querySelector(`[data-field="${name}"]`)?.value ?? "";
  const rows = (table, columns) =>
    [...root.querySelectorAll(`[data-table="${table}"] [data-row]`)].map((row) => {
      const record = {};
      for (const column of columns) {
        const input = row.querySelector(`[data-col="${column}"]`);
        const raw = input?.value ?? "";
        if (input?.dataset.kind === "number") record[column] = raw === "" ? null : Number(raw);
        else if (input?.dataset.kind === "date") record[column] = raw || null;
        else record[column] = raw;
      }
      return record;
    });
  return {
    version: 1,
    report_date: field("report_date"),
    roles: rows("roles", ["name", "role", "responsibilities"]),
    narrative: {
      scope: field("narrative.scope"),
      schedule_commentary: field("narrative.schedule_commentary"),
      cost_commentary: field("narrative.cost_commentary"),
      lessons_learned: field("narrative.lessons_learned"),
      learning_outcomes_summary: field("narrative.learning_outcomes_summary"),
      performance_summary: field("narrative.performance_summary"),
      critical_thinking: field("narrative.critical_thinking"),
    },
    risks: rows("risks", ["description", "impact", "probability", "mitigation", "roam"]),
    communications: rows("communications", ["audience", "channel", "cadence", "notes"]),
    learning_outcomes: rows("outcomes", ["name", "detail"]),
    post_mortem: {
      initial_expectations: field("post_mortem.initial_expectations"),
      milestones: rows("milestones", ["title", "due_on", "completed_on", "state", "note"]),
      achievements_obstacles: field("post_mortem.achievements_obstacles"),
      roadblocks: field("post_mortem.roadblocks"),
      additional_resources: field("post_mortem.additional_resources"),
      root_causes: field("post_mortem.root_causes"),
      key_takeaways: field("post_mortem.key_takeaways"),
      action_items: field("post_mortem.action_items"),
      next_steps: field("post_mortem.next_steps"),
    },
  };
}

const BLANK_ROW = {
  roles: { name: "", role: "", responsibilities: "" },
  risks: { description: "", impact: "", probability: "", mitigation: "", roam: "" },
  communications: { audience: "", channel: "", cadence: "", notes: "" },
  outcomes: { name: "", detail: "" },
  milestones: { title: "", due_on: "", completed_on: "", state: "", note: "" },
};

const ROW_COLUMNS = {
  roles: ["name", "role", "responsibilities"],
  risks: ["description", "impact", "probability", "mitigation"],
  communications: ["audience", "channel", "cadence", "notes"],
  outcomes: ["name", "detail"],
  milestones: ["title", "due_on", "completed_on", "state", "note"],
};

const ROW_KINDS = {
  risks: { impact: "number", probability: "number" },
  milestones: { due_on: "date", completed_on: "date" },
};

export function mountCloseoutReport(host, deps) {
  let generation = 0;
  if (!host.dataset.bound) {
    host.dataset.bound = "1";
    host.addEventListener("click", (event) => {
      const add = event.target.closest?.("[data-add]");
      if (add && host.contains(add)) {
        const name = add.dataset.add;
        const body = host.querySelector(`[data-table="${name}"]`);
        body?.insertAdjacentHTML(
          "beforeend",
          rowHtml(name, BLANK_ROW[name], ROW_COLUMNS[name], true, deps.esc, ROW_KINDS[name] || {}),
        );
        return;
      }
      const remove = event.target.closest?.("[data-remove-row]");
      if (remove && host.contains(remove)) remove.closest("[data-row]")?.remove();
    });
  }

  function paint(view, options) {
    host.innerHTML = closeoutReportHtml(view, { esc: deps.esc, ...options });
    host.querySelector("#fpr-refresh")?.addEventListener("click", () => void load(true));
    host.querySelector("#fpr-save")?.addEventListener("click", () => void submit(view, "save"));
    host.querySelector("#fpr-finalize")?.addEventListener("click", () => void submit(view, "finalize"));
    host.querySelector("#fpr-pdf")?.addEventListener("click", () => void download(view));
    host.querySelector("#fpr-print")?.addEventListener("click", () => void printReport(view));
    if (location.hash === "#closeout-report") {
      host.querySelector("#final-project-report")?.scrollIntoView?.({ block: "start" });
    }
  }

  async function load(preferLive) {
    const token = ++generation;
    const draft = preferLive && host.querySelector("[data-field]") ? closeoutReportPayload(host) : null;
    if (!preferLive) host.innerHTML = `<p class="note">Loading the final project report…</p>`;
    try {
      const view = await deps.load();
      if (token !== generation) return;
      paint(view, { preferLive, draft });
    } catch (err) {
      if (token !== generation) return;
      host.innerHTML = `<p class="note">${deps.esc(err.message || "The report could not be loaded.")}</p>`;
    }
  }

  async function submit(view, action) {
    const button = host.querySelector(action === "save" ? "#fpr-save" : "#fpr-finalize");
    if (button) button.disabled = true;
    try {
      const next = await deps[action](closeoutReportPayload(host));
      paint(next, {});
    } catch (err) {
      if (button) button.disabled = false;
      deps.alert(err.message);
    }
  }

  async function download(view) {
    try {
      const res = await deps.fetchRaw(`/projects/${deps.projectId}/closeout/summary.pdf`);
      if (!res.ok) throw new Error(await errorMessage(res));
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `closeout-${view.pulled?.cover?.project_number || deps.projectNumber || "project"}.pdf`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      deps.alert(err.message);
    }
  }

  async function printReport() {
    try {
      const res = await deps.fetchRaw(`/projects/${deps.projectId}/closeout/summary.html`);
      if (!res.ok) throw new Error(await errorMessage(res));
      const html = await res.text();
      const popup = window.open("", "_blank");
      if (!popup) throw new Error("Allow pop-ups to print the report.");
      popup.document.open();
      popup.document.write(html);
      popup.document.close();
      popup.focus();
      popup.print();
    } catch (err) {
      deps.alert(err.message);
    }
  }

  return load(false);
}

async function errorMessage(res) {
  const text = await res.text();
  try {
    const body = JSON.parse(text);
    return body?.error?.message || `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}
