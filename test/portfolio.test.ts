import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import { portfolioFeedConfig } from "../src/adapters/portfolioFeed.js";
import { createTenant, SCHEMA_FILES, startHarness, type Harness, type TenantFixture } from "./support/harness.js";

/**
 * The portfolio feed is the one read-only door for a tenant's own dashboard.
 * It must open only with the configured token, only onto the configured
 * tenant, and not exist at all when nothing is configured.
 */
let h: Harness;
let mine: TenantFixture;
let theirs: TenantFixture;
const TOKEN = "portfolio-feed-token-for-tests-0001";

beforeAll(async () => {
  h = await startHarness(SCHEMA_FILES);
  mine = await createTenant(h, { slug: "portfolio-mine", displayName: "Mine Co" });
  theirs = await createTenant(h, { slug: "portfolio-theirs", displayName: "Theirs Co" });
  for (const [t, number] of [[mine, "P-100"], [theirs, "P-900"]] as const) {
    const res = await h.as(t.staff.owner!.token).post("/api/v1/projects/projects").send({
      project_number: number, name: `Project ${number}`, source_kind: "manual",
      address_line1: "1 Main St", city: "Richmond", region: "VA",
      contract_value: 50_000, target_margin: 0.35,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
});

afterAll(async () => {
  await h?.close();
});

function feedApp(config = { tenantId: mine.id, token: TOKEN }) {
  return supertest(createApp({ database: h.db, staffSessions: new MemoryStaffSessions(), serveConsole: false, portfolio: config }));
}

describe("portfolio feed", () => {
  it("does not exist when nothing is configured", async () => {
    const app = supertest(createApp({ database: h.db, staffSessions: new MemoryStaffSessions(), serveConsole: false }));
    const res = await app.get("/api/v1/portfolio/summary").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(404);
  });

  it("refuses a missing or wrong token", async () => {
    expect((await feedApp().get("/api/v1/portfolio/summary")).status).toBe(401);
    expect((await feedApp().get("/api/v1/portfolio/summary").set("Authorization", "Bearer nope")).status).toBe(401);
  });

  it("returns only the configured tenant's portfolio", async () => {
    const res = await feedApp().get("/api/v1/portfolio/summary").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.data;
    expect(d.tenant.name).toBe("Mine Co");
    expect(d.totals.active_projects).toBe(1);
    expect(d.projects.map((p: { project_number: string }) => p.project_number)).toEqual(["P-100"]);
    expect(d.totals.backlog_contract).toBe(50_000);
    expect(d.draws.approved_not_invoiced).toEqual([]);
    expect(d.exceptions.budget).toEqual([]);
    expect(d.purchasing.open_purchase_orders).toEqual({ count: 0, amount: 0 });
  });

  it("does not count archived vendors as blocked or expiring", async () => {
    const owner = h.as(mine.staff.owner!.token);
    const make = async (legal_name: string, email: string) => {
      const res = await owner.post("/api/v1/projects/vendors").send({ legal_name, email });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.data.id as string;
    };
    const openBlocked = await make("Open Blocked Electric", "open-blocked@example.test");
    const archivedBlocked = await make("Archived Blocked Tile", "archived-blocked@example.test");
    const expiringActive = await make("Expiring Active Plumbing", "expiring-active@example.test");
    const expiringArchived = await make("Expiring Archived HVAC", "expiring-archived@example.test");
    for (const id of [expiringActive, expiringArchived]) {
      const doc = await owner.post(`/api/v1/projects/vendors/${id}/documents`).send({
        kind: "wc_insurance",
        expires_on: "2027-06-01",
        file_key: `k/${id}`,
      });
      expect(doc.status, JSON.stringify(doc.body)).toBe(201);
      await h.db.withTenant(mine.id, async (db) => {
        await db.query(
          `UPDATE projects.vendor_documents SET expires_on = CURRENT_DATE + 10 WHERE vendor_id = $1 AND kind = 'wc_insurance'`,
          [id],
        );
      });
    }
    for (const id of [archivedBlocked, expiringArchived]) {
      const archived = await owner.patch(`/api/v1/projects/vendors/${id}`).send({ archived: true });
      expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    }

    const res = await feedApp().get("/api/v1/portfolio/summary").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const blocked = res.body.data.exceptions.vendors_blocked.map((v: { name: string }) => v.name);
    expect(blocked).toContain("Open Blocked Electric");
    expect(blocked).toContain("Expiring Active Plumbing");
    expect(blocked).not.toContain("Archived Blocked Tile");
    expect(blocked).not.toContain("Expiring Archived HVAC");
    expect(res.body.data.exceptions.vendors_expiring).toBe(1);
    expect(openBlocked).toBeTruthy();
  });

  it("reads config the way the other connectors do", () => {
    expect(portfolioFeedConfig({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(() => portfolioFeedConfig({ PM_PORTFOLIO_TENANT_ID: mine.id, PM_PORTFOLIO_TOKEN: "short" } as NodeJS.ProcessEnv)).toThrow(/24/);
    expect(portfolioFeedConfig({ PM_PORTFOLIO_TENANT_ID: mine.id, PM_PORTFOLIO_TOKEN: TOKEN } as NodeJS.ProcessEnv)).toEqual({ tenantId: mine.id, token: TOKEN });
  });
});
