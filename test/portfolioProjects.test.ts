import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import { createTenant, SCHEMA_FILES, startHarness, type Harness, type TenantFixture } from "./support/harness.js";

/** The project half of the portfolio feed: list with the customer and QuickBooks link, and the link written back. */
let h: Harness;
let mine: TenantFixture;
let theirs: TenantFixture;
const TOKEN = "portfolio-feed-token-for-tests-0003";

beforeAll(async () => {
  h = await startHarness(SCHEMA_FILES);
  mine = await createTenant(h, { slug: "pp-mine", displayName: "Mine Co" });
  theirs = await createTenant(h, { slug: "pp-theirs", displayName: "Theirs Co" });
  for (const [t, number] of [[mine, "P-300"], [theirs, "P-900"]] as const) {
    const res = await h.as(t.staff.owner!.token).post("/api/v1/projects/projects").send({ project_number: number, name: `Project ${number}`, source_kind: "manual", address_line1: "1 Main St", city: "Richmond", region: "VA", contract_value: 50_000, target_margin: 0.35 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
});
afterAll(async () => { await h?.close(); });

const feed = () => supertest(createApp({ database: h.db, staffSessions: new MemoryStaffSessions(), serveConsole: false, portfolio: { tenantId: mine.id, token: TOKEN } }));
const auth = (r: supertest.Test) => r.set("Authorization", `Bearer ${TOKEN}`);

describe("portfolio project feed", () => {
  it("lists only the configured tenant's projects with their QuickBooks link", async () => {
    const res = await auth(feed().get("/api/v1/portfolio/projects"));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.projects.map((p: { project_number: string }) => p.project_number)).toEqual(["P-300"]);
    expect(res.body.data.projects[0].qbo_customer_id).toBeNull();
    expect((await feed().get("/api/v1/portfolio/projects")).status).toBe(401);
  });

  it("writes the QuickBooks customer:job link back, and not for another tenant's project", async () => {
    const list = await auth(feed().get("/api/v1/portfolio/projects"));
    const id = list.body.data.projects[0].id as string;
    const put = await auth(feed().put(`/api/v1/portfolio/projects/${id}/accounting`)).send({ qbo_customer_id: "123" });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data.qbo_customer_id).toBe("123");
    const other = await h.as(theirs.staff.owner!.token).get("/api/v1/projects/projects");
    const foreign = (other.body.data as Array<{ id: string }>)[0]!.id;
    expect((await auth(feed().put(`/api/v1/portfolio/projects/${foreign}/accounting`)).send({ qbo_customer_id: "999" })).status).toBe(404);
  });
});
