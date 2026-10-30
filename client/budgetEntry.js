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
  return `<form id="budget-entry-form" class="budget-entry">
    <p class="hint">${hint}</p>
    ${estimateNote}
    ${moneyField("budget-contract", "Contract value", row.contract_value, editable)}
    ${moneyField("budget-labor", "Labor", row.labor, editable)}
    ${moneyField("budget-hours", "Labor hours", row.labor_hours, editable)}
    ${moneyField("budget-materials", "Materials", row.materials, editable)}
    ${moneyField("budget-sub", "Subcontractor", row.subcontractor, editable)}
    ${moneyField("budget-other", "Other", row.other, editable)}
    ${formRow("Total budgeted expense", `<output id="budget-total" class="budget-total">${formatBudgetMoney(total)}</output>`)}
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
  const total = budgetEntryTotal({
    labor: root.getElementById("budget-labor")?.value,
    materials: root.getElementById("budget-materials")?.value,
    subcontractor: root.getElementById("budget-sub")?.value,
    other: root.getElementById("budget-other")?.value,
  });
  const output = root.getElementById("budget-total");
  if (output) output.textContent = formatBudgetMoney(total);
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
