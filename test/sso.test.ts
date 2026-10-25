import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import type { Database } from "../src/db/database.js";
import { readEnv } from "../src/env.js";
import { errorHandler, resetAlertSuppression, setAlertClockForTests } from "../src/http/envelope.js";
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
    expect(await staffRow("tech@example.test")).toBeUndefined();
    const s2 = await signIn({ email: "owner@example.test", name: "Mason", role: "owner" });
    expect((await app().get(`/sso/callback?code=${s2.code}&state=not-the-state`).set("Cookie", s2.stateCookie)).status).toBe(400);
    expect((await app().get(`/sso/callback?code=${s2.code}&state=${s2.state}`)).status).toBe(400);
    const s3 = await signIn({ email: "owner@example.test", name: "Mason", role: "owner" });
    codes.delete(s3.code);
    expect((await app().get(`/sso/callback?code=${s3.code}&state=${s3.state}`).set("Cookie", s3.stateCookie)).status).toBe(401);
  });

  it("creates a manager on first sign-in, matched on the lowercased email", async () => {
    const started = await signIn({ email: "New.Manager@Example.TEST", name: "Nina Manager", role: "manager" });
    const cb = await app().get(`/sso/callback?code=${started.code}&state=${started.state}`).set("Cookie", started.stateCookie);
    expect(cb.status, cb.text).toBe(303);
    const row = await staffRow("new.manager@example.test");
    expect(row?.role).toBe("manager");
    expect(row?.email).toBe("new.manager@example.test");
    const me = await app().get("/api/v1/projects/session").set("Cookie", cookieOf(cb, "jp_session"));
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.data.staff.role).toBe("manager");
    expect(me.body.data.staff.email).toBe("new.manager@example.test");
    expect(me.body.data.capabilities).toContain("approve_draw");
    expect(me.body.data.capabilities).not.toContain("manage_users");
  });

  it("promotes an active non-owner to manager and does not promote a deactivated row", async () => {
    await insertStaff("Coord.Lead@Example.TEST", "project_manager");
    await insertStaff("gone@example.test", "office");
    await h.db.withTenant(mine.id, (db) => db.query(`UPDATE projects.staff SET active = false WHERE lower(email::text) = 'gone@example.test'`));
    const promoted = await signIn({ email: "coord.lead@example.test", name: "Coord Lead", role: "manager" });
    const cb = await app().get(`/sso/callback?code=${promoted.code}&state=${promoted.state}`).set("Cookie", promoted.stateCookie);
    expect(cb.status, cb.text).toBe(303);
    expect((await staffRow("coord.lead@example.test"))?.role).toBe("manager");
    const me = await app().get("/api/v1/projects/session").set("Cookie", cookieOf(cb, "jp_session"));
    expect(me.body.data.staff.role).toBe("manager");
    const deactivated = await signIn({ email: "Gone@Example.TEST", name: "Gone", role: "manager" });
    const denied = await app().get(`/sso/callback?code=${deactivated.code}&state=${deactivated.state}`).set("Cookie", deactivated.stateCookie);
    expect(denied.status).toBe(403);
    expect((await staffRow("gone@example.test"))?.role).toBe("office");
  });

  it("never changes an owner, including when Command Center sends manager", async () => {
    let session = "";
    for (const role of ["manager", "office", "technician"]) {
      const started = await signIn({ email: "OWNER@example.test", name: "Mason", role });
      const cb = await app().get(`/sso/callback?code=${started.code}&state=${started.state}`).set("Cookie", started.stateCookie);
      expect(cb.status, cb.text).toBe(303);
      expect((await staffRow("owner@example.test"))?.role).toBe("owner");
      if (role === "manager") session = cookieOf(cb, "jp_session");
    }
    const me = await app().get("/api/v1/projects/session").set("Cookie", session);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.data.staff.role).toBe("owner");
    expect(me.body.data.capabilities).toContain("manage_users");
  });

  it("does not change an existing row when Command Center sends any role other than manager", async () => {
    const cases = [
      { email: "pm@example.test", role: "office", stay: "project_manager" },
      { email: "estimator@example.test", role: "bookkeeper", stay: "estimator" },
      { email: "office@example.test", role: "csr", stay: "office" },
      { email: "bookkeeper@example.test", role: "owner", stay: "bookkeeper" },
      { email: "manager@example.test", role: "office", stay: "manager" },
      { email: "pm@example.test", role: "project_coordinator", stay: "project_manager" },
      { email: "estimator@example.test", role: "technician", stay: "estimator" },
    ];
    for (const c of cases) {
      const started = await signIn({ email: c.email, name: "Existing", role: c.role });
      const cb = await app().get(`/sso/callback?code=${started.code}&state=${started.state}`).set("Cookie", started.stateCookie);
      expect(cb.status, `${c.email} as ${c.role}: ${cb.text}`).toBe(303);
      expect((await staffRow(c.email))?.role, c.email).toBe(c.stay);
    }
    const unknown = await signIn({ email: "nobody-coord@example.test", name: "Nobody", role: "project_coordinator" });
    expect((await app().get(`/sso/callback?code=${unknown.code}&state=${unknown.state}`).set("Cookie", unknown.stateCookie)).status).toBe(403);
    expect(await staffRow("nobody-coord@example.test")).toBeUndefined();
  });

  it("still maps a new bookkeeper and a new csr", async () => {
    const bookkeeper = await signIn({ email: "Bea@Example.TEST", name: "Bea Books", role: "bookkeeper" });
    expect((await app().get(`/sso/callback?code=${bookkeeper.code}&state=${bookkeeper.state}`).set("Cookie", bookkeeper.stateCookie)).status).toBe(303);
    expect((await staffRow("bea@example.test"))?.role).toBe("bookkeeper");
    const csr = await signIn({ email: "Casey@Example.TEST", name: "Casey", role: "csr" });
    expect((await app().get(`/sso/callback?code=${csr.code}&state=${csr.state}`).set("Cookie", csr.stateCookie)).status).toBe(303);
    const row = await staffRow("casey@example.test");
    expect(row?.role).toBe("office");
    expect(row?.email).toBe("casey@example.test");
  });
});

