import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatDailyLogStamp, todayInNewYork } from "../client/dailyLog.js";

describe("daily log times in America/New_York", () => {
  it("lists two entries on the same calendar day with different times and authors", () => {
    const morning = formatDailyLogStamp({
      log_date: "2026-11-10",
      created_at: "2026-11-10T14:14:00.000Z",
    });
    const afternoon = formatDailyLogStamp({
      log_date: "2026-11-10",
      created_at: "2026-11-10T19:14:00.000Z",
    });
    expect(morning).toBe("Nov 10, 2026 · 9:14 AM ET");
    expect(afternoon).toBe("Nov 10, 2026 · 2:14 PM ET");
    expect(morning).not.toBe(afternoon);
  });

  it("keeps the log date when the entry was written on another Eastern day", () => {
    expect(
      formatDailyLogStamp({
        log_date: "2026-11-10",
        created_at: "2026-11-10T03:30:00.000Z",
      }),
    ).toBe("Nov 10, 2026 · written Nov 9, 2026 · 10:30 PM ET");
  });

  it("defaults a new log to today's date in New York, not UTC", () => {
    expect(todayInNewYork(new Date("2026-11-11T03:30:00.000Z"))).toBe("2026-11-10");
  });

  it("does not tell the writer there is only one log per date", () => {
    const consoleSource = readFileSync("client/console.js", "utf8");
    expect(consoleSource).not.toContain("One per project per date");
    expect(consoleSource).toContain("formatDailyLogStamp");
    expect(consoleSource).toContain("todayInNewYork");
    expect(consoleSource).toContain(
      'el("log-new").addEventListener("click", () => dailyLogDrawer());',
    );
  });
});
