const TYPE_LABELS = {
  permit: "Permit",
  site_visit: "Site visit",
  selection: "Selection",
  plans: "Plans",
  material_order: "Material order",
  other: "Other",
};

const STATUSES = [
  ["not_started", "Not started"],
  ["in_progress", "In progress"],
  ["done", "Done"],
  ["waived", "Waived"],
];

const RESULTS = [
  ["pending", "Pending"],
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
];

function day(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return "No date";
  return new Date(match[1] + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function roleLabel(value) {
  return String(value || "").replace(/_/g, " ");
}

function safeHref(url) {
  return /^https?:\/\//i.test(String(url || "")) ? String(url) : "";
}

function officeBlock(task, esc) {
  const office = task.office;
  if (!office) return "";
  const portal = safeHref(office.portal_url);
  const site = safeHref(office.website_url);
  const inspectionUrl = safeHref(office.inspection_url);
  const bits = [
    office.office_name || office.name,
    office.main_phone,
    office.typical_review_days != null
      ? `${office.typical_review_days} day review`
      : "",
    office.last_verified ? `verified ${day(office.last_verified)}` : "",
  ].filter(Boolean);
  const links = [
    portal ? `<a href="${esc(portal)}" target="_blank" rel="noopener noreferrer">Portal</a>` : "",
    site ? `<a href="${esc(site)}" target="_blank" rel="noopener noreferrer">Website</a>` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const inspection = [
    office.inspection_method ? `Inspections by ${office.inspection_method.replace(/_/g, " ")}` : "",
    office.inspection_phone,
    inspectionUrl
      ? `<a href="${esc(inspectionUrl)}" target="_blank" rel="noopener noreferrer">Inspection link</a>`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const criteria = [
    office.work_requiring_permit,
    office.required_documents,
    office.plan_requirements,
    office.fee_notes,
  ]
    .filter(Boolean)
    .map((text) => `<p>${esc(text)}</p>`)
    .join("");
  return `<div class="precon-office"><span class="lbl">Permit office</span><p>${esc(bits.join(" · "))}${links ? " · " + links : ""}</p>${inspection ? `<p>${inspection}</p>` : ""}${criteria}</div>`;
}

function inspectionList(task, esc) {
  const rows = task.inspections || [];
  if (!rows.length) return "";
  return `<ul class="precon-inspections">${rows
    .map((item) => {
      const when = item.occurred_on
        ? `occurred ${day(item.occurred_on)}`
        : item.scheduled_on
          ? `scheduled ${day(item.scheduled_on)}`
          : "unscheduled";
      return `<li><b>${esc(item.result || "pending")}</b> · ${esc(when)}${item.notes ? ` · ${esc(item.notes)}` : ""}</li>`;
    })
    .join("")}</ul>`;
}

function taskHtml(task, canEdit, esc) {
  const overdue = task.overdue === true;
  const status = STATUSES.map(
    ([value, label]) =>
      `<option value="${value}"${task.status === value ? " selected" : ""}>${label}</option>`,
  ).join("");
  const material = task.material_order_number
    ? `<p class="precon-meta">Material order ${esc(task.material_order_number)}${task.card_charge_state === "awaiting_card_charge" ? " · awaiting card charge" : task.card_charge_state === "matched" ? " · card charge matched" : ""}</p>`
    : "";
  const permit = task.permit_number
    ? `<p class="precon-meta">Permit ${esc(task.permit_number)}</p>`
    : "";
  const actions = canEdit
    ? `<div class="actions"><button class="btn sm" type="button" data-precon-edit="${esc(task.id)}">Edit</button>${task.type === "permit" ? `<button class="btn sm" type="button" data-precon-inspect="${esc(task.id)}">Add inspection</button>` : ""}</div>`
    : "";
  return `<article class="precon-task${overdue ? " overdue" : ""}" data-task="${esc(task.id)}">
    <div class="precon-head">
      <div>
        <strong>${esc(task.title)}</strong>
        ${overdue ? '<span class="badge-overdue">Overdue</span>' : ""}
        <p class="precon-meta">${esc(TYPE_LABELS[task.type] || task.type)} · ${esc(roleLabel(task.owner_role))} · due ${esc(day(task.due_on))}</p>
        ${permit}
        ${material}
      </div>
      <label>Status<select data-precon-status="${esc(task.id)}"${canEdit ? "" : " disabled"}>${status}</select></label>
    </div>
    ${task.notes ? `<p class="precon-notes">${esc(task.notes)}</p>` : ""}
    ${officeBlock(task, esc)}
    ${inspectionList(task, esc)}
    ${actions}
  </article>`;
}

/**
 * Checklist for work that happens before the crew is on site.
 * Counts and overdue come from the project payload.
 */
export function preconHtml({ precon, canEdit, esc }) {
  const tasks = Array.isArray(precon?.tasks) ? precon.tasks : [];
  const open = Number(precon?.open ?? 0);
  const overdue = Number(precon?.overdue ?? 0);
  const tools = canEdit
    ? `<div class="actions">${tasks.length ? "" : '<button class="btn primary" type="button" data-precon-apply>Apply template</button>'}<button class="btn" type="button" data-precon-add>Add task</button></div>`
    : "";
  const body = tasks.length
    ? tasks.map((task) => taskHtml(task, canEdit, esc)).join("")
    : `<div class="workspace-empty"><strong>No preconstruction tasks</strong><p>Apply the company template or add the first task. Overdue follows America/New_York, and a due date of today is not overdue.</p></div>`;
  return `<div class="card-h"><div><span class="lbl">Preconstruction</span><h2>Checklist</h2></div><span class="tag${overdue ? " bad" : ""}">${open} open${overdue ? ` · ${overdue} overdue` : ""}</span>${tools}</div><div class="precon-body">${body}</div><p class="precon-msg" role="alert"></p>`;
}

export function bindPrecon(root, handlers) {
  if (!root || !handlers) return;
  const report = (err) => {
    const box = root.querySelector(".precon-msg");
    if (box) box.textContent = err?.message || "That did not work.";
    if (handlers.onError) handlers.onError(err);
  };
  const run = async (node, work) => {
    if (node) node.disabled = true;
    try {
      await work();
    } catch (err) {
      report(err);
      if (node) node.disabled = false;
    }
  };
  const apply = root.querySelector("[data-precon-apply]");
  if (apply) {
    apply.addEventListener("click", () => run(apply, () => handlers.onApply()));
  }
  const add = root.querySelector("[data-precon-add]");
  if (add) add.addEventListener("click", () => handlers.onAdd());
  root.querySelectorAll("[data-precon-status]").forEach((select) => {
    select.addEventListener("change", () =>
      run(select, () => handlers.onStatus(select.dataset.preconStatus, select.value)),
    );
  });
  root.querySelectorAll("[data-precon-edit]").forEach((button) => {
    button.addEventListener("click", () => handlers.onEdit(button.dataset.preconEdit));
  });
  root.querySelectorAll("[data-precon-inspect]").forEach((button) => {
    button.addEventListener("click", () => handlers.onInspect(button.dataset.preconInspect));
  });
}

export const PRECON_STATUSES = STATUSES;
export const PRECON_TYPES = Object.entries(TYPE_LABELS);
export const INSPECTION_RESULTS = RESULTS;