async function staffRow(email: string) {
  return h.db.withTenant(mine.id, async (db) => (await db.query<{ role: string; email: string }>(
    `SELECT role::text AS role, email::text AS email FROM projects.staff WHERE lower(email::text) = $1`,
    [email.trim().toLowerCase()],
  )).rows[0]);
}

async function insertStaff(email: string, role: string) {
  await h.db.withTenant(mine.id, (db) => db.query(
    `INSERT INTO projects.staff (tenant_id, email, full_name, role) VALUES ($1, $2, $3, $4::projects.staff_role)`,
    [mine.id, email, email, role],
  ));
}

describe("readiness", () => {
  it("keeps /health shallow and answers /health/ready from SELECT 1", async () => {
    const sql: string[] = [];
    const database: Database = {
      withTenant: (id, fn) => h.db.withTenant(id, fn),
      withoutTenant: (fn) => h.db.withoutTenant((client) => fn({
        query: async (text, params) => {
          sql.push(text);
          return client.query(text, params);
        },
      })),
      tryAdvisoryLock: async () => null,
      close: () => h.db.close(),
    };
    const request = supertest(createApp({ database, staffSessions: new MemoryStaffSessions(), serveConsole: false }));
    const health = await request.get("/health");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ data: { status: "ok" } });
    expect(sql).toEqual([]);
    const ready = await request.get("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ data: { status: "ok" } });
    expect(sql).toEqual(["SELECT 1"]);

    const down: Database = {
      withTenant: async () => { throw new Error("down"); },
      withoutTenant: async () => { throw new Error("SELECT secret FROM staff WHERE id = $1"); },
      tryAdvisoryLock: async () => null,
      close: async () => {},
    };
    const shallow = await supertest(createApp({ database: down, staffSessions: new MemoryStaffSessions(), serveConsole: false })).get("/health");
    expect(shallow.status).toBe(200);
    expect(shallow.body).toEqual({ data: { status: "ok" } });
    const notReady = await supertest(createApp({ database: down, staffSessions: new MemoryStaffSessions(), serveConsole: false })).get("/health/ready");
    expect(notReady.status).toBe(503);
    expect(notReady.body).toEqual({ data: { status: "unavailable" } });
    expect(JSON.stringify(notReady.body)).not.toContain("secret");
  });
});

