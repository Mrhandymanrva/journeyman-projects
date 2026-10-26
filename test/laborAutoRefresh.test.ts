import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import { createApp } from "../src/app.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import {
  LABOR_REFRESH_LOCK_KEY,
  runHourlyLaborRefresh,
  startLaborRefreshScheduler,
} from "../src/workers/laborRefresh.js";
import {
  createTenant,
  projectBody,
  SCHEMA_FILES,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const SYSTEM_ID = "11111111-1111-4111-8111-111111111111";
const WHEN = "2026-10-25T15:00:00.000Z";
const TOKEN = "labor-refresh-portfolio-token-0001";

const jobsSeen: string[] = [];
const methods: string[] = [];
const connection: NonNullable<SourceConnections["serviceTitan"]> = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  externalSystemId: SYSTEM_ID,
  key: "st:test",
  client: {
    readJob: async () => {
      methods.push("GET");
      throw new Error("appointment fallback should not run");
    },
    readJobTimesheets: async (jobId: string) => {
      methods.push("GET");
      jobsSeen.push(jobId);
      if (jobId === "200") throw new Error("ServiceTitan read failed (HTTP 500).");
      return {
        jobId,
        forbidden: false,
        timesheets: [
          {
            id: `ts-${jobId}`,
            appointmentId: null,
            technicianId: "tech-casey",
            technicianName: "Casey Nguyen",
            arrivedOn: "2026-10-25T13:00:00Z",
            dispatchedOn: null,
            doneOn: "2026-10-25T15:00:00Z",
            canceledOn: null,
          },
        ],
      };
    },
    readTechnicians: async () => {
      methods.push("GET");
      return [
        { id: "tech-casey", name: "Casey Nguyen", active: true, hourlyRate: 40, burdenRate: 12 },
        { id: "tech-jordan", name: "Jordan Hale", active: true, hourlyRate: 36, burdenRate: 0 },
      ];
    },
  },
};

describe("labor refresh migration", () => {
  it("is registered and does not assign a logged start", () => {
    const file = SCHEMA_FILES.find((item) => item.endsWith("044_labor_refresh.sql"));
    expect(file).toBeTruthy();
    expect(readFileSync(file!, "utf8")).not.toMatch(/scheduled_start/);
  });
});

