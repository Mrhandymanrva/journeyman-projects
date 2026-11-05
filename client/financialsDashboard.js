/**
 * Project financials summary. Budget tiles come from the Journeyman budget.
 * A missing ServiceTitan figure is a dash. Nothing on this card is estimated,
 * and nothing is written to ServiceTitan.
 */

const TIPS = {
  budget: "No budget entered for this figure.",
  computed: "This figure stays blank until every number it uses has been entered.",
  servicetitan: "ServiceTitan did not return this figure. Nothing is estimated.",
};

function dash(gap) {
  const tip = TIPS[gap] || TIPS.servicetitan;
  return `<span class="fin-dash" title="${tip}">\u2014</span>`;
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
  const tip = figure && figure.tip ? ` title="${escHtml(figure.tip)}"` : "";
  if (kind === "percent" && figure && figure.note) {
    return `<span class="fin-over-budget fin-tip"${tip}>${escHtml(figure.note)}</span>`;
  }
  const value = figure && figure.value != null ? figure.value : null;
  if (value == null) return dash(figure && figure.gap);
  const rendered = kind === "percent" ? percent(value) : kind === "hours" ? hours(value) : money(value);
  return tip ? `<span class="fin-tip"${tip}>${rendered}</span>` : rendered;
}

function escHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function barRow(label, actual, budget, color, committed) {
  const actualValue = actual?.value;
  const budgetValue = budget?.value;
  const committedValue = committed == null ? null : Number(committed);
  const actualN = Number.isFinite(actualValue) ? Math.max(0, actualValue) : 0;
  const budgetN = Number.isFinite(budgetValue) ? Math.max(0, budgetValue) : 0;
  const committedN = committedValue != null && Number.isFinite(committedValue) ? Math.max(0, committedValue) : 0;
  const max = Math.max(actualN + committedN, budgetN, 1);
  const actualWidth = (actualN / max) * 100;
  const budgetWidth = Number.isFinite(budgetValue) ? Math.max(0, (budgetN / max) * 100) : 0;
  const committedWidth = (committedN / max) * 100;
  const amount =
    committedValue == null
      ? money(actualValue ?? null)
      : `${money(actualValue ?? null)}<span class="fin-bar-committed-amt">committed ${money(committedValue)}</span>`;
  return `<div class="fin-bar-row">
    <span>${label}</span>
    <div class="fin-bar-track">
      ${budgetValue != null ? `<div class="fin-bar-budget" style="width:${budgetWidth.toFixed(2)}%"></div>` : ""}
      <div class="fin-bar-fill" style="width:${actualWidth.toFixed(2)}%;background:${color}"></div>
      ${
        committedValue == null
          ? ""
          : `<div class="fin-bar-committed" style="left:${actualWidth.toFixed(2)}%;width:${committedWidth.toFixed(2)}%"></div>`
      }
    </div>
    <strong>${amount}</strong>
  </div>`;
}

