import { describe, expect, it } from "vitest";
import { rankCardCharges as serverRank } from "../src/domain/cardChargeMatch.js";
// The console copy is plain JavaScript. This test checks it against the server.
// @ts-expect-error no declaration file for the browser module
import { rankCardCharges as clientRank } from "../client/cardChargeMatch.js";

const bill = { amount: 100, invoiceDate: "2026-10-01", vendor: "Home Depot" };

function charge(
  id: string,
  total: number,
  vendor: string | null,
  date: string | null,
) {
  return {
    id,
    txn_type: "Purchase",
    doc_number: id.toUpperCase(),
    total,
    balance: 0,
    txn_date: date,
    vendor_name: vendor,
  };
}

const charges = [
  charge("near-close", 110, "Home Depot", "2026-10-02"),
  charge("exact-old", 100, "Home Depot", "2026-09-01"),
  charge("exact-other", 100, "Other Store", "2026-10-01"),
  charge("near-stranger", 112, "Unrelated", "2026-10-04"),
  charge("near-stale", 112, "Unrelated", "2026-08-01"),
  charge("wild", 900, "Unrelated", "2025-01-01"),
  { ...charge("no-id", 100, "Home Depot", "2026-10-01"), id: null },
];

describe("card charge scoring", () => {
  it("ranks vendor match, then exact amount, then near amount, then date", () => {
    const ranked = serverRank(charges, bill);
    expect(ranked.transactions.map((txn) => txn.id)).toEqual([
      null,
      "exact-old",
      "near-close",
      "exact-other",
      "near-stranger",
      "near-stale",
      "wild",
    ]);
    expect(ranked.transactions.find((txn) => txn.id == null)).toMatchObject({
      vendor_match: true,
      amount_match: "exact",
      suggested: false,
    });
    expect(
      ranked.transactions.find((txn) => txn.id === "exact-old"),
    ).toMatchObject({
      amount_match: "exact",
      vendor_match: true,
      suggested: true,
      variance: 0,
    });
    expect(
      ranked.transactions.find((txn) => txn.id === "near-close"),
    ).toMatchObject({
      amount_match: "near",
      vendor_match: true,
      suggested: true,
    });
    expect(ranked.suggestions.map((txn) => txn.id)).toEqual([
      "exact-old",
      "near-close",
      "exact-other",
      "near-stranger",
    ]);
  });

  it("returns no suggestions when nothing is a likely charge", () => {
    expect(serverRank([], bill)).toEqual({ transactions: [], suggestions: [] });
    const none = serverRank(
      [
        charge("wild", 900, "Unrelated", "2025-01-01"),
        charge("stale", 112, "Unrelated", "2026-08-01"),
      ],
      bill,
    );
    expect(none.suggestions).toEqual([]);
    expect(none.transactions.every((txn) => txn.suggested === false)).toBe(
      true,
    );
  });

  it("does not suggest when there is no bill to match", () => {
    const ranked = serverRank(
      [charge("exact-old", 100, "Home Depot", "2026-10-01")],
      null,
    );
    expect(ranked.suggestions).toEqual([]);
    expect(ranked.transactions[0]?.suggested).toBe(false);
  });

  it("uses the same ranking in the console and the API", () => {
    expect(clientRank(charges, bill)).toEqual(serverRank(charges, bill));
    expect(clientRank([], bill)).toEqual(serverRank([], bill));
    expect(clientRank(charges, null)).toEqual(serverRank(charges, null));
  });
});