describe("hourly labor refresh", () => {
  let h: Harness;
  let tenant: TenantFixture;
  const ids = new Map<string, string>();

  beforeAll(async () => {
    h = await startHarness(SCHEMA_FILES, { serviceTitan: connection });
    tenant = await createTenant(h, { slug: "labor-hourly", displayName: "Hourly Co" });
    connection.tenantId = tenant.id;
    const owner = h.as(tenant.staff.owner!.token);
    for (const number of ["A-100", "A-200", "A-300", "A-800", "A-900"]) {
      const created = await owner.post("/api/v1/projects/projects").send(
        projectBody({ project_number: number, name: `Sample ${number}` }),
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      ids.set(number, created.body.data.id as string);
    }
    await h.db.withTenant(tenant.id, async (db) => {
      await db.query(
        `INSERT INTO projects.external_systems (id, tenant_id, adapter_key, display_name)
         VALUES ($1, $2, 'servicetitan', 'ServiceTitan')`,
        [SYSTEM_ID, tenant.id],
      );
      for (const [number, jobId] of [
        ["A-100", "100"],
        ["A-200", "200"],
        ["A-300", "300"],
        ["A-800", "800"],
        ["A-900", "900"],
      ] as const) {
        await db.query(
          `INSERT INTO projects.project_job_links
             (tenant_id, project_id, external_system_id, external_job_id, title)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenant.id, ids.get(number), SYSTEM_ID, jobId, `Sample job ${jobId}`],
        );
      }
      await db.query(
        `UPDATE projects.projects
            SET stage = $2::projects.project_stage
          WHERE id = $1`,
        [ids.get("A-800"), "cancelled"],
      );
      await db.query(
        `UPDATE projects.projects
            SET stage = $2::projects.project_stage
          WHERE id = $1`,
        [ids.get("A-900"), "complete"],
      );
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  it("holds a real advisory lock on one connection", async () => {
    const lock = await h.db.tryAdvisoryLock(LABOR_REFRESH_LOCK_KEY);
    expect(lock).not.toBeNull();
    try {
      const held = await h.db.asOwner((db) =>
        db.query<{ classid: string; objid: string; granted: boolean }>(
          `SELECT classid::text, objid::text, granted
             FROM pg_locks
            WHERE locktype = 'advisory'`,
        ),
      );
      const expected = await h.db.asOwner((db) =>
        db.query<{ classid: string; objid: string }>(
          `SELECT ((hashtext($1)::bigint >> 32) & 4294967295)::text AS classid,
                  (hashtext($1)::bigint & 4294967295)::text AS objid`,
          [LABOR_REFRESH_LOCK_KEY],
        ),
      );
      expect(held.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            granted: true,
            classid: expected.rows[0]?.classid,
            objid: expected.rows[0]?.objid,
          }),
        ]),
      );
    } finally {
      await lock!.release();
    }
    const after = await h.db.asOwner((db) =>
      db.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory'`),
    );
    expect(after.rows).toEqual([]);
  });

  it("refreshes active projects, records the source, and continues after one failure", async () => {
    jobsSeen.length = 0;
    methods.length = 0;
    const sleeps: number[] = [];
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    const lockSpy = vi.spyOn(h.db, "tryAdvisoryLock");
    try {
      const report = await runHourlyLaborRefresh(h.db, connection, {
        gapMs: 25,
        now: () => new Date(WHEN),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      expect(lockSpy).toHaveBeenCalledWith(LABOR_REFRESH_LOCK_KEY);
      expect(report.skipped).toBeNull();
      expect(report.refreshed).toEqual([ids.get("A-100"), ids.get("A-300")]);
      expect(report.failed.map((failure) => failure.projectNumber)).toEqual(["A-200"]);
      expect(report.failed[0]?.message).toContain("HTTP 500");
      expect(jobsSeen).toEqual(["100", "200", "300"]);
      expect(methods.every((method) => method === "GET")).toBe(true);
      expect(sleeps).toEqual([25, 25]);
      expect(errors.some((line) => line.includes("A-200") && line.includes("HTTP 500"))).toBe(true);
    } finally {
      errorSpy.mockRestore();
      lockSpy.mockRestore();
    }

    const owner = h.as(tenant.staff.owner!.token);
    const ok = await owner.get(`/api/v1/projects/projects/${ids.get("A-100")}/labor`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.source).toBe("auto-hourly");
    expect(ok.body.data.hours_source).toBe("timesheet");
    expect(ok.body.data.observed_at).toBe(WHEN);
    expect(ok.body.data.hours).toBe(2);
    expect(ok.body.data.technicians[0]).toMatchObject({
      technician_name: "Casey Nguyen",
      wage: 80,
      burden: 24,
    });
    expect(ok.body.data.rate_gaps).toEqual([
      expect.objectContaining({
        technician_name: "Jordan Hale",
        messages: ["Missing from ServiceTitan: burden rate is 0 for Jordan Hale"],
      }),
    ]);

    const failed = await owner.get(`/api/v1/projects/projects/${ids.get("A-200")}/labor`);
    expect(failed.body.data.hours).toBe(0);
    expect(failed.body.data.source).toBeNull();
    expect(failed.body.data.observed_at).toBeNull();

    const feed = await supertest(
      createApp({
        database: h.db,
        staffSessions: new MemoryStaffSessions(),
        serveConsole: false,
        portfolio: { tenantId: tenant.id, token: TOKEN },
      }),
    )
      .get("/api/v1/portfolio/projects")
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(feed.status).toBe(200);
    const laborOf = (number: string) =>
      (feed.body.data.projects as Array<{ project_number: string; labor: Record<string, unknown> }>)
        .find((project) => project.project_number === number)?.labor;
    expect(laborOf("A-100")).toMatchObject({
      source: "auto-hourly",
      hours_source: "timesheet",
      observed_at: WHEN,
      labor_hours: 2,
    });
    expect(laborOf("A-200")).toMatchObject({ source: null, observed_at: null });
    expect(laborOf("A-900")).toMatchObject({ source: null, observed_at: null, labor_hours: 0 });
  });

  it("skips the whole run when the advisory lock is already held", async () => {
    const before = jobsSeen.length;
    const report = await runHourlyLaborRefresh(h.db, connection, {
      gapMs: 0,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      tryLock: async () => null,
    });
    expect(report).toEqual({ skipped: "locked", refreshed: [], failed: [] });
    expect(jobsSeen).toHaveLength(before);
    const row = await h.as(tenant.staff.owner!.token).get(
      `/api/v1/projects/projects/${ids.get("A-100")}/labor`,
    );
    expect(row.body.data.observed_at).toBe(WHEN);
    expect(row.body.data.source).toBe("auto-hourly");
  });

  it("keeps the Refresh hours button on manual", async () => {
    const refreshed = await h.as(tenant.staff.owner!.token).post(
      `/api/v1/projects/projects/${ids.get("A-100")}/labor/refresh`,
    );
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body.data.source).toBe("manual");
    expect(refreshed.body.data.hours_source).toBe("timesheet");
    expect(refreshed.body.data.hours).toBe(2);
    expect(refreshed.body.data.observed_at).not.toBe(WHEN);
    expect(typeof refreshed.body.data.observed_at).toBe("string");
  });

  it("stays off, and does not throw, when ServiceTitan is not configured", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((message) => {
      lines.push(String(message));
    });
    try {
      expect(startLaborRefreshScheduler(h.db, {})).toBeUndefined();
      expect(lines).toContain("Labor refresh is off. ServiceTitan is not configured.");
    } finally {
      spy.mockRestore();
    }
  });
});