function expenseChart(dashboard) {
  const committed = dashboard.committedLabor ? dashboard.committedLabor.cost : null;
  const legend = dashboard.committedLabor
    ? `<p class="fin-bar-legend"><i class="fin-swatch-budget"></i><span>Budget</span><i class="fin-swatch-actual"></i><span>Actual labor expense</span><i class="fin-swatch-committed"></i><span>Committed labor</span></p>`
    : "";
  return `<div class="fin-bars">
    ${barRow("Materials", dashboard.materialsExpense, dashboard.budgetedMaterials, "var(--accent)")}
    ${barRow("Subcontractor", dashboard.subcontractorExpense, dashboard.budgetedSubcontractor, "var(--bar-progress)")}
    ${barRow("Labor", dashboard.laborExpense, dashboard.budgetedLaborExpense, "var(--status-done)", committed)}
    ${legend}
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

function subtractMoney(budget, actual, committed) {
  if (budget == null || !Number.isFinite(Number(budget))) return null;
  return Math.round((Number(budget) - Number(actual || 0) - Number(committed || 0)) * 100) / 100;
}

function laborCommitment(dashboard) {
  const committed = dashboard.committedLabor;
  if (!committed) return "";
  const budgetMoney = dashboard.budgetedLaborExpense || empty;
  const budgetHours = dashboard.budgetedLaborHours || empty;
  const actualMoney = { value: committed.actualCost, source: "actuals" };
  const actualHours = { value: committed.actualHours, source: "actuals" };
  const committedMoney = { value: committed.cost, source: "computed" };
  const committedHours = { value: committed.hours, source: "computed" };
  const remainingMoney = {
    value: subtractMoney(budgetMoney.value, committed.actualCost, committed.cost),
    source: budgetMoney.value == null ? "missing" : "computed",
    gap: budgetMoney.value == null ? budgetMoney.gap || "budget" : undefined,
  };
  const remainingHours = {
    value: subtractMoney(budgetHours.value, committed.actualHours, committed.hours),
    source: budgetHours.value == null ? "missing" : "computed",
    gap: budgetHours.value == null ? budgetHours.gap || "budget" : undefined,
  };
  const jobs = Array.isArray(committed.jobs) ? committed.jobs : [];
  const rows = jobs
    .map((job) => {
      const dates =
        job.startsOn && job.endsOn && job.startsOn !== job.endsOn
          ? `${escHtml(job.startsOn)} – ${escHtml(job.endsOn)}`
          : escHtml(job.startsOn || job.endsOn || "—");
      const revenue =
        job.revenueSource === "estimated"
          ? `${money(job.revenue)} <span class="fin-flag">estimated</span>`
          : money(job.revenue);
      const flags = (job.flags || []).map((flag) => `<span class="fin-flag">${escHtml(flag)}</span>`).join(" ");
      return `<tr>
        <td>${escHtml(job.jobNumber || job.jobId)}</td>
        <td>${dates}</td>
        <td class="num">${hours(job.hours)}</td>
        <td>${escHtml((job.technicians || []).join(", ") || "—")}</td>
        <td class="num">${revenue}</td>
        <td class="num">${money(job.cost)}</td>
        <td>${flags || "—"}</td>
      </tr>`;
    })
    .join("");
  const method = escHtml(committed.method || "");
  const summary =
    jobs.length === 0
      ? "No committed jobs"
      : `${jobs.length} job${jobs.length === 1 ? "" : "s"} · ${hours(committed.hours)} hours · ${money(committed.cost)}`;
  return `<article class="fin-tile wide" id="labor-commitment">
    <h3>Labor commitment <span class="fin-dash" title="${method}">how this is counted</span></h3>
    <div class="fin-commit">
      <span></span><span>Budget</span><span>Committed</span><span>Actual</span><span>Remaining</span>
      <span>Dollars</span>
      <strong>${show(budgetMoney, "money")}</strong>
      <strong id="committed-cost-panel" title="${method}">${show(committedMoney, "money")}</strong>
      <strong>${show(actualMoney, "money")}</strong>
      <strong>${show(remainingMoney, "money")}</strong>
      <span>Hours</span>
      <strong>${show(budgetHours, "hours")}</strong>
      <strong>${show(committedHours, "hours")}</strong>
      <strong>${show(actualHours, "hours")}</strong>
      <strong>${show(remainingHours, "hours")}</strong>
    </div>
    <p class="fin-commit-method" title="${method}">${method}</p>
    <details class="fin-committed-jobs">
      <summary>${summary}</summary>
      ${
        rows
          ? `<table><thead><tr><th>Job</th><th>Dates</th><th>Hours</th><th>Techs</th><th>Revenue</th><th>Cost</th><th>Flags</th></tr></thead><tbody>${rows}</tbody></table>`
          : `<p class="note">No scheduled or in-progress jobs are waiting to be invoiced.</p>`
      }
    </details>
  </article>`;
}

function committedSummary(dashboard) {
  if (!dashboard.committedLabor || !dashboard.committedCost) return "";
  const projected = dashboard.projectedCost || { value: null, source: "missing", gap: "computed" };
  return `<article class="fin-tile"><div class="fin-pair">
    <div><h3>Committed cost</h3><div class="fin-figure" id="committed-cost-tile">${show(dashboard.committedCost, "money")}</div></div>
    <div><h3>Projected cost</h3><div class="fin-figure" id="projected-cost-tile">${show(projected, "money")}</div></div>
  </div></article>`;
}

function actualExpenseCard(dashboard) {
  const expense = dashboard.actualExpense || empty;
  const chart = expenseChart(dashboard);
  if (!dashboard.committedLabor || !dashboard.committedCost) {
    return `<article class="fin-tile wide"><h3>Actual expense</h3><div class="fin-figure">${show(expense, "money")}</div>${chart}</article>`;
  }
  const projected = dashboard.projectedCost || { value: null, source: "missing", gap: "computed" };
  return `<article class="fin-tile wide" id="actual-expense"><h3>Actual expense</h3>
    <div class="fin-expense-head">
      <div><h3>Actual</h3><div class="fin-figure" id="actual-expense-actual">${show(expense, "money")}</div></div>
      <div><h3>Committed</h3><div class="fin-figure" id="committed-cost-headline">${show(dashboard.committedCost, "money")}</div></div>
      <div><h3>Actual + committed</h3><div class="fin-figure" id="projected-cost">${show(projected, "money")}</div></div>
    </div>
    ${chart}</article>`;
}

function soldReference(sold) {
  if (!sold) return "";
  const parts = [];
  if (sold.contractValue != null) parts.push(`contract ${money(sold.contractValue)}`);
  if (sold.totalBudgetedExpense != null) parts.push(`budgeted expense ${money(sold.totalBudgetedExpense)}`);
  if (sold.budgetedLaborExpense != null) parts.push(`labor ${money(sold.budgetedLaborExpense)}`);
  if (sold.budgetedLaborHours != null) parts.push(`${hours(sold.budgetedLaborHours)} labor hours`);
  if (sold.budgetedMaterials != null) parts.push(`materials ${money(sold.budgetedMaterials)}`);
  if (parts.length === 0) return "";
  return `<p class="fin-sold-ref">ServiceTitan sold estimate, read only: ${parts.join(" · ")}</p>`;
}

export function financialsDashboardHtml(dashboard) {
  const d = dashboard || {};
  const figure = (key) => d[key] || empty;
  const emptyState = d.budgetEntered
    ? ""
    : `<p class="fin-empty">No budget entered \u2014 <button type="button" class="btn sm" id="enter-budget">Enter budget</button></p>`;
  const contract = figure("contractValue");
  const revenue = figure("actualRevenue");
  const budget = figure("totalBudgetedExpense");
  const remaining = figure("costToComplete");
  const changes = figure("changeOrders");
  const adjustments = figure("costAdjustments");
  const expense = figure("actualExpense");
  const model = {
    materialsExpense: figure("materialsExpense"),
    subcontractorExpense: figure("subcontractorExpense"),
    laborExpense: figure("laborExpense"),
    budgetedMaterials: figure("budgetedMaterials"),
    budgetedSubcontractor: figure("budgetedSubcontractor"),
    budgetedLaborExpense: figure("budgetedLaborExpense"),
    actualRevenue: revenue,
    billed: figure("billed"),
    actualExpense: expense,
    actualMargin: figure("actualMargin"),
    actualMarginPercent: figure("actualMarginPercent"),
    retainage: figure("retainage"),
    contractValue: contract,
    earnedRevenue: figure("earnedRevenue"),
    committedLabor: d.committedLabor || null,
  };
  return `<h2 class="fin-summary-title">Project financials</h2>
    ${emptyState}
    ${soldReference(d.soldEstimate)}
    ${pair("Contract value", contract, "money", "Actual revenue", revenue, "money")}
    ${pair("Total budgeted expense", budget, "money", "Cost to complete", remaining, "money")}
    ${pair("Change orders", changes, "money", "Cost adjustments", adjustments, "money")}
    ${committedSummary(d)}
    ${actualExpenseCard(d)}
    <article class="fin-tile wide"><h3>Actual margin</h3><div class="fin-margin">${donut(model.actualMarginPercent.value)}<div><div class="fin-figure">${show(model.actualMarginPercent, "percent")}</div>${marginTable(model)}</div></div></article>
    ${pair("Budgeted margin", figure("budgetedMargin"), "money", "Budgeted margin %", figure("budgetedMarginPercent"), "percent")}
    <article class="fin-tile wide"><div class="fin-pair">
      <div><h3>Earned revenue</h3><div class="fin-figure">${show(model.earnedRevenue, "money")}</div></div>
      <div><h3>% of work completed</h3><div class="fin-figure">${show(figure("percentOfWorkCompleted"), "percent")}</div></div>
    </div>${stacked(model)}</article>
    ${pair("Open invoices", figure("openInvoices"), "money", "Budgeted labor expense", figure("budgetedLaborExpense"), "money")}
    ${single("Budgeted labor hours", figure("budgetedLaborHours"), "hours")}
    ${laborCommitment(d)}`;
}
