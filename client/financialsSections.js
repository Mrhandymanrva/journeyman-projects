/**
 * Financials sections start collapsed. The summary dashboard stays open.
 * Nothing is remembered between visits.
 */

const whole = (n) =>
  "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const cents = (n) =>
  "$" +
  Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export function budgetSummary(cost) {
  const rows = Array.isArray(cost) ? cost : [];
  const total = rows.reduce((sum, row) => sum + Number(row?.baseline || 0), 0);
  const count = rows.length;
  return `${count} line${count === 1 ? "" : "s"} · ${whole(total)} budget`;
}

export function purchaseOrderSummary(orders) {
  const rows = Array.isArray(orders) ? orders : [];
  const total = rows.reduce((sum, row) => sum + Number(row?.amount || 0), 0);
  const count = rows.length;
  return `${count} purchase order${count === 1 ? "" : "s"} · ${whole(total)}`;
}

export function changeOrderSummary(data) {
  const rows = Array.isArray(data?.change_orders)
    ? data.change_orders
    : Array.isArray(data)
      ? data
      : [];
  const total = rows.reduce((sum, row) => sum + Number(row?.customer_amount || 0), 0);
  const count = rows.length;
  return `${count} change order${count === 1 ? "" : "s"} · ${whole(total)}`;
}

export function drawSummary(drawData) {
  const rows = Array.isArray(drawData?.draws) ? drawData.draws : [];
  const total = rows.reduce((sum, row) => sum + Number(row?.amount || 0), 0);
  const count = rows.length;
  return `${count} draw${count === 1 ? "" : "s"} · ${whole(total)}`;
}

export function laborSummary(row) {
  const hours = Number(row?.hours || 0);
  const dollars = row?.total != null ? Number(row.total) : Number(row?.labor_burden || 0);
  const hourText = hours.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${hourText} hours · ${cents(dollars)}`;
}

export function stDetailSummary(money) {
  if (!money || !money.observed_at) return "Not read yet";
  return `Billed ${cents(money.billed)} · Expenses ${cents(money.expenses)} · Margin ${cents(money.margin)}`;
}

export function billsSummary(bills) {
  const live = (Array.isArray(bills) ? bills : []).filter((bill) => bill.status !== "rejected");
  const total = live.reduce((sum, bill) => sum + Number(bill.amount || 0), 0);
  const count = live.length;
  return `${count} bill${count === 1 ? "" : "s"} · ${whole(total)}`;
}

export function reservesSummary(rows) {
  const live = (Array.isArray(rows) ? rows : []).filter((row) => row.active !== false);
  const allocated = live.reduce((sum, row) => sum + Number(row.data?.allocated || 0), 0);
  const drawn = live.reduce((sum, row) => sum + Number(row.data?.drawn || 0), 0);
  const count = live.length;
  return `${count} reserve${count === 1 ? "" : "s"} · ${whole(allocated)} allocated · ${whole(allocated - drawn)} remaining`;
}

export function collapsedCard({ id, title, summary, actions = "", body }) {
  return `<section class="card fin-section" data-fin-section="${id}">
    <div class="card-h">
      <button type="button" class="fin-section-toggle" aria-expanded="false" aria-controls="fin-body-${id}">
        <span class="fin-chevron" aria-hidden="true"></span>
        <span class="fin-section-title">${title}</span>
      </button>
      ${actions}
    </div>
    <p class="fin-section-summary">${summary}</p>
    <div class="card-b fin-section-body" id="fin-body-${id}" hidden>${body}</div>
  </section>`;
}

/** Click toggles. true and the string "true" both mean it is open. */
export function nextSectionExpanded(expanded) {
  return !(expanded === true || expanded === "true");
}

export function setSectionExpanded(button, expanded) {
  if (!button) return;
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  const bodyId = button.getAttribute("aria-controls");
  const body = bodyId ? document.getElementById(bodyId) : null;
  if (body) body.hidden = !expanded;
}

export function bindFinancialSections(root) {
  if (!root || root.dataset.finSectionsBound === "true") return;
  root.dataset.finSectionsBound = "true";
  root.addEventListener("click", (event) => {
    const button = event.target?.closest?.(".fin-section-toggle");
    if (!button || !root.contains(button)) return;
    const expanded = button.getAttribute("aria-expanded") === "true";
    setSectionExpanded(button, nextSectionExpanded(expanded));
  });
}