describe("alert webhook", () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let fetchImpl: typeof fetch;
  let nodeEnv: string | undefined;
  let webhook: string | undefined;

  beforeAll(() => {
    fetchImpl = globalThis.fetch;
    nodeEnv = process.env.NODE_ENV;
    webhook = process.env.ALERT_WEBHOOK_URL;
  });

  afterEach(() => {
    globalThis.fetch = fetchImpl;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    if (webhook === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = webhook;
    resetAlertSuppression();
    setAlertClockForTests(null);
    vi.restoreAllMocks();
  });

  function installFetch() {
    calls.length = 0;
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
  }

  function fail(path: string, err = new Error("SELECT secret FROM staff WHERE id = $1")) {
    const out: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) { out.status = code; return this; },
      json(body: unknown) { out.body = body; return this; },
    };
    const req = {
      method: "POST",
      originalUrl: path,
      url: path,
      body: { password: "hunter2", sql: "SELECT secret FROM staff WHERE id = $1" },
      headers: { cookie: "jp_session=secret-cookie" },
    } as unknown as Request;
    errorHandler(err, req, res as never, () => {});
    return out;
  }

  it("does nothing when ALERT_WEBHOOK_URL is unset", () => {
    installFetch();
    delete process.env.ALERT_WEBHOOK_URL;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = fail("/api/v1/projects/1?code=secret");
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: { code: "internal", message: "Something went wrong on our side." } });
    expect(calls).toEqual([]);
    process.env.ALERT_WEBHOOK_URL = "   ";
    fail("/api/v1/projects/1");
    expect(calls).toEqual([]);
    expect(readEnv({ DATABASE_URL: "postgres://x/y" } as NodeJS.ProcessEnv).alertWebhookUrl).toBeUndefined();
    expect(readEnv({ DATABASE_URL: "postgres://x/y", ALERT_WEBHOOK_URL: "  " } as NodeJS.ProcessEnv).alertWebhookUrl).toBeUndefined();
    expect(readEnv({ DATABASE_URL: "postgres://x/y", ALERT_WEBHOOK_URL: "https://alerts.example.test/hook" } as NodeJS.ProcessEnv).alertWebhookUrl).toBe("https://alerts.example.test/hook");
  });

  it("posts the environment and path once, then suppresses the same message for five minutes", async () => {
    installFetch();
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.ALERT_WEBHOOK_URL = "https://alerts.example.test/hook";
    process.env.NODE_ENV = "staging";
    let now = 1_700_000_000_000;
    setAlertClockForTests(() => now);
    const out = fail("/api/v1/projects/1?code=secret&token=abc");
    expect(out.status).toBe(500);
    fail("/api/v1/projects/1?other=1", new Error("different failure, same path"));
    now += 5 * 60 * 1000 - 1;
    fail("/api/v1/projects/1");
    expect(calls).toHaveLength(1);
    const sent = calls[0]!;
    expect(sent.url).toBe("https://alerts.example.test/hook");
    expect(sent.init.method).toBe("POST");
    expect(sent.init.credentials).toBe("omit");
    expect(sent.init.body).toBe("staging /api/v1/projects/1");
    expect(String(sent.init.body)).not.toMatch(/secret|hunter2|cookie|SELECT|\$1/);
    expect(JSON.stringify(sent.init.headers ?? {})).not.toMatch(/cookie/i);
    expect(sent.init.signal).toBeInstanceOf(AbortSignal);
    expect((sent.init.signal as AbortSignal).aborted).toBe(false);
    fail("/api/v1/projects/2");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.init.body).toBe("staging /api/v1/projects/2");
    now += 1;
    fail("/api/v1/projects/1");
    expect(calls).toHaveLength(3);
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    expect((sent.init.signal as AbortSignal).aborted).toBe(true);
  });

  it("still returns 500 when the webhook cannot be called", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.ALERT_WEBHOOK_URL = "not a url";
    globalThis.fetch = (() => { throw new Error("fetch failed"); }) as typeof fetch;
    const out = fail("/health/ready");
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: { code: "internal", message: "Something went wrong on our side." } });
  });
});
