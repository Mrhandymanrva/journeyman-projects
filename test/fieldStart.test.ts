import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { splitSqlStatements } from "../src/db/splitSql.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = "/api/v1/projects";
const sources: SourceConnections = {};
const readProject = vi.fn();
const readJob = vi.fn();
let h: Harness;
let t: TenantFixture;
let other: TenantFixture;
let sourceId: string;
let n = 0;

const owner = () => h.as(t.staff.owner!.token);
const EMPTY = { date: null, source: null, observed_at: null };

function observed() {
  return new Date(Date.UTC(2026, 9, 25, 12, 0, ++n)).toISOString();
}

function appointment(
  id: string,
  start: string,
  extra: { end?: string; status?: string; active?: boolean } = {},
) {
  return {
    id,
    start,
    end: extra.end ?? new Date(Date.parse(start) + 3_600_000).toISOString(),
    status: extra.status ?? "Scheduled",
    active: extra.active ?? true,
  };
}

function jobRead(
  id: string,
  appointments: ReturnType<typeof appointment>[] = [],
  extra: { jobStatus?: string; projectId?: string | null; observedAt?: string } = {},
) {
  return {
    job: {
      id,
      jobNumber: "J-" + id,
      projectId: extra.projectId === undefined ? "200" : extra.projectId,
      customerId: "300",
      locationId: "400",
      jobStatus: extra.jobStatus ?? "Scheduled",
      modifiedOn: "2026-09-15T00:00:00Z",
      summary: null,
    },
    appointments,
    assignments: [],
    observedAt: extra.observedAt ?? "2026-10-25T12:00:00.000Z",
  };
}

function details(jobIds: string[], projectId = "200") {
  return {
    project: {
      id: projectId,
      number: "P-" + projectId,
      name: "ST bathroom",
      customerId: "300",
      locationId: "400",
      jobIds,
      status: "InProgress",
      startDate: "2026-09-20",
      targetCompletionDate: "2026-10-10",
    },
    customer: { id: "300", name: "ST Customer" },
    location: {
      id: "400",
      customerId: "300",
      name: "Service location",
      address: { street: "100 ST Street", city: "Richmond", state: "VA", zip: "23220" },
    },
    jobs: jobIds.map((id) => ({
      id,
      jobNumber: "J-" + id,
      customerId: "300",
      locationId: "400",
      projectId,
      jobStatus: "Scheduled",
      modifiedOn: "2026-09-15T00:00:00Z",
      summary: "From ST",
    })),
    observedAt: observed(),
  };
}

beforeAll(async () => {
  h = await startHarness(undefined, sources);
  t = await createTenant(h, { slug: "field-start" });
  other = await createTenant(h, { slug: "field-start-other" });
  sourceId = await h.db.withTenant(
    t.id,
    async (db) =>
      (
        await db.query<{ id: string }>(
          "INSERT INTO projects.external_systems(tenant_id,adapter_key,display_name) VALUES($1,'servicetitan','ST') RETURNING id",
          [t.id],
        )
      ).rows[0]!.id,
  );
  sources.serviceTitan = {
    tenantId: t.id,
    externalSystemId: sourceId,
    key: "st:production:10",
    client: {
      readJob,
      listProjects: vi.fn(),
      readProject,
      readProjectDetails: readProject,
    },
  };
});

afterAll(async () => {
  await h?.close();
});

it("defaults an omitted logged start to today in New York and keeps an explicit null", async () => {
  const created = await owner()
    .post(base + "/projects")
    .send(projectBody({ project_number: "LOG-TODAY", name: "Logged today" }));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const today = await h.db.asOwner((db) =>
    db.query<{ d: string }>(
      `SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS d`,
    ),
  );
  expect(created.body.data.scheduled_start).toBe(today.rows[0]!.d);
  expect(created.body.data.field_start).toEqual(EMPTY);
  expect(created.body.data.precon.open).toBe(7);
  expect(created.body.data.precon.tasks).toHaveLength(7);

  const cleared = await owner()
    .post(base + "/projects")
    .send(
      projectBody({
        project_number: "LOG-NULL",
        name: "Logged blank",
        scheduled_start: null,
      }),
    );
  expect(cleared.status, JSON.stringify(cleared.body)).toBe(201);
  expect(cleared.body.data.scheduled_start).toBeNull();
});

