import { roundMoney } from './poMath.js';

/** UTC calendar date, so the bridge window does not depend on the server's local midnight. */
export function utcToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addIsoDays(iso: string, days: number): string {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Prefer the bill's invoice date. A bill with no invoice date uses the received date. */
export function payablesAnchor(
  invoiceDate: string | null | undefined,
  receivedDate: string | null | undefined,
): string | null {
  for (const value of [invoiceDate, receivedDate]) {
    const day = value?.slice(0, 10);
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  }
  return null;
}

/**
 * from is ten days before the anchor. to is the earlier of today and from + 60 days.
 * A future invoice cannot produce a to that is before from.
 */
export function payablesWindow(anchor: string, today = utcToday()): { from: string; to: string } {
  const from = addIsoDays(anchor, -10);
  const cap = addIsoDays(from, 60);
  let to = cap < today ? cap : today;
  if (to < from) to = from;
  return { from, to };
}

/** Room under the order for a short charge, and room above it for tax and shipping. */
export function payablesAmountBand(amount: number): { minAmount: number; maxAmount: number } {
  return {
    minAmount: roundMoney(amount * 0.85),
    maxAmount: roundMoney(amount * 1.25),
  };
}
