function laborMoney(n) {
  return (
    "$" +
    Number(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function laborRefreshLine(data, stamp) {
  if (!data || !data.observed_at) return "Not refreshed yet.";
  const when = stamp(data.observed_at);
  if (data.source === "scheduled") return `Last refreshed ${when} (overnight)`;
  if (data.source === "auto-hourly") return `Last refreshed ${when} (earlier automatic run)`;
  if (data.source === "manual") return `Last refreshed ${when} (manual)`;
  return `Last refreshed ${when}`;
}

/**
 * Labor card on a project page (Financials).
 * Hours, wage, and burden stay. Missing-rate strings and rate-gap lists do not.
 * The API still returns `missing` and `rate_gaps`; this view ignores them.
 */
export function laborCardHtml(row, { esc, stamp }) {
  const data = row || {};
  if (data.labor_source === "billed_labor_25pct") {
    return `
    <p class="note">${esc(data.labor_label || "Labor at 25% of billed labor (no payroll data)")}. Hours stay the payroll hours already stored. Nothing here writes to ServiceTitan.</p>
    <div class="row"><div class="row-b">
      <div class="row-t">${Number(data.hours || 0).toLocaleString("en-US")} hours</div>
      <div class="row-m">${esc(data.commission_label || "Commission (25% of billed labor)")} ${laborMoney(data.labor_wage || 0)}</div>
      <div class="row-m">${esc(data.burden_label || "Labor burden")} ${laborMoney(data.labor_burden || 0)} · payroll job timesheets, arrived to done, times the burden rate</div>
      <div class="row-m">Total ${laborMoney(data.total || 0)}</div>
      <div class="row-m">${laborRefreshLine(data, stamp)}</div>
    </div></div>`;
  }
  const missingPayroll =
    data.labor_source === "none_recent_payroll_missing"
      ? `<p class="msg">${esc(
          data.labor_warning ||
            "This project's jobs were created within the last 60 days and ServiceTitan payroll returned no paid timesheet hours for them. Labor was not estimated at 25% of billed labor.",
        )}</p>`
      : "";
  const moneyLine =
    data.labor_wage === undefined
      ? ""
      : `<div class="row-m">Labor ${laborMoney(data.labor_wage)} · Labor burden ${laborMoney(
          data.labor_burden,
        )} · Total ${laborMoney(data.total)}</div>`;
  const techs = (data.technicians || [])
    .map((tech) => {
      const wage =
        tech.wage == null
          ? ""
          : `<div class="row-m">Labor ${laborMoney(tech.wage)} · ${
              tech.pay_basis === "hourly"
                ? "timesheet hours × hourly rate"
                : "billed labor × commission percent"
            }</div>`;
      const burden = tech.burden_unset
        ? ""
        : tech.burden == null
          ? ""
          : `<div class="row-m">Labor burden ${laborMoney(tech.burden)} · timesheet hours × burden rate</div>`;
      return `<div class="row"><div class="row-b"><div class="row-t">${esc(
        tech.technician_name || "Technician",
      )}</div><div class="row-m">${esc(tech.hours)} hours</div>${wage}${burden}</div></div>`;
    })
    .join("");
  const stCode = data.st_labor_code;
  const codeText = !stCode
    ? "Labor code: unavailable"
    : `Labor code: ${esc(stCode.code)} ${esc(stCode.name || "")}`;
  const uncoded = Number(data.uncoded_hours) > 0;
  const laborError = data.st_labor_code_error
    ? `<p class="msg" id="labor-st-error">${esc(data.st_labor_code_error)}</p>`
    : "";
  const uncodedNote =
    uncoded && !data.st_labor_code_error
      ? `<p class="msg">${Number(data.uncoded_hours).toLocaleString("en-US")} hours are not on the ServiceTitan labor code, so they are not in the budget.</p>`
      : "";
  return `
    <p class="note">Hours come from ServiceTitan payroll timesheets. Labor cost is billed labor times the technician's commission percent, plus labor burden. Labor burden is those timesheet hours times the technician's burden rate. An hourly technician's labor is the timesheet hours times their hourly rate. A zero hourly rate is not a missing rate when a commission percent is set. Nothing here writes to ServiceTitan.</p>
    ${
      data.rates_forbidden
        ? `<p class="msg">The latest ServiceTitan technician read was denied. Labor dollars already priced were left as they are.</p>`
        : ""
    }
    <div class="row"><div class="row-b"><div class="row-t">${Number(data.hours || 0).toLocaleString("en-US")} hours</div>
      ${moneyLine}
      <div class="row-m">${laborRefreshLine(data, stamp)}</div>
      <div class="row-m" id="labor-st-code">${codeText}</div></div></div>
    ${missingPayroll}
    ${laborError}
    ${uncodedNote}
    ${techs}`;
}
