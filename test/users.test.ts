import { beforeAll, afterAll, it, expect } from "vitest";
import {
  startHarness,
  createTenant,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
let h: Harness, t: TenantFixture, other: TenantFixture;
const sources: SourceConnections = {};
const base = "/api/v1/projects/users";
const password = "Eight123";
const profile = (email: string) => ({
  full_name: "Test User",
  email,
  phone: "555-0100",
  role: "office",
  business_unit_id: null,
});
const cookie = (r: any) => r.headers["set-cookie"][0].split(";")[0];
beforeAll(async () => {
  h = await startHarness(undefined, sources);
  t = await createTenant(h, { slug: "users" });
  other = await createTenant(h, { slug: "other-users" });
});
afterAll(async () => {
  await h?.close();
});
it("creates users, supports single-use setup, durable password sessions and logout", async () => {
  const created = await h
    .as(t.staff.owner!.token)
    .post(base)
    .send(profile("new@example.test"));
  expect(created.status).toBe(201);
  const token = created.body.data.setupToken;
  expect(
    (
      await h.request
        .post("/api/v1/auth/setup")
        .send({ token, password: "Seven12" })
    ).status,
  ).toBe(400);
  expect(
    (await h.request.post("/api/v1/auth/setup").send({ token, password }))
      .status,
  ).toBe(200);
  expect(
    (await h.request.post("/api/v1/auth/setup").send({ token, password }))
      .status,
  ).toBe(401);
  const login = await h.request
    .post("/api/v1/auth/login")
    .send({ tenant_slug: t.slug, email: "NEW@example.test", password });
  expect(login.status).toBe(200);
  expect(login.headers["set-cookie"]![0]!).toContain("HttpOnly");
  expect(login.headers["set-cookie"]![0]!).toContain("SameSite=Strict");
  expect(
    (
      await h.request
        .get("/api/v1/projects/session")
        .set("Cookie", cookie(login))
    ).status,
  ).toBe(200);
  expect((await h.request.get(base).set("Cookie", cookie(login))).status).toBe(
    403,
  );
  expect(
    (await h.request.post("/api/v1/auth/logout").set("Cookie", cookie(login)))
      .status,
  ).toBe(200);
  expect(
    (
      await h.request
        .get("/api/v1/projects/session")
        .set("Cookie", cookie(login))
    ).status,
  ).toBe(401);
  const rows = await h.db.withTenant(t.id, (db) =>
    db.query<{ password_hash: string; login_bootstrap: boolean }>(
      `SELECT password_hash,login_bootstrap FROM projects.staff WHERE email='new@example.test'`,
    ),
  );
  expect(rows.rows[0]!.password_hash).toMatch(/^scrypt\$/);
  expect(rows.rows[0]!.password_hash).not.toContain(password);
  expect(rows.rows[0]!.login_bootstrap).toBe(false);
  const list = await h.as(t.staff.owner!.token).get(base);
  expect(JSON.stringify(list.body)).not.toContain("scrypt$");
  expect(JSON.stringify(list.body)).not.toContain(token);
});
it("restricts administration to owners and keeps tenant accounts isolated", async () => {
  for (const key of ["manager", "pm", "office", "bookkeeper"])
    expect(
      (
        await h
          .as(t.staff[key]!.token)
          .post(base)
          .send(profile(key + "@test.test"))
      ).status,
    ).toBe(403);
  expect(
    (
      await h
        .as(other.staff.owner!.token)
        .post(base + "/" + t.staff.owner!.id + "/setup-link")
    ).status,
  ).toBe(404);
  expect(
    (
      await h
        .as(t.staff.owner!.token)
        .post(base)
        .send({
          ...profile("foreign-unit@test.test"),
          business_unit_id: Object.values(other.businessUnits)[0],
        })
    ).status,
  ).toBe(404);
  expect(
    (
      await h.request
        .post("/api/v1/auth/login")
        .send({ tenant_slug: other.slug, email: "new@example.test", password })
    ).status,
  ).toBe(401);
  expect(
    (
      await h
        .as(t.staff.owner!.token)
        .patch(base + "/" + t.staff.owner!.id)
        .send({ ...profile("ignored@test.test"), active: false })
    ).status,
  ).toBe(409);
});
it("validates ST employees server-side and prevents duplicate imports", async () => {
  const id = await h.db.withTenant(
    t.id,
    async (db) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO projects.external_systems(tenant_id,adapter_key,display_name) VALUES($1,'servicetitan','ST') RETURNING id`,
          [t.id],
        )
      ).rows[0]!.id,
  );
  const people = [
    {
      id: "101",
      kind: "employee" as const,
      name: "Active Employee",
      active: true,
      email: "st@test.test",
      phone: null,
    },
    {
      id: "102",
      kind: "technician" as const,
      name: "Inactive Tech",
      active: false,
      email: null,
      phone: null,
    },
  ];
  sources.serviceTitan = {
    tenantId: t.id,
    externalSystemId: id,
    key: "test-st",
    client: {
      readJob: async () => {
        throw Error("unused");
      },
      readEmployees: async () => people,
    },
  };
  const list = await h.as(t.staff.owner!.token).get(base + "/st-employees");
  expect(list.body.data).toHaveLength(1);
  const body = {
    ...profile("st@test.test"),
    source_person_id: "101",
    source_person_kind: "employee",
  };
  expect((await h.as(t.staff.owner!.token).post(base).send(body)).status).toBe(
    201,
  );
  expect(
    (
      await h
        .as(t.staff.owner!.token)
        .post(base)
        .send({ ...body, email: "duplicate@test.test" })
    ).status,
  ).toBe(409);
  expect(
    (
      await h
        .as(t.staff.owner!.token)
        .post(base)
        .send({
          ...body,
          email: "inactive@test.test",
          source_person_id: "102",
          source_person_kind: "technician",
        })
    ).status,
  ).toBe(409);
  expect(
    (await h.as(other.staff.owner!.token).get(base + "/st-employees")).status,
  ).toBe(502);
});
it("reset and deactivation invalidate sessions, and deactivation invalidates setup links", async () => {
  const created = await h
    .as(t.staff.owner!.token)
    .post(base)
    .send(profile("reset@test.test"));
  const { id, setupToken } = created.body.data;
  await h.request
    .post("/api/v1/auth/setup")
    .send({ token: setupToken, password });
  const login = await h.request
    .post("/api/v1/auth/login")
    .send({ tenant_slug: t.slug, email: "reset@test.test", password });
  const reset = await h
    .as(t.staff.owner!.token)
    .post(base + "/" + id + "/setup-link");
  await h.request
    .post("/api/v1/auth/setup")
    .send({
      token: reset.body.data.setupToken,
      password: password + " changed",
    });
  expect(
    (
      await h.request
        .get("/api/v1/projects/session")
        .set("Cookie", cookie(login))
    ).status,
  ).toBe(401);
  expect(
    (
      await h.request
        .post("/api/v1/auth/login")
        .send({ tenant_slug: t.slug, email: "reset@test.test", password })
    ).status,
  ).toBe(401);
  const login2 = await h.request
    .post("/api/v1/auth/login")
    .send({
      tenant_slug: t.slug,
      email: "reset@test.test",
      password: password + " changed",
    });
  const next = await h
    .as(t.staff.owner!.token)
    .post(base + "/" + id + "/setup-link");
  expect(
    (
      await h
        .as(t.staff.owner!.token)
        .patch(base + "/" + id)
        .send({ ...profile("reset@test.test"), active: false })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.request
        .get("/api/v1/projects/session")
        .set("Cookie", cookie(login2))
    ).status,
  ).toBe(401);
  expect(
    (
      await h.request
        .post("/api/v1/auth/setup")
        .send({ token: next.body.data.setupToken, password })
    ).status,
  ).toBe(401);
});
it("expires setup links and blocks cross-origin requests and repeated login attempts", async () => {
  const c = await h
    .as(t.staff.owner!.token)
    .post(base)
    .send(profile("expire@test.test"));
  await h.db.withTenant(t.id, (db) =>
    db.query(
      `UPDATE projects.staff_login_tokens SET expires_at=now()-interval '1 hour' WHERE staff_id=$1`,
      [c.body.data.id],
    ),
  );
  expect(
    (
      await h.request
        .post("/api/v1/auth/setup")
        .send({ token: c.body.data.setupToken, password })
    ).status,
  ).toBe(401);
  expect(
    (
      await h.request
        .post("/api/v1/auth/login")
        .set("Origin", "https://evil.test")
        .send({ tenant_slug: t.slug, email: "new@example.test", password })
    ).status,
  ).toBe(403);
  for (let i = 0; i < 10; i++)
    expect(
      (
        await h.request
          .post("/api/v1/auth/login")
          .send({
            tenant_slug: t.slug,
            email: "missing@example.test",
            password,
          })
      ).status,
    ).toBe(401);
  expect(
    (
      await h.request
        .post("/api/v1/auth/login")
        .send({ tenant_slug: t.slug, email: "missing@example.test", password })
    ).status,
  ).toBe(429);
});
