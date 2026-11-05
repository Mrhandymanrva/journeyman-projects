/**
 * The project budget form. It writes the same budget the cost-code lines use.
 * A blank field is not zero.
 */

import { formRow } from "./formRows.js";

const moneyText = (value) =>
  Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" });

export function formatBudgetMoney(value) {
  if (value == null || !Number.isFinite(Number(value))) return "\u2014";
  return moneyText(value);
}

function readField(raw) {
  const text = String(raw ?? "")
    .trim()
    .replace(/[$,]/g, "");
  if (text === "") return { value: null };
  const n = Number(text);
  if (!Number.isFinite(n)) return { error: "Enter a number, or leave the field blank." };
  if (n < 0) return { error: "Amounts cannot be negative." };
  return { value: Math.round(n * 100) / 100 };
}

export function budgetEntryTotal(fields) {
  const values = ["labor", "materials", "subcontractor", "other"].map((key) => readField(fields?.[key]));
  if (values.some((item) => item.error)) return null;
  const present = values.map((item) => item.value).filter((value) => value != null);
  if (present.length === 0) return null;
  return Math.round(present.reduce((sum, value) => sum + value, 0) * 100) / 100;
}

/** Contract value minus total budgeted cost. Blank on either side is null. A zero contract has no percent. */
export function budgetEntryMargin(fields) {
  const contract = readField(fields?.contract_value);
  const total = budgetEntryTotal(fields);
  if (contract.error || contract.value == null || total == null) {
    return { amount: null, percent: null };
  }
  const amount = Math.round((contract.value - total) * 100) / 100;
  if (contract.value === 0) return { amount, percent: null };
  const percent = Math.round((amount / contract.value) * 1000) / 10;
  return { amount, percent };
}

function formatSignedMoney(value) {
  const text = formatBudgetMoney(Math.abs(value));
  return value < 0 ? `\u2212${text}` : text;
}

function formatSignedPercent(percent) {
  const body = Math.abs(percent).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return percent < 0 ? `\u2212${body}%` : `${body}%`;
}

export function formatBudgetMargin(margin) {
  if (!margin || margin.amount == null || !Number.isFinite(margin.amount)) return "\u2014";
  const money = formatSignedMoney(margin.amount);
  if (margin.percent == null || !Number.isFinite(margin.percent)) return money;
  return `${money} (${formatSignedPercent(margin.percent)})`;
}

function budgetFieldsFrom(doc) {
  return {
    contract_value: doc.getElementById("budget-contract")?.value,
    labor: doc.getElementById("budget-labor")?.value,
    materials: doc.getElementById("budget-materials")?.value,
    subcontractor: doc.getElementById("budget-sub")?.value,
    other: doc.getElementById("budget-other")?.value,
  };
}

export function refreshBudgetEntryFigures(root) {
  const doc = root && typeof root.getElementById === "function" ? root : document;
  const fields = budgetFieldsFrom(doc);
  const totalNode = doc.getElementById("budget-total");
  if (totalNode) totalNode.textContent = formatBudgetMoney(budgetEntryTotal(fields));
  const margin = budgetEntryMargin(fields);
  const marginNode = doc.getElementById("budget-margin");
  if (!marginNode) return;
  marginNode.textContent = formatBudgetMargin(margin);
  marginNode.classList?.toggle("neg", margin.amount != null && margin.amount < 0);
}

export function bindBudgetEntryFigures(root) {
  const doc = root && typeof root.getElementById === "function" ? root : document;
  const refresh = () => refreshBudgetEntryFigures(doc);
  for (const id of ["budget-contract", "budget-labor", "budget-materials", "budget-sub", "budget-other"]) {
    const input = doc.getElementById(id);
    if (!input || input.dataset?.marginBound === "true") continue;
    input.dataset.marginBound = "true";
    input.addEventListener("input", refresh);
  }
}

export function budgetEntryPayload(fields) {
  const contract = readField(fields?.contract_value);
  if (contract.error) return { error: contract.error };
  if (contract.value != null && contract.value <= 0) {
    return { error: "Contract value has to be greater than zero, or left blank." };
  }
  const labor = readField(fields?.labor);
  const hours = readField(fields?.labor_hours);
  const materials = readField(fields?.materials);
  const subcontractor = readField(fields?.subcontractor);
  const other = readField(fields?.other);
  const invalid = [labor, hours, materials, subcontractor, other].find((item) => item.error);
  if (invalid?.error) return { error: invalid.error };
  return {
    body: {
      contract_value: contract.value,
      labor: labor.value,
      labor_hours: hours.value,
      materials: materials.value,
      subcontractor: subcontractor.value,
      other: other.value,
    },
  };
}

function fieldValue(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : "";
}

function moneyField(id, label, value, editable) {
  const disabled = editable ? "" : " disabled";
  return formRow(
    label,
    `<input id="${id}" name="${id}" inputmode="decimal" autocomplete="off"${disabled} value="${fieldValue(value)}">`,
    id,
  );
}

