import { describe, expect, it, vi } from "vitest";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import type { Database } from "../src/db/database.js";
import { startLaborRefreshSchedulerIfEnabled } from "../src/workers/laborRefresh.js";

const PAUSED =
  "Overnight ServiceTitan refresh paused (set JP_OVERNIGHT_REFRESH=on to enable).";

const serviceTitan = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  externalSystemId: "11111111-1111-4111-8111-111111111111",
  key: "st:test",
  client: {
    readJobTimesheets: async () => ({
      jobId: "1",
      forbidden: false,
      timesheets: [],
    }),
  },
} as unknown as NonNullable<SourceConnections["serviceTitan"]>;

describe("overnight ServiceTitan refresh boot", () => {
  it("does not start the scheduler unless JP_OVERNIGHT_REFRESH is on", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((message) => {
      lines.push(String(message));
    });
    const delays: number[] = [];
    let reads = 0;
    const db = {
      withTenant: async (
        _tenantId: string,
        run: (client: {
          query: () => Promise<{ rows: [] }>;
        }) => Promise<unknown>,
      ) => {
        reads += 1;
        return run({ query: async () => ({ rows: [] }) });
      },
    } as unknown as Database;
    const now = new Date("2026-01-15T06:59:00.000Z");
    const options = {
      env: {},
      now: () => now,
      schedule: (_run: () => void, delayMs: number) => {
        delays.push(delayMs);
        return { cancel() {} };
      },
    };

    try {
      const paused = startLaborRefreshSchedulerIfEnabled(
        db,
        { serviceTitan },
        {},
        options,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(paused).toBeUndefined();
      expect(reads).toBe(0);
      expect(delays).toEqual([]);
      expect(lines).toEqual([PAUSED]);

      lines.length = 0;
      const started = startLaborRefreshSchedulerIfEnabled(
        db,
        { serviceTitan },
        { JP_OVERNIGHT_REFRESH: "on" },
        options,
      );
      expect(started).toBeDefined();
      await vi.waitFor(() => {
        expect(delays).toEqual([60_000]);
      });
      expect(reads).toBeGreaterThan(0);
      expect(lines).not.toContain(PAUSED);
      started?.cancel();
    } finally {
      log.mockRestore();
    }
  });
});
