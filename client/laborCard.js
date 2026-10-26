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
  if (data.source === "scheduled") return `Last refreshed ${when} (scheduled)`;
  if (data.source === "auto-hourly") return `Last refreshed ${when} (automatic)`;
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
  const moneyLine =
    data.labor_wage === undefined
      ? ""
      : `<div class="row-m">Wage ${laborMoney(data.labor_wage)} · Burden ${laborMoney(
          data.labor_burden,
        )} · Total ${laborMoney(data.total)}</div>`;
  const techs = (data.technicians || [])
    .map((tech) => {
      const wage =
        tech.wage == null
          ? ""
          : `<div class="row-m">Wage ${laborMoney(tech.wage)} · ${laborMoney(
              tech.hourly_rate,
            )}/hr × ${esc(tech.hours)} h · ServiceTitan technician hourlyRate</div>`;
      const burden =
        tech.burden == null
          ? ""
          : `<div class="row-m">Burden ${laborMoney(tech.burden)} · ${laborMoney(
              tech.burden_rate,
            )}/hr × ${esc(tech.hours)} h · ServiceTitan technician burdenRate</div>`;
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
    <p class="note">Hours come from ServiceTitan timesheets. Wage is hours times that technician's ServiceTitan hourly rate. Burden is the same hours times that technician's burden rate, added on top. If payroll is not permitted, appointment windows are used and the last timesheet rows stay. Nothing here writes to ServiceTitan.</p>
    ${
      data.rates_forbidden
        ? `<p class="msg">The latest ServiceTitan technician read was denied. Rates from the last successful read are still used. A technician with no saved rate stays out of actual cost.</p>`
        : ""
    }
    <div class="row"><div class="row-b"><div class="row-t">${Number(data.hours || 0).toLocaleString("en-US")} hours</div>
      ${moneyLine}
      <div class="row-m">${laborRefreshLine(data, stamp)}</div>
      <div class="row-m" id="labor-st-code">${codeText}</div></div></div>
    ${laborError}
    ${uncodedNote}
    ${techs}`;
}
