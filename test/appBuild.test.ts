import { describe, expect, it } from "vitest";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import type { Database } from "../src/db/database.js";
import { clientBuildId, clientBuildIsCurrent } from "../src/http/buildId.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";

const down: Database = {
  withTenant: async () => {
    throw new Error("down");
  },
  withoutTenant: async () => {
    throw new Error("down");
  },
  tryAdvisoryLock: async () => null,
  close: async () => {},
};

describe("console build id", () => {
  it("stamps /health and the page with the same id and does not touch the database", async () => {
    const request = supertest(
      createApp({ database: down, staffSessions: new MemoryStaffSessions(), serveConsole: true }),
    );
    const health = await request.get("/health");
    expect(health.status).toBe(200);
    expect(health.headers["cache-control"]).toBe("no-store");
    expect(health.body).toEqual({ data: { status: "ok", build_id: clientBuildId() } });
    const page = await request.get("/");
    expect(page.status).toBe(200);
    expect(page.text).toContain(`<meta name="app-build" content="${clientBuildId()}">`);
    const script = await request.get("/console.js");
    expect(script.text).toContain("New version available, reload");
    expect(script.text).toContain('meta[name="app-build"]');
    expect(script.text).toContain('fetch("/health"');
  });

  it("treats a different loaded id as stale", () => {
    const id = clientBuildId();
    expect(clientBuildIsCurrent(id, id)).toBe(true);
    expect(clientBuildIsCurrent("older-tab", id)).toBe(false);
    expect(clientBuildIsCurrent("", id)).toBe(false);
    expect(clientBuildIsCurrent(id, "")).toBe(false);
  });
});