function contractField(value, editable) {
  const disabled = editable ? "" : " disabled";
  return formRow(
    "Contract value",
    `<input id="budget-contract" name="budget-contract" inputmode="decimal" autocomplete="off"${disabled} value="${fieldValue(value)}"><p class="hint" id="budget-contract-hint">What the customer pays</p>`,
    "budget-contract",
  );
}

function budgetGroup(title, body) {
  return `<fieldset class="budget-group"><legend>${title}</legend>${body}</fieldset>`;
}

const SOLD_ESTIMATE_FIELDS = [
  ["budget-contract", "contractValue", "data-contract", "contract"],
  ["budget-labor", "budgetedLaborExpense", "data-labor", "labor"],
  ["budget-hours", "budgetedLaborHours", "data-hours", "hours"],
  ["budget-materials", "budgetedMaterials", "data-materials", "materials"],
];

/**
 * Owner, manager, and project manager may type the first budget even after the
 * freeze gate. A freeze with nothing entered leaves Contract value disabled,
 * so Enter budget cannot focus it. Later changes stay on a change order.
 * Other roles never edit.
 */
export function budgetFormEditable({ canEdit, frozen, entered }) {
  return Boolean(canEdit) && (!frozen || !entered);
}

export function soldEstimateHasFigures(sold) {
  if (!sold) return false;
  return SOLD_ESTIMATE_FIELDS.some(([, key]) => {
    const value = sold[key];
    return value != null && value !== "" && Number.isFinite(Number(value));
  });
}

function soldFigure(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "";
  return String(Math.round(Number(value) * 100) / 100);
}

function soldEstimateButton(sold) {
  const attrs = SOLD_ESTIMATE_FIELDS.map(([, key, attr]) => {
    const text = soldFigure(sold?.[key]);
    return text === "" ? "" : ` ${attr}="${text}"`;
  }).join("");
  return `<button class="btn" id="use-st-estimate" type="button"${attrs}>Use ST estimate</button>`;
}

export function budgetEntryHtml(entry, options) {
  const row = entry || {};
  const editable = Boolean(options?.editable);
  const frozen = Boolean(options?.frozen);
  const showEstimate = editable && soldEstimateHasFigures(options?.soldEstimate);
  const hint = frozen
    ? "The budget baseline is frozen. Changes belong on a change order."
    : editable
      ? "This is the project budget. Cost-code lines below are part of the same totals."
      : "You can view this budget. An owner, manager, or project manager can change it.";
  const estimateNote = showEstimate
    ? `<p class="hint" id="budget-st-note">Use ST estimate copies the ServiceTitan sold estimate into these fields. Nothing is saved until you click Save budget.</p>`
    : "";
  const total = budgetEntryTotal(row);
  const margin = budgetEntryMargin(row);
  const marginNeg = margin.amount != null && margin.amount < 0 ? " neg" : "";
  return `<form id="budget-entry-form" class="budget-entry">
    <p class="hint">${hint}</p>
    ${estimateNote}
    ${budgetGroup(
      "Revenue",
      contractField(row.contract_value, editable),
    )}
    ${budgetGroup(
      "Budgeted cost",
      `${moneyField("budget-labor", "Labor cost", row.labor, editable)}
    ${moneyField("budget-hours", "Labor hours", row.labor_hours, editable)}
    ${moneyField("budget-materials", "Materials", row.materials, editable)}
    ${moneyField("budget-sub", "Subcontractor", row.subcontractor, editable)}
    ${moneyField("budget-other", "Other", row.other, editable)}
    ${formRow("Total budgeted cost", `<output id="budget-total" class="budget-total">${formatBudgetMoney(total)}</output>`)}`,
    )}
    <div class="budget-margin"><div class="budget-margin-label">Expected margin</div><output id="budget-margin" class="budget-margin-value${marginNeg}">${formatBudgetMargin(margin)}</output></div>
    ${
      editable
        ? `<div class="form-actions">${showEstimate ? soldEstimateButton(options.soldEstimate) : ""}<button class="btn primary" id="budget-save" type="submit">Save budget</button></div>`
        : ""
    }
    <p class="msg" id="budget-entry-msg" role="status"></p>
  </form>`;
}

/** Copy sold-estimate figures already on the button into the form. Does not save. */
export function applySoldEstimateFromButton(button) {
  if (!button) return;
  const root = button.ownerDocument || document;
  for (const [id, , , key] of SOLD_ESTIMATE_FIELDS) {
    const raw = button.dataset?.[key];
    if (raw == null || raw === "") continue;
    const input = root.getElementById(id);
    if (!input || input.disabled || input.readOnly) continue;
    input.value = soldFigure(raw);
    const EventCtor = root.defaultView?.Event || globalThis.Event;
    if (typeof input.dispatchEvent === "function" && typeof EventCtor === "function") {
      input.dispatchEvent(new EventCtor("input", { bubbles: true }));
    }
  }
  refreshBudgetEntryFigures(root);
}

export function bindSoldEstimateButton(root) {
  const doc = root || document;
  const button = doc.querySelector?.("#use-st-estimate") || doc.getElementById?.("use-st-estimate");
  if (!button || button.dataset.bound === "true") return;
  button.dataset.bound = "true";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    applySoldEstimateFromButton(button);
  });
}
