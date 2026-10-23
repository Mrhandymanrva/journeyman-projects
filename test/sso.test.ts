import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import { createTenant, SCHEMA_FILES, startHarness, type Harness, type TenantFixture } from "./support/harness.js";

/**
 * Sign in with Command Center. /sso/start sends the browser to Command Center with a state cookie; /sso/callback
 * redeems the code with the client secret (Command Center is stood in for here), finds or creates the staff member
 * on the configured tenant, and opens a normal session. Wrong state, a refused code or a technician gets no session.
 */
let h: Harness;
let mine: TenantFixture;
const CC = "https://command.example.test";
const codes = new Map<string, { email: string; name: string; role: string; next: string }>();
let tokenCalls: Array<Record<string, unknown>> = [];
const fakeCc: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url === `${CC}/sso/token`) {
    const b = JSON.parse(String(init?.body ?? "{}")); tokenCalls.push(b);
    if (b.client_id !== "jp-test" || b.client_secret !== "jp-test-secret") return new Response(JSON.stringify({ error: "Unknown app or wrong secret." }), { status: 401 });
    const u = codes.get(b.code); codes.delete(b.code);
    if (!u) return new Response(JSON.stringify({ error: "That sign-in code is not valid, has expired, or was already used." }), { status: 400 });
    return new Response(JSON.stringify({ user: { id: 7, email: u.email, name: u.name, role: u.role }, next: u.next }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("not found", { status: 404 });
};
const config = { url: CC, clientId: "jp-test", clientSecret: "jp-test-secret", fetch: fakeCc };
const app = () => supertest(createApp({ database: h.db, staffSessions: new MemoryStaffSessions(), serveConsole: false, sso: { ...config, tenantId: mine.id } }));
const cookieOf = (res: supertest.Response, name: string) => (res.headers["set-cookie"] as unknown as string[] | undefined ?? []).map((c) => c.split(";")[0] ?? "").find((c) => c.startsWith(name + "=")) ?? "";

async function signIn(user: { email: string; name: string; role: string }, next = "/?project=abc") {
  const start = await app().get(`/sso/start?next=${encodeURIComponent(next)}`);
  expect(start.status).toBe(303);
  const loc = new URL(start.headers.location!);
  expect(loc.origin + loc.pathname).toBe(`${CC}/sso/authorize`);
  expect(loc.searchParams.get("client_id")).toBe("jp-test");
  expect(loc.searchParams.get("redirect_uri")).toMatch(/\/sso\/callback$/);
  const state = loc.searchParams.get("state")!;
  const stateCookie = cookieOf(start, "jp_sso_state");
  const code = `code-${Math.random().toString(16).slice(2)}`; codes.set(code, { ...user, next });
  return { state, stateCookie, code };
}

beforeAll(async () => { h = await startHarness(SCHEMA_FILES); mine = await createTenant(h, { slug: "sso-mine", displayName: "Mine Co" }); });
afterAll(async () => { await h?.close(); });

describe("sign in with Command Center", () => {
  it("does not exist when nothing is configured", async () => {
    const bare = supertest(createApp({ database: h.db, staffSessions: new MemoryStaffSessions(), serveConsole: false }));
    expect((await bare.get("/sso/start")).status).toBe(404);
    const cfg = await bare.get("/api/v1/auth/config");
    expect(cfg.body.data.ssoEnabled).toBe(false);
  });

  it("tells the login page the button exists", async () => {
    const cfg = await app().get("/api/v1/auth/config");
    expect(cfg.body.data.ssoEnabled).toBe(true);
    expect(cfg.body.data.ssoStart).toBe("/sso/start");
  });

  it("signs an existing staff member in and lands them on the requested page", async () => {
    const { state, stateCookie, code } = await signIn({ email: "owner@example.test", name: "Mason", role: "owner" });
    const cb = await app().get(`/sso/callback?code=${code}&state=${state}`).set("Cookie", stateCookie);
    expect(cb.status, cb.text).toBe(303);
    expect(cb.headers.location).toBe("/?project=abc");
    const session = cookieOf(cb, "jp_session");
    expect(session).not.toBe("");
    const me = await app().get("/api/v1/projects/session").set("Cookie", session);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(JSON.stringify(me.body)).toContain("owner@example.test");
    expect(tokenCalls.at(-1)).toMatchObject({ client_id: "jp-test", client_secret: "jp-test-secret", code });
  });

  it("creates an office user on first arrival with the mapped role", async () => {
    const { state, stateCookie, code } = await signIn({ email: "amy@example.test", name: "Amy W", role: "office" }, "/");
    const cb = await app().get(`/sso/callback?code=${code}&state=${state}`).set("Cookie", stateCookie);
    expect(cb.status, cb.text).toBe(303);
    const amy = await h.db.withTenant(mine.id, async (db) => (await db.query<{ role: string; full_name: string }>("SELECT role::text AS role, full_name FROM projects.staff WHERE email = $1", ["amy@example.test"])).rows[0]);
    expect(amy?.role).toBe("office");
    expect(amy?.full_name).toBe("Amy W");
  });

  it("refuses a technician, a wrong state, and a code Command Center will not redeem", async () => {
    const tech = await signIn({ email: "tech@example.test", name: "Tech", role: "technician" });
    expect((await app().get(`/sso/callback?code=${tech.code}&state=${tech.state}`).set("Cookie", tech.stateCookie)).status).toBe(403);
    const s2 = await signIn({ email: "owner@example.test", name: "Mason", role: "owner" });
    expect((await app().get(`/sso/callback?code=${s2.code}&state=not-the-state`).set("Cookie", s2.stateCookie)).status).toBe(400);
    expect((await app().get(`/sso/callback?code=${s2.code}&state=${s2.state}`)).status).toBe(400);
    const s3 = await signIn({ email: "owner@example.test", name: "Mason", role: "owner" });
    codes.delete(s3.code);
    expect((await app().get(`/sso/callback?code=${s3.code}&state=${s3.state}`).set("Cookie", s3.stateCookie)).status).toBe(401);
  });
});
