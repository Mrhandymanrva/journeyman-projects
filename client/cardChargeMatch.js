/**
 * Keep this in step with src/domain/cardChargeMatch.ts.
 * Suggest only. The Link action is still what records a charge.
 */

export const NEAR_DATE_DAYS = 21;

const AMOUNT_RANK = { exact: 0, near: 1, none: 2 };

function roundMoney(value) {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 100 + 1e-8)) / 100;
}

function payablesAmountBand(amount) {
  return {
    minAmount: roundMoney(amount * 0.85),
    maxAmount: roundMoney(amount * 1.25),
  };
}

export function vendorNamesMatch(left, right) {
  const a = String(left ?? "").trim().toLowerCase();
  const b = String(right ?? "").trim().toLowerCase();
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

export function daysApart(left, right) {
  if (!left || !right) return 365;
  const a = Date.parse(String(left).slice(0, 10));
  const b = Date.parse(String(right).slice(0, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 365;
  return Math.abs(a - b) / 86400000;
}

export function amountMatch(billAmount, chargeTotal) {
  const bill = roundMoney(billAmount);
  const charge = roundMoney(chargeTotal);
  if (Math.abs(roundMoney(charge - bill)) <= 0.005) return "exact";
  if (!(bill > 0)) return "none";
  const band = payablesAmountBand(bill);
  if (charge >= band.minAmount && charge <= band.maxAmount) return "near";
  return "none";
}

export function rankCardCharges(transactions, bill) {
  const list = Array.isArray(transactions) ? transactions : [];
  if (!bill) {
    return {
      transactions: list.map((txn) => ({
        ...txn,
        variance: null,
        amount_delta: null,
        amount_match: "none",
        vendor_match: false,
        day_delta: null,
        suggested: false,
      })),
      suggestions: [],
    };
  }

  const ranked = list.map((txn) => {
    const variance = roundMoney(Number(txn.total) - Number(bill.amount));
    const amount_delta = Math.abs(variance);
    const amount_match = amountMatch(bill.amount, Number(txn.total));
    const vendor_match = vendorNamesMatch(bill.vendor, txn.vendor_name);
    const day_delta = daysApart(bill.invoiceDate, txn.txn_date);
    const suggested =
      txn.id != null &&
      txn.id !== "" &&
      (amount_match === "exact" ||
        (amount_match === "near" && (vendor_match || day_delta <= NEAR_DATE_DAYS)));
    return {
      ...txn,
      variance,
      amount_delta,
      amount_match,
      vendor_match,
      day_delta,
      suggested,
    };
  });

  ranked.sort((a, b) => {
    if (a.vendor_match !== b.vendor_match) return a.vendor_match ? -1 : 1;
    const amountRank = AMOUNT_RANK[a.amount_match] - AMOUNT_RANK[b.amount_match];
    if (amountRank !== 0) return amountRank;
    if (a.day_delta !== b.day_delta) return (a.day_delta ?? 0) - (b.day_delta ?? 0);
    if (a.amount_delta !== b.amount_delta) return (a.amount_delta ?? 0) - (b.amount_delta ?? 0);
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });

  return {
    transactions: ranked,
    suggestions: ranked.filter((txn) => txn.suggested),
  };
}
