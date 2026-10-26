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

function moneyValue(value) {
  if (value == null || value === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "";
}

/**
 * CSR hand-off form. `view.fields` is the saved row, or the prefill when
 * nothing has been saved yet.
 */
export function csrHandoffHtml(view, { esc, canSave }) {
  const fields = view?.fields || {};
  const status = view?.status || "";
  const gate = view?.gate;
  const gateLine = !gate
    ? ""
    : gate.status === "approved"
      ? `<p class="csr-gate" data-gate-status="approved">Gate 0, ${esc(gate.title)}, is complete.</p>`
      : `<p class="csr-gate" data-gate-status="${esc(gate.status)}">Gate 0, ${esc(gate.title)}, completes when this form is submitted with the required fields.</p>`;
  const submitted = status === "submitted";
  const state = !view?.saved
    ? "Not saved yet. Details already on the project are filled in."
    : submitted && view.acknowledged_at
      ? `Acknowledged${view.acknowledged_by_name ? " by " + view.acknowledged_by_name : ""}.`
      : submitted
        ? "Submitted. Waiting for the Project Coordinator."
        : "Draft. Not submitted.";
  const disabled = canSave ? "" : " disabled";
  const buttons = canSave
    ? `<div class="csr-actions"><button class="btn" type="submit" data-submit="false">Save</button><button class="btn primary" type="submit" data-submit="true">Submit hand-off</button></div>`
    : `<p class="hint">You can read this hand-off. Saving it is limited to office, the project coordinator, and leadership.</p>`;
  return `<p class="csr-status" role="status">${esc(state)}</p>
${gateLine}
<p class="hint">Required to submit: customer name, phone or email, service address, office, and scope summary. Submit records the hand-off for the Project Coordinator. Nothing is emailed.</p>
<form id="csr-handoff-form" class="csr-form">
  <div class="csr-grid">
    <label>Customer name<input id="csr-customer_name" maxlength="200"${disabled} value="${esc(valueOf(fields, "customer_name"))}"></label>
    <label>Phone<input id="csr-phone" type="tel" maxlength="40"${disabled} value="${esc(valueOf(fields, "phone"))}"></label>
    <label>Email<input id="csr-email" type="email" maxlength="200"${disabled} value="${esc(valueOf(fields, "email"))}"></label>
    <label class="csr-wide">Service address<input id="csr-service_address" maxlength="500"${disabled} value="${esc(valueOf(fields, "service_address"))}"></label>
    <label>Office<select id="csr-office"${disabled}>${options(OFFICES, fields.office || "", esc, "Choose an office")}</select></label>
    <label>Lead source<input id="csr-lead_source" maxlength="200"${disabled} value="${esc(valueOf(fields, "lead_source"))}"></label>
    <label class="csr-wide">Scope summary<textarea id="csr-scope_summary" maxlength="8000" rows="4"${disabled}>${esc(valueOf(fields, "scope_summary"))}</textarea></label>
    <label>Handoff project link / id<input id="csr-handoff_project_ref" maxlength="200"${disabled} value="${esc(valueOf(fields, "handoff_project_ref"))}"></label>
    <label>Handoff estimate amount<input id="csr-handoff_estimate_amount" type="number" min="0" step="0.01"${disabled} value="${esc(moneyValue(fields.handoff_estimate_amount))}"></label>
    <label>Sold amount<input id="csr-sold_amount" type="number" min="0" step="0.01"${disabled} value="${esc(moneyValue(fields.sold_amount))}"></label>
    <label>Target start window<input id="csr-target_start_window" maxlength="200"${disabled} value="${esc(valueOf(fields, "target_start_window"))}"></label>
    <label>Permits likely<select id="csr-permits_likely"${disabled}>${options(PERMITS, fields.permits_likely || "", esc, "Not set")}</select></label>
    <label class="csr-wide">Access / site notes<textarea id="csr-access_notes" maxlength="4000" rows="3"${disabled}>${esc(valueOf(fields, "access_notes"))}</textarea></label>
    <label class="csr-wide">Decision-maker notes<textarea id="csr-decision_maker_notes" maxlength="4000" rows="3"${disabled}>${esc(valueOf(fields, "decision_maker_notes"))}</textarea></label>
  </div>
  <p class="csr-error" id="csr-handoff-error" role="alert"></p>
  ${buttons}
</form>`;
}

function moneyOrNull(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
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
          customer_name: read("customer_name"),
          phone: read("phone"),
          email: read("email"),
          service_address: read("service_address"),
          office: read("office"),
          lead_source: read("lead_source"),
          scope_summary: read("scope_summary"),
          handoff_project_ref: read("handoff_project_ref"),
          handoff_estimate_amount: moneyOrNull(
            root.querySelector("#csr-handoff_estimate_amount")?.value,
          ),
          sold_amount: moneyOrNull(root.querySelector("#csr-sold_amount")?.value),
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
