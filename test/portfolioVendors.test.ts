import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import { createTenant, SCHEMA_FILES, startHarness, type Harness, type TenantFixture } from "./support/harness.js";

/**
 * The vendor half of the portfolio feed: the owner's dashboard reads the directory with updated_at on every row, and
 * writes back on "newest wins": an older timestamp is ignored, a newer one is applied and kept as the row's time.
 */
let h: Harness;
let mine: TenantFixture;
let theirs: TenantFixture;
const TOKEN = "portfolio-feed-token-for-tests-0002";

beforeAll(async () => {
  h = await startHarness(SCHEMA_FILES);
  mine = await createTenant(h, { slug: "pv-mine", displayName: "Mine Co" });
  theirs = await createTenant(h, { slug: "pv-theirs", displayName: "Theirs Co" });
  for (const [t, name] of [[mine, "Harbor Concrete"], [theirs, "Other Tenant Tile"]] as const) {
    const res = await h.as(t.staff.owner!.token).post("/api/v1/projects/vendors").send({ legal_name: name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.test`, trades: ["concrete"] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
});
afterAll(async () => { await h?.close(); });

const feed = () => supertest(createApp({ database: h.db, staffSessions: new MemoryStaffSessions(), serveConsole: false, portfolio: { tenantId: mine.id, token: TOKEN } }));
const auth = (r: supertest.Test) => r.set("Authorization", `Bearer ${TOKEN}`);

describe("portfolio vendor feed", () => {
  it("lists only the configured tenant's vendors, each with updated_at and compliance", async () => {
    const res = await auth(feed().get("/api/v1/portfolio/vendors"));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const names = res.body.data.vendors.map((v: { legal_name: string }) => v.legal_name);
    expect(names).toEqual(["Harbor Concrete"]);
    const v = res.body.data.vendors[0];
    expect(typeof v.updated_at).toBe("string");
    expect(Array.isArray(v.compliance)).toBe(true);
    expect(Array.isArray(v.documents)).toBe(true);
  });

  it("refuses without the token", async () => {
    expect((await feed().get("/api/v1/portfolio/vendors")).status).toBe(401);
  });

  it("applies a newer write and ignores an older one", async () => {
    const list = await auth(feed().get("/api/v1/portfolio/vendors"));
    const v = list.body.data.vendors[0];
    const base = { legal_name: "Harbor Concrete Co.", email: v.email, trades: ["concrete", "excavation"], phone: "555-0142" };
    const older = await auth(feed().put(`/api/v1/portfolio/vendors/${v.id}`)).send({ ...base, updated_at: new Date(Date.parse(v.updated_at) - 60_000).toISOString() });
    expect(older.status, JSON.stringify(older.body)).toBe(200);
    expect(older.body.data.applied).toBe(false);
    expect(older.body.data.vendor.legal_name).toBe("Harbor Concrete");
    const stamp = new Date(Date.parse(v.updated_at) + 60_000).toISOString();
    const newer = await auth(feed().put(`/api/v1/portfolio/vendors/${v.id}`)).send({ ...base, updated_at: stamp });
    expect(newer.status, JSON.stringify(newer.body)).toBe(200);
    expect(newer.body.data.applied).toBe(true);
    expect(newer.body.data.vendor.legal_name).toBe("Harbor Concrete Co.");
    expect(newer.body.data.vendor.trades).toEqual(["concrete", "excavation"]);
    expect(Date.parse(newer.body.data.vendor.updated_at)).toBe(Date.parse(stamp));
  });

  it("a staff edit in Journeyman bumps updated_at so the dashboard sees it as newer", async () => {
    const list = await auth(feed().get("/api/v1/portfolio/vendors"));
    const v = list.body.data.vendors[0];
    const before = Date.parse(v.updated_at);
    const res = await h.as(mine.staff.owner!.token).patch(`/api/v1/projects/vendors/${v.id}`).send({ notes: "edited in Journeyman" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await auth(feed().get("/api/v1/portfolio/vendors"));
    expect(Date.parse(after.body.data.vendors[0].updated_at)).toBeGreaterThan(before);
    expect(after.body.data.vendors[0].notes).toBe("edited in Journeyman");
  });

  it("creates a vendor from the dashboard and refuses a duplicate email", async () => {
    const res = await auth(feed().post("/api/v1/portfolio/vendors")).send({ legal_name: "R. Calder Plumbing", email: "rick@calder.test", trades: ["plumbing"], active: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.legal_name).toBe("R. Calder Plumbing");
    const dup = await auth(feed().post("/api/v1/portfolio/vendors")).send({ legal_name: "Dup", email: "RICK@calder.test" });
    expect(dup.status).toBe(409);
    const other = await h.as(theirs.staff.owner!.token).get("/api/v1/projects/vendors");
    expect(other.body.data.map((x: { legal_name: string }) => x.legal_name)).toEqual(["Other Tenant Tile"]);
  });
  it("ignores another tenant's vendor id even with the right token", async () => {
    const other = await h.as(theirs.staff.owner!.token).get("/api/v1/projects/vendors");
    const foreignId = other.body.data[0].id as string;
    const res = await auth(feed().put(`/api/v1/portfolio/vendors/${foreignId}`)).send({ legal_name: "Hijacked", email: "x@y.test", updated_at: new Date(Date.now() + 60_000).toISOString() });
    expect(res.status).toBe(404);
    const still = await h.as(theirs.staff.owner!.token).get("/api/v1/projects/vendors");
    expect(still.body.data[0].legal_name).toBe("Other Tenant Tile");
  });
});
