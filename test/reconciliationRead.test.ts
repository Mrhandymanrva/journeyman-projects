import { describe, it, expect, vi } from "vitest";
import {
  parseReconciliationSnapshot,
  ReconciliationReadAdapter,
} from "../src/adapters/reconciliation.js";
import { readSourceConnections } from "../src/adapters/sourceConnections.js";
const record = {
  id: "QB:1",
  source: "qbo",
  vendor: "Supply",
  amount: -123,
  date: "2026-09-15",
};
const state = {
  revision: 3,
  mode: "live",
  lastSync: null,
  records: [record],
  quickbooks: { secret: "must disappear" },
  audit: [{ sensitive: true }],
};
describe("reconciliation boundary", () => {
  it("preserves signed integer cents and strips private configuration", () => {
    const parsed = parseReconciliationSnapshot(state);
    expect(parsed.records[0]!.amount).toBe(-123);
    expect(parsed).not.toHaveProperty("quickbooks");
    expect(parsed).not.toHaveProperty("audit");
  });
  it("rejects duplicate IDs, fractional amounts, demo feeds and invalid dates", () => {
    for (const input of [
      { ...state, records: [record, record] },
      { ...state, records: [{ ...record, amount: 1.23 }] },
      { ...state, mode: "demo" },
      { ...state, records: [{ ...record, date: "2026-02-30" }] },
    ])
      expect(() => parseReconciliationSnapshot(input)).toThrow();
  });
  it("uses only the configured HTTPS GET and rejects redirects", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(state)));
    const client = new ReconciliationReadAdapter(
      {
        origin: "https://purchase.example",
        username: "user",
        password: "secret",
      },
      fetcher,
    );
    await client.read();
    expect(fetcher.mock.calls[0]).toMatchObject([
      "https://purchase.example/api/state",
      { method: "GET", redirect: "error" },
    ]);
    expect(
      () =>
        new ReconciliationReadAdapter({
          origin: "http://purchase.example",
          username: "u",
          password: "p",
        }),
    ).toThrow();
  });
  it("sanitizes source failures", async () => {
    const client = new ReconciliationReadAdapter(
      { origin: "https://purchase.example", username: "u", password: "p" },
      async () => {
        throw new Error("secret token");
      },
    );
    await expect(client.read()).rejects.toThrow("Previous snapshot retained");
  });
  it("requires explicit tenant bindings and does not activate from ST secrets alone", () => {
    expect(readSourceConnections({ ST_CLIENT_SECRET: "secret" })).toEqual({});
    expect(() =>
      readSourceConnections({ PM_ST_TENANT_ID: "not-uuid" }),
    ).toThrow();
  });
});
