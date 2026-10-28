const OFFICES = [
  ["richmond", "Richmond"],
  ["hampton_newport_news", "Hampton-Newport News"],
];

const PERMITS = [
  ["yes", "Yes"],
  ["no", "No"],
  ["unknown", "Unknown"],
];

function valueOf(fields, key) {
  const value = fields?.[key];
  return value == null ? "" : String(value);
}

function options(pairs, current, esc, blank) {
  const head = `<option value="">${esc(blank)}</option>`;
  return (
    head +
    pairs
      .map(
        ([value, label]) =>
          `<option value="${esc(value)}"${current === value ? " selected" : ""}>${esc(label)}</option>`,
      )
      .join("")
  );
}

const NOT_IN_SERVICETITAN = "Not in ServiceTitan";

function moneyLabel(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function readOnlyFact(key, label, value, esc, { wide = false, money = false } = {}) {
  const missing = value == null || String(value).trim() === "";
  const shown = missing ? NOT_IN_SERVICETITAN : money ? moneyLabel(value) : String(value);
  return `<div class="csr-readonly${wide ? " csr-wide" : ""}" data-st-field="${esc(key)}">
    <span class="csr-readonly-label">${esc(label)}</span>
    <p class="csr-readonly-value"${missing ? ' data-missing="true"' : ""}>${esc(shown || NOT_IN_SERVICETITAN)}</p>
  </div>`;
}

/**
 * CSR hand-off form. Customer, phone, email, address, estimate, and sold
 * amount are read from ServiceTitan data already on the project. The CSR
 * types the rest.
 */
export function csrHandoffHtml(view, { esc, canSave }) {
  const fields = view?.fields || {};
  const st = view?.service_titan || {};
  const status = view?.status || "";
  const gate = view?.gate;
  const gateLine = !gate
    ? ""
    : gate.status === "approved"
      ? `<p class="csr-gate" data-gate-status="approved">Gate 0, ${esc(gate.title)}, is complete.</p>`
      : `<p class="csr-gate" data-gate-status="${esc(gate.status)}">Gate 0, ${esc(gate.title)}, completes when this form is submitted with the required fields.</p>`;
  const submitted = status === "submitted";
  const state = !view?.saved
    ? "Not saved yet. ServiceTitan details are shown read-only."
    : submitted && view.acknowledged_at
      ? `Acknowledged${view.acknowledged_by_name ? " by " + view.acknowledged_by_name : ""}.`
      : submitted
        ? "Submitted. Waiting for the Project Coordinator."
        : "Draft. Not submitted.";
  const disabled = canSave ? "" : " disabled";
  const buttons = canSave
    ? `<div class="csr-actions"><button class="btn" type="submit" data-submit="false">Save</button><button class="btn primary" type="submit" data-submit="true">Submit hand-off</button></div>`
    : `<p class="hint">You can read this hand-off. Saving it is limited to office, the project coordinator, and leadership.</p>`;
  return `<p class="hint">Internal handover of a sold job to the Project Coordinator. Doesn't send anything to ServiceTitan or Handoff.</p>
<p class="csr-status" role="status">${esc(state)}</p>
${gateLine}
<p class="hint">Customer name, phone, email, service address, estimate, and sold amount are read from ServiceTitan. A missing value says Not in ServiceTitan and is not typed in. Required to submit: customer name, phone or email, and service address from ServiceTitan, plus office and scope summary. Nothing is emailed.</p>
<form id="csr-handoff-form" class="csr-form">
  <div class="csr-grid">
    ${readOnlyFact("customer_name", "Customer name", st.customer_name, esc)}
    ${readOnlyFact("phone", "Phone", st.phone, esc)}
    ${readOnlyFact("email", "Email", st.email, esc)}
    ${readOnlyFact("service_address", "Service address", st.service_address, esc, { wide: true })}
    <label>Office<select id="csr-office"${disabled}>${options(OFFICES, fields.office || "", esc, "Choose an office")}</select></label>
    <label>Lead source<input id="csr-lead_source" maxlength="200"${disabled} value="${esc(valueOf(fields, "lead_source"))}"></label>
    <label class="csr-wide">Scope summary<textarea id="csr-scope_summary" maxlength="8000" rows="4"${disabled}>${esc(valueOf(fields, "scope_summary"))}</textarea></label>
    <label>ServiceTitan project #<input id="csr-handoff_project_ref" maxlength="200"${disabled} value="${esc(valueOf(fields, "handoff_project_ref"))}"></label>
    ${readOnlyFact("estimate_amount", "Estimate amount (ServiceTitan)", st.estimate_amount, esc, { money: true })}
    ${readOnlyFact("sold_amount", "Sold amount", st.sold_amount, esc, { money: true })}
    <label>Target start window<input id="csr-target_start_window" maxlength="200"${disabled} value="${esc(valueOf(fields, "target_start_window"))}"></label>
    <label>Permits likely<select id="csr-permits_likely"${disabled}>${options(PERMITS, fields.permits_likely || "", esc, "Not set")}</select></label>
    <label class="csr-wide">Access / site notes<textarea id="csr-access_notes" maxlength="4000" rows="3"${disabled}>${esc(valueOf(fields, "access_notes"))}</textarea></label>
    <label class="csr-wide">Decision-maker notes<textarea id="csr-decision_maker_notes" maxlength="4000" rows="3"${disabled}>${esc(valueOf(fields, "decision_maker_notes"))}</textarea></label>
  </div>
  <p class="csr-error" id="csr-handoff-error" role="alert"></p>
  ${buttons}
</form>`;
}

export function bindCsrHandoff(root, { api, projectId, onSaved }) {
  const form = root.querySelector("#csr-handoff-form");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = root.querySelector("#csr-handoff-error");
    if (error) error.textContent = "";
    const submit = event.submitter?.dataset.submit === "true";
    const buttons = [...form.querySelectorAll("button")];
    buttons.forEach((button) => {
      button.disabled = true;
    });
    const read = (id) => root.querySelector("#csr-" + id)?.value?.trim() ?? "";
    try {
      await api("/projects/" + projectId + "/handoff", {
        method: "PUT",
        body: JSON.stringify({
          office: read("office"),
          lead_source: read("lead_source"),
          scope_summary: read("scope_summary"),
          handoff_project_ref: read("handoff_project_ref"),
          target_start_window: read("target_start_window"),
          access_notes: read("access_notes"),
          decision_maker_notes: read("decision_maker_notes"),
          permits_likely: read("permits_likely"),
          submit,
        }),
      });
      if (onSaved) await onSaved();
    } catch (err) {
      if (error) error.textContent = err.message;
      buttons.forEach((button) => {
        button.disabled = false;
      });
    }
  });
}
