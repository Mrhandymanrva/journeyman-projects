/**
 * Project financials summary. A missing ServiceTitan figure is a dash.
 * Nothing on this card is estimated, and nothing is written to ServiceTitan.
 */

const TIP = "ServiceTitan did not return this figure. Nothing is estimated.";

function dash() {
  return `<span class="fin-dash" title="${TIP}">\u2014</span>`;
}

function money(value) {
  if (value == null || !Number.isFinite(Number(value))) return dash();
  return Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function percent(value) {
  if (value == null || !Number.isFinite(Number(value))) return dash();
  return (
    Number(value).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + "%"
  );
}

function hours(value) {
  if (value == null || !Number.isFinite(Number(value))) return dash();
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function show(figure, kind) {
  const value = figure && figure.value != null ? figure.value : null;
  if (kind === "percent") return percent(value);
  if (kind === "hours") return hours(value);
  return money(value);
}

function pair(leftLabel, left, leftKind, rightLabel, right, rightKind) {
  return `<article class="fin-tile"><div class="fin-pair">
    <div><h3>${leftLabel}</h3><div class="fin-figure">${show(left, leftKind)}</div></div>
    <div><h3>${rightLabel}</h3><div class="fin-figure">${show(right, rightKind)}</div></div>
  </div></article>`;
}

function single(label, figure, kind) {
  return `<article class="fin-tile"><h3>${label}</h3><div class="fin-figure">${show(figure, kind)}</div></article>`;
}

function barRow(label, actual, budget, color) {
  const actualValue = actual?.value;
  const budgetValue = budget?.value;
  const max = Math.max(
    Number.isFinite(actualValue) ? actualValue : 0,
    Number.isFinite(budgetValue) ? budgetValue : 0,
    1,
  );
  const actualWidth = Number.isFinite(actualValue) ? Math.max(0, (actualValue / max) * 100) : 0;
  const budgetWidth = Number.isFinite(budgetValue) ? Math.max(0, (budgetValue / max) * 100) : 0;
  return `<div class="fin-bar-row">
    <span>${label}</span>
    <div class="fin-bar-track">
      ${budgetValue != null ? `<div class="fin-bar-budget" style="width:${budgetWidth.toFixed(2)}%"></div>` : ""}
      <div class="fin-bar-fill" style="width:${actualWidth.toFixed(2)}%;background:${color}"></div>
    </div>
    <strong>${money(actualValue ?? null)}</strong>
  </div>`;
}

function expenseChart(dashboard) {
  return `<div class="fin-bars" aria-hidden="true">
    ${barRow("Materials", dashboard.materialsExpense, dashboard.budgetedMaterials, "var(--accent)")}
    ${barRow("Labor", dashboard.laborExpense, dashboard.budgetedLaborExpense, "var(--status-done)")}
  </div>`;
}

function donut(value) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const portion =
    value == null || !Number.isFinite(Number(value))
      ? 0
      : Math.max(0, Math.min(100, Number(value))) / 100;
  const drawn = portion * circumference;
  return `<svg class="fin-donut" viewBox="0 0 48 48" width="84" height="84" aria-hidden="true">
    <circle cx="24" cy="24" r="${radius}" fill="none" stroke="var(--track)" stroke-width="6"></circle>
    <circle cx="24" cy="24" r="${radius}" fill="none" stroke="var(--status-track)" stroke-width="6"
      stroke-dasharray="${drawn.toFixed(2)} ${(circumference - drawn).toFixed(2)}"
      transform="rotate(-90 24 24)"></circle>
  </svg>`;
}

function marginTable(dashboard) {
  const rows = [
    ["Actual revenue", show(dashboard.actualRevenue, "money")],
    ["Billed", show(dashboard.billed, "money")],
    ["Expense", show(dashboard.actualExpense, "money")],
    ["Margin", show(dashboard.actualMargin, "money")],
    ["Margin % to date", show(dashboard.actualMarginPercent, "percent")],
  ];
  return `<table><tbody>${rows
    .map(([label, value]) => `<tr><th scope="row">${label}</th><td>${value}</td></tr>`)
    .join("")}</tbody></table>`;
}

function stacked(dashboard) {
  const parts = [
    ["Actual billed", dashboard.billed, "var(--bar-confirmed)"],
    ["Retainage", dashboard.retainage, "var(--bar-progress)"],
    ["Contract value", dashboard.contractValue, "var(--bar-planned)"],
    ["Earned revenue", dashboard.earnedRevenue, "var(--status-track)"],
  ];
  const present = parts
    .map((part) => part[1]?.value)
    .filter((value) => value != null && Number.isFinite(value) && value > 0);
  const scale = present.reduce((sum, value) => sum + value, 0) || 1;
  const segments = parts
    .filter((part) => part[1]?.value != null && part[1].value > 0)
    .map(
      ([, figure, color]) =>
        `<div style="width:${((figure.value / scale) * 100).toFixed(2)}%;background:${color}"></div>`,
    )
    .join("");
  const legend = parts
    .map(
      ([label, figure, color]) =>
        `<li><i style="background:${color}"></i><span>${label}</span><strong>${money(figure?.value ?? null)}</strong></li>`,
    )
    .join("");
  return `<div class="fin-stack" aria-hidden="true"><div class="fin-stack-bar">${segments}</div><ul>${legend}</ul></div>`;
}

const empty = { value: null, source: "missing" };

export function financialsDashboardHtml(dashboard) {
  const d = dashboard || {};
  const figure = (key) => d[key] || empty;
  const contract = figure("contractValue");
  const revenue = figure("actualRevenue");
  const budget = figure("totalBudgetedExpense");
  const remaining = figure("costToComplete");
  const changes = figure("changeOrders");
  const adjustments = figure("costAdjustments");
  const expense = figure("actualExpense");
  const model = {
    materialsExpense: figure("materialsExpense"),
    laborExpense: figure("laborExpense"),
    budgetedMaterials: figure("budgetedMaterials"),
    budgetedLaborExpense: figure("budgetedLaborExpense"),
    actualRevenue: revenue,
    billed: figure("billed"),
    actualExpense: expense,
    actualMargin: figure("actualMargin"),
    actualMarginPercent: figure("actualMarginPercent"),
    retainage: figure("retainage"),
    contractValue: contract,
    earnedRevenue: figure("earnedRevenue"),
  };
  return `<h2 class="fin-summary-title">Project financials</h2>
    ${pair("Contract value", contract, "money", "Actual revenue", revenue, "money")}
    ${pair("Total budgeted expense", budget, "money", "Cost to complete", remaining, "money")}
    ${pair("Change orders", changes, "money", "Cost adjustments", adjustments, "money")}
    <article class="fin-tile wide"><h3>Actual expense</h3><div class="fin-figure">${show(expense, "money")}</div>${expenseChart(model)}</article>
    <article class="fin-tile wide"><h3>Actual margin</h3><div class="fin-margin">${donut(model.actualMarginPercent.value)}<div><div class="fin-figure">${show(model.actualMarginPercent, "percent")}</div>${marginTable(model)}</div></div></article>
    ${pair("Budgeted margin", figure("budgetedMargin"), "money", "Budgeted margin %", figure("budgetedMarginPercent"), "percent")}
    <article class="fin-tile wide"><div class="fin-pair">
      <div><h3>Earned revenue</h3><div class="fin-figure">${show(model.earnedRevenue, "money")}</div></div>
      <div><h3>% of work completed</h3><div class="fin-figure">${show(figure("percentOfWorkCompleted"), "percent")}</div></div>
    </div>${stacked(model)}</article>
    ${pair("Open invoices", figure("openInvoices"), "money", "Budgeted labor expense", figure("budgetedLaborExpense"), "money")}
    ${single("Budgeted labor hours", figure("budgetedLaborHours"), "hours")}`;
}
