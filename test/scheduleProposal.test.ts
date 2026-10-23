import { describe, it, expect } from "vitest";
import { proposePlan } from "../src/domain/scheduleProposal.js";
const row = (id: string, start: string, end: string, deps: string[] = []) => ({
  id,
  title: id,
  window_start: start,
  window_end: end,
  status: "proposed",
  dependencies: deps.map((predecessor_id) => ({ predecessor_id, lag_days: 0 })),
});
describe("dependency proposals", () => {
  it("moves dependent work across weekends and leaves unrelated work alone", () => {
    const changes = proposePlan(
      [
        row("sub", "2026-09-15", "2026-09-16"),
        row("tech", "2026-09-17", "2026-09-18", ["sub"]),
        row("other", "2026-09-15", "2026-09-15"),
      ],
      "sub",
      "2026-09-18",
    );
    expect(changes.find((c) => c.id === "sub")!.after).toEqual({
      start: "2026-09-18",
      end: "2026-09-21",
    });
    expect(changes.find((c) => c.id === "tech")!.after).toEqual({
      start: "2026-09-22",
      end: "2026-09-23",
    });
    expect(changes.some((c) => c.id === "other")).toBe(false);
  });
  it("rejects completed work and cycles", () => {
    expect(() =>
      proposePlan(
        [{ ...row("a", "2026-09-15", "2026-09-15"), status: "complete" }],
        "a",
        "2026-09-18",
      ),
    ).toThrow();
    expect(() =>
      proposePlan(
        [
          row("a", "2026-09-15", "2026-09-15", ["b"]),
          row("b", "2026-09-15", "2026-09-15", ["a"]),
        ],
        "a",
        "2026-09-18",
      ),
    ).toThrow();
  });
});