it("copies the created date once and does not repeat the copy", async () => {
  const sql = readFileSync(path.join(repoRoot, "db/035_field_start.sql"), "utf8");
  expect(sql).toContain(
    "UPDATE projects SET scheduled_start = (created_at AT TIME ZONE 'America/New_York')::date;",
  );
  const day = await h.db.asOwner((db) =>
    db.query<{ d: string }>(
      `SELECT (timestamptz '2026-10-25 03:30:00+00' AT TIME ZONE 'America/New_York')::date::text AS d`,
    ),
  );
  expect(day.rows[0]!.d).toBe("2026-10-24");

  const marker = await h.db.asOwner((db) =>
    db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM projects.scheduled_start_origin_reset`,
    ),
  );
  expect(marker.rows[0]!.n).toBe("1");

  const created = await owner()
    .post(base + "/projects")
    .send(
      projectBody({
        project_number: "LOG-KEEP",
        name: "Keep this logged start",
        scheduled_start: "2026-12-01",
      }),
    );
  expect(created.status).toBe(201);
  const reset = splitSqlStatements(sql).find((statement) =>
    statement.text.includes("scheduled_start_origin_reset"),
  );
  expect(reset).toBeTruthy();
  await h.db.asOwner((db) => db.query(reset!.text));
  const again = await owner().get(base + "/projects/" + created.body.data.id);
  expect(again.body.data.scheduled_start).toBe("2026-12-01");
});

it("stores the earliest New York appointment and ignores a local schedule row", async () => {
  const project = (
    await owner()
      .post(base + "/projects")
      .send(projectBody({ project_number: "FS-EARLY", name: "Earliest day" }))
  ).body.data;
  const ids = ["701", "702", "703", "704", "705"];
  let active = 0;
  let max = 0;
  readJob.mockImplementation(async (id: string) => {
    active += 1;
    max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    if (id === "701") {
      return jobRead(id, [], { jobStatus: "Canceled" });
    }
    if (id === "702") {
      return jobRead(id, [
        appointment("20", "2026-11-04T15:00:00.000Z"),
        appointment("9", "2026-11-03T03:30:00.000Z", { active: false }),
        appointment("11", "2026-11-03T15:00:00.000Z", { status: "Canceled" }),
      ]);
    }
    if (id === "703") {
      return jobRead(
        id,
        [
          appointment("10", "2026-11-03T15:00:00.000Z"),
          appointment("2", "2026-11-03T03:30:00.000Z"),
        ],
        { observedAt: "2026-10-25T12:00:00.000Z" },
      );
    }
    return jobRead(id, [appointment(id, "2026-11-05T15:00:00.000Z")]);
  });
  readProject.mockResolvedValueOnce(details(ids));
  const linked = await owner()
    .post(base + "/projects/" + project.id + "/servicetitan")
    .send({ external_project_id: "200" });
  expect(linked.status, JSON.stringify(linked.body)).toBe(200);
  expect(max).toBe(4);
  expect(readJob.mock.calls.map((call) => call[0]).sort()).toEqual(ids);

  await h.db.withTenant(t.id, (db) =>
    db.query(
      `INSERT INTO projects.schedule_items (tenant_id, project_id, title, window_start, window_end)
       VALUES ($1,$2,'Sub only','2020-01-01','2020-01-02')`,
      [t.id, project.id],
    ),
  );
  readJob.mockImplementation(async (id: string) => {
    if (id === "703") {
      return jobRead(
        id,
        [appointment("2", "2026-11-03T03:30:00.000Z")],
        { observedAt: "2026-10-25T12:00:00.000Z" },
      );
    }
    if (id === "701") return jobRead(id, [], { jobStatus: "Canceled" });
    if (id === "702") {
      return jobRead(id, [
        appointment("20", "2026-11-04T15:00:00.000Z"),
        appointment("9", "2026-11-03T03:30:00.000Z", { active: false }),
        appointment("11", "2026-11-03T15:00:00.000Z", { status: "Canceled" }),
      ]);
    }
    return jobRead(id, [appointment(id, "2026-11-05T15:00:00.000Z")]);
  });
  const calls = readJob.mock.calls.length;
  const refreshed = await owner().post(
    base + "/projects/" + project.id + "/field-start/refresh",
  );
  expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
  expect(refreshed.body.data.field_start).toEqual({
    date: "2026-11-02",
    source: "servicetitan",
    observed_at: "2026-10-25T12:00:00.000Z",
  });
  expect(readJob.mock.calls.length).toBe(calls + ids.length);

  const detail = await owner().get(base + "/projects/" + project.id);
  expect(detail.body.data.scheduled_start).not.toBe("2026-09-20");
  expect(detail.body.data.scheduled_end).toBe("2026-10-10");
  expect(detail.body.data.field_start.date).toBe("2026-11-02");
  expect(detail.body.data.field_start_appointment_id).toBeUndefined();
  expect(detail.body.data.precon.open).toBe(7);
  expect(detail.body.data.precon.tasks.length).toBeGreaterThan(0);

  const stored = await h.db.withTenant(t.id, (db) =>
    db.query<{ field_start_appointment_id: string; field_start_set_by: string | null }>(
      `SELECT field_start_appointment_id, field_start_set_by FROM projects.projects WHERE id = $1`,
      [project.id],
    ),
  );
  expect(stored.rows[0]!.field_start_appointment_id).toBe("2");
  expect(stored.rows[0]!.field_start_set_by).toBeNull();

  const logged = await owner()
    .patch(base + "/projects/" + project.id)
    .send({ scheduled_start: "2026-12-01" });
  expect(logged.status, JSON.stringify(logged.body)).toBe(200);
  expect(logged.body.data.scheduled_start).toBe("2026-12-01");
  const locked = await owner()
    .patch(base + "/projects/" + project.id)
    .send({ scheduled_end: "2026-12-20" });
  expect(locked.status).toBe(409);
});

it("keeps a manual field start, and a cleared override can fill from ServiceTitan", async () => {
  const project = (
    await owner()
      .post(base + "/projects")
      .send(projectBody({ project_number: "FS-MANUAL", name: "Manual start" }))
  ).body.data;
  readJob.mockImplementation(async (id: string) =>
    jobRead(id, [appointment("8", "2026-11-03T15:00:00.000Z")], {
      observedAt: "2026-10-25T15:00:00.000Z",
      projectId: "210",
    }),
  );
  readProject.mockResolvedValueOnce(details(["801"], "210"));
  expect(
    (
      await owner()
        .post(base + "/projects/" + project.id + "/servicetitan")
        .send({ external_project_id: "210" })
    ).status,
  ).toBe(200);

  const set = await owner()
    .put(base + "/projects/" + project.id + "/field-start")
    .send({ date: "2026-12-15" });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  expect(set.body.data.field_start.date).toBe("2026-12-15");
  expect(set.body.data.field_start.source).toBe("manual");
  expect(set.body.data.field_start.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  const calls = readJob.mock.calls.length;
  readProject.mockResolvedValueOnce(details(["801"], "210"));
  const relink = await owner()
    .post(base + "/projects/" + project.id + "/servicetitan")
    .send({ external_project_id: "210" });
  expect(relink.status, JSON.stringify(relink.body)).toBe(200);
  const refresh = await owner().post(
    base + "/projects/" + project.id + "/field-start/refresh",
  );
  expect(refresh.status).toBe(200);
  expect(refresh.body.data.field_start.date).toBe("2026-12-15");
  expect(refresh.body.data.field_start.source).toBe("manual");
  expect(readJob.mock.calls.length).toBe(calls);

  const cleared = await h
    .as(t.staff.manager!.token)
    .put(base + "/projects/" + project.id + "/field-start")
    .send({ date: null });
  expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
  expect(cleared.body.data.field_start).toEqual(EMPTY);

  readJob.mockImplementation(async (id: string) =>
    jobRead(id, [appointment("8", "2026-11-03T15:00:00.000Z")], {
      observedAt: "2026-10-25T15:00:00.000Z",
      projectId: "210",
    }),
  );
  const filled = await owner().post(
    base + "/projects/" + project.id + "/field-start/refresh",
  );
  expect(filled.status, JSON.stringify(filled.body)).toBe(200);
  expect(filled.body.data.field_start).toEqual({
    date: "2026-11-03",
    source: "servicetitan",
    observed_at: "2026-10-25T15:00:00.000Z",
  });
});

it("leaves field start empty when the only work is a local schedule row", async () => {
  const project = (
    await owner()
      .post(base + "/projects")
      .send(projectBody({ project_number: "FS-SUB", name: "Sub only" }))
  ).body.data;
  await h.db.withTenant(t.id, (db) =>
    db.query(
      `INSERT INTO projects.schedule_items (tenant_id, project_id, title, window_start, window_end)
       VALUES ($1,$2,'Sub start','2026-11-01','2026-11-02')`,
      [t.id, project.id],
    ),
  );
  readJob.mockImplementation(async (id: string) => jobRead(id, [], { projectId: "220" }));
  readProject.mockResolvedValueOnce(details(["901"], "220"));
  expect(
    (
      await owner()
        .post(base + "/projects/" + project.id + "/servicetitan")
        .send({ external_project_id: "220" })
    ).status,
  ).toBe(200);
  const refresh = await owner().post(
    base + "/projects/" + project.id + "/field-start/refresh",
  );
  expect(refresh.status, JSON.stringify(refresh.body)).toBe(200);
  expect(refresh.body.data.field_start).toEqual(EMPTY);
});

it("does not change a saved field start when the appointment read fails", async () => {
  const project = (
    await owner()
      .post(base + "/projects")
      .send(projectBody({ project_number: "FS-BAD", name: "Bad window" }))
  ).body.data;
  readJob.mockImplementation(async (id: string) =>
    jobRead(id, [appointment("30", "2026-11-06T15:00:00.000Z")], {
      observedAt: "2026-10-25T16:00:00.000Z",
      projectId: "230",
    }),
  );
  readProject.mockResolvedValueOnce(details(["930"], "230"));
  expect(
    (
      await owner()
        .post(base + "/projects/" + project.id + "/servicetitan")
        .send({ external_project_id: "230" })
    ).status,
  ).toBe(200);
  const before = await owner().post(
    base + "/projects/" + project.id + "/field-start/refresh",
  );
  expect(before.body.data.field_start.date).toBe("2026-11-06");

  readJob.mockImplementation(async (id: string) =>
    jobRead(
      id,
      [appointment("31", "2026-11-01T15:00:00.000Z", { end: "2026-11-01T15:00:00.000Z" })],
      { projectId: "230" },
    ),
  );
  const failed = await owner().post(
    base + "/projects/" + project.id + "/field-start/refresh",
  );
  expect(failed.status).toBe(502);
  const after = await owner().get(base + "/projects/" + project.id);
  expect(after.body.data.field_start.date).toBe("2026-11-06");
  expect(after.body.data.field_start.source).toBe("servicetitan");
});

it("limits who can refresh or override, and does not read ServiceTitan for another tenant", async () => {
  const project = (
    await owner()
      .post(base + "/projects")
      .send(projectBody({ project_number: "FS-ROLE", name: "Roles" }))
  ).body.data;
  const session = await h.as(t.staff.pm!.token).get(base + "/session");
  expect(session.body.data.capabilities).toContain("refresh_field_start");
  expect(session.body.data.capabilities).not.toContain("set_field_start");
  expect(
    (await h.as(t.staff.owner!.token).get(base + "/session")).body.data.capabilities,
  ).toContain("set_field_start");

  readJob.mockImplementation(async (id: string) => jobRead(id, [], { projectId: null }));
  const refreshed = await h
    .as(t.staff.pm!.token)
    .post(base + "/projects/" + project.id + "/field-start/refresh");
  expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
  expect(refreshed.body.data.field_start).toEqual(EMPTY);

  for (const role of ["pm", "office", "estimator", "bookkeeper"] as const) {
    const denied = await h
      .as(t.staff[role]!.token)
      .put(base + "/projects/" + project.id + "/field-start")
      .send({ date: "2026-12-01" });
    expect(denied.status, role).toBe(403);
  }
  for (const role of ["office", "estimator", "bookkeeper"] as const) {
    const denied = await h
      .as(t.staff[role]!.token)
      .post(base + "/projects/" + project.id + "/field-start/refresh");
    expect(denied.status, role).toBe(403);
  }
  const extra = await owner()
    .put(base + "/projects/" + project.id + "/field-start")
    .send({ date: "2026-12-01", note: "no" });
  expect(extra.status).toBe(400);

  const calls = readJob.mock.calls.length;
  const foreign = await h
    .as(other.staff.owner!.token)
    .post(base + "/projects")
    .send(projectBody({ project_number: "FS-OTHER", name: "Other tenant" }));
  expect(foreign.status).toBe(201);
  const missing = await owner().post(
    base + "/projects/" + foreign.body.data.id + "/field-start/refresh",
  );
  expect(missing.status).toBe(404);
  const theirs = await h
    .as(other.staff.owner!.token)
    .post(base + "/projects/" + foreign.body.data.id + "/field-start/refresh");
  expect(theirs.status).toBe(409);
  expect(readJob.mock.calls.length).toBe(calls);

  const feed = supertest(
    createApp({
      database: h.db,
      staffSessions: new MemoryStaffSessions(),
      serveConsole: false,
      portfolio: { tenantId: t.id, token: "field-start-feed-token" },
    }),
  );
  const summary = await feed
    .get("/api/v1/portfolio/summary")
    .set("Authorization", "Bearer field-start-feed-token");
  expect(summary.status).toBe(200);
  const row = (
    summary.body.data.projects as Array<{ id: string; field_start: unknown; precon: { tasks?: unknown } }>
  ).find((item) => item.id === project.id);
  expect(row?.field_start).toEqual(EMPTY);
  expect(row?.precon.tasks).toBeUndefined();
  expect(readJob.mock.calls.length).toBe(calls);
});

it("rejects a ServiceTitan field start that has no appointment", async () => {
  const project = (
    await owner()
      .post(base + "/projects")
      .send(projectBody({ project_number: "FS-SHAPE", name: "Shape" }))
  ).body.data;
  await expect(
    h.db.withTenant(t.id, (db) =>
      db.query(
        `UPDATE projects.projects
            SET field_start = '2026-11-01',
                field_start_source = 'servicetitan',
                field_start_appointment_id = NULL,
                field_start_observed_at = now(),
                field_start_set_by = NULL
          WHERE id = $1`,
        [project.id],
      ),
    ),
  ).rejects.toThrow(/field_start_shape/);
});
