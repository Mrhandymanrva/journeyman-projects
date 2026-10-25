import { roundMoney } from "./poMath.js";
import { payablesAmountBand } from "./payablesWindow.js";

/**
 * Rank QuickBooks card charges for a material bill that is awaiting a charge.
 * This only suggests. Linking stays a separate action a person takes.
 * A charge is suggested when the amount is exact, or near (inside the same
 * amount band the lookup already uses) and the vendor matches or the date is
 * close. Vendor match ranks first, then exact amount ahead of near, then date.
 */

export const NEAR_DATE_DAYS = 21;

export type AmountMatch = "exact" | "near" | "none";

export interface CardCharge {
  id: string | null;
  txn_type: string;
  doc_number: string | null;
  total: number;
  balance: number | null;
  txn_date: string | null;
  vendor_name: string | null;
}

export interface BillToMatch {
  amount: number;
  invoiceDate: string | null;
  vendor: string | null;
}

export interface RankedCardCharge extends CardCharge {
  variance: number | null;
  amount_delta: number | null;
  amount_match: AmountMatch;
  vendor_match: boolean;
  day_delta: number | null;
  suggested: boolean;
}

const AMOUNT_RANK: Record<AmountMatch, number> = { exact: 0, near: 1, none: 2 };

export function vendorNamesMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = (left ?? "").trim().toLowerCase();
  const b = (right ?? "").trim().toLowerCase();
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

export function daysApart(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  if (!left || !right) return 365;
  const a = Date.parse(String(left).slice(0, 10));
  const b = Date.parse(String(right).slice(0, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 365;
  return Math.abs(a - b) / 86_400_000;
}

export function amountMatch(
  billAmount: number,
  chargeTotal: number,
): AmountMatch {
  const bill = roundMoney(billAmount);
  const charge = roundMoney(chargeTotal);
  if (Math.abs(roundMoney(charge - bill)) <= 0.005) return "exact";
  if (!(bill > 0)) return "none";
  const band = payablesAmountBand(bill);
  if (charge >= band.minAmount && charge <= band.maxAmount) return "near";
  return "none";
}

export function rankCardCharges(
  transactions: CardCharge[],
  bill: BillToMatch | null,
): { transactions: RankedCardCharge[]; suggestions: RankedCardCharge[] } {
  if (!bill) {
    const plain = transactions.map((txn) => ({
      ...txn,
      variance: null,
      amount_delta: null,
      amount_match: "none" as const,
      vendor_match: false,
      day_delta: null,
      suggested: false,
    }));
    return { transactions: plain, suggestions: [] };
  }

  const ranked = transactions.map((txn) => {
    const variance = roundMoney(Number(txn.total) - bill.amount);
    const amount_delta = Math.abs(variance);
    const amount_match = amountMatch(bill.amount, Number(txn.total));
    const vendor_match = vendorNamesMatch(bill.vendor, txn.vendor_name);
    const day_delta = daysApart(bill.invoiceDate, txn.txn_date);
    const suggested =
      txn.id != null &&
      txn.id !== "" &&
      (amount_match === "exact" ||
        (amount_match === "near" &&
          (vendor_match || day_delta <= NEAR_DATE_DAYS)));
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
    const amountRank =
      AMOUNT_RANK[a.amount_match] - AMOUNT_RANK[b.amount_match];
    if (amountRank !== 0) return amountRank;
    if (a.day_delta !== b.day_delta)
      return (a.day_delta ?? 0) - (b.day_delta ?? 0);
    if (a.amount_delta !== b.amount_delta)
      return (a.amount_delta ?? 0) - (b.amount_delta ?? 0);
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });

  return {
    transactions: ranked,
    suggestions: ranked.filter((txn) => txn.suggested),
  };
}
