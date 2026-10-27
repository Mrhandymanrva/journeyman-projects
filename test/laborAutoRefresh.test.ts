import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import { readSourceConnections } from "../src/adapters/sourceConnections.js";
import { createApp } from "../src/app.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import {
  LABOR_REFRESH_LOCK_KEY,
  OVERNIGHT_LOCK_RETRY_MS,
  laborRefreshTenantId,
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
    sourceTenantId: "st-hourly",
    readLaborService: async () => {
      methods.push("GET");
      return {
        services: [
          {
            id: "91025",
            code: "MHM.25PLFE",
            name: "Project Labor From Estimate",
            active: true,
          },
        ],
      };
    },
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
            paidDurationHours: 2,
          },
        ],
      };
    },
    readTechnicians: async () => {
      methods.push("GET");
      return [
        {
          id: "tech-casey",
          name: "Casey Nguyen",
          active: true,
          hourlyRate: 40,
          burdenRate: 12,
          commissionRate: null,
        },
        {
          id: "tech-jordan",
          name: "Jordan Hale",
          active: true,
          hourlyRate: 36,
          burdenRate: 0,
          commissionRate: null,
        },
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
    expect(ok.body.data.source).toBe("scheduled");
    expect(ok.body.data.hours_source).toBe("timesheet");
    expect(ok.body.data.observed_at).toBe(WHEN);
    expect(ok.body.data.hours).toBe(2);
    expect(ok.body.data.technicians[0]).toMatchObject({
      technician_name: "Casey Nguyen",
      wage: 80,
      burden: 24,
    });
    expect(ok.body.data).not.toHaveProperty("rate_gaps");
    expect(ok.body.data).not.toHaveProperty("burden_notices");
    const settings = await owner.get("/api/v1/projects/settings/labor");
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    expect(settings.body.data.rate_gaps).toEqual([]);
    expect(settings.body.data.burden_notices).toEqual([
      expect.objectContaining({
        technician_name: "Jordan Hale",
        messages: ["burden not set"],
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
      source: "scheduled",
      hours_source: "timesheet",
      observed_at: WHEN,
      labor_hours: 2,
    });
    expect(laborOf("A-200")).toMatchObject({ source: null, observed_at: null });
    expect(laborOf("A-900")).toMatchObject({ source: null, observed_at: null, labor_hours: 0 });
    const projectFeed = (number: string) =>
      (feed.body.data.projects as Array<{
        project_number: string;
        labor_refresh: { status: string; ok: number; failed: number; error: string | null };
        reconciliation: {
          lines: Array<{ key: string; jp: number; st: number; delta: number }>;
          technicians: Array<{ technician_name: string; hours: number; burden: number | null; commission_percent: number | null }>;
        } | null;
      }>).find((project) => project.project_number === number);
    expect(projectFeed("A-100")?.labor_refresh).toMatchObject({
      status: "finished",
      ok: 2,
      failed: 1,
      error: null,
    });
    expect(projectFeed("A-200")?.labor_refresh.error).toContain("HTTP 500");
    expect(projectFeed("A-100")?.reconciliation?.technicians).toEqual([
      expect.objectContaining({
        technician_name: "Casey Nguyen",
        hours: 2,
        commission_percent: null,
        burden: 24,
      }),
    ]);
    const burdenLine = projectFeed("A-100")?.reconciliation?.lines.find((line) => line.key === "laborBurden");
    expect(burdenLine).toMatchObject({ jp: 24, st: 24, delta: 0 });

    await h.db.withTenant(tenant.id, (db) =>
      db.query(
        `UPDATE projects.labor_actuals SET burden_amount = burden_amount + 0.01 WHERE project_id = $1`,
        [ids.get("A-100")],
      ),
    );
    const stored = await owner.get(
      `/api/v1/projects/projects/${ids.get("A-100")}/financials/reconciliation`,
    );
    expect(stored.status, JSON.stringify(stored.body)).toBe(200);
    expect(stored.body.data.lines.find((line: { key: string }) => line.key === "laborBurden")).toMatchObject({
      jp: 24,
      st: 24,
      delta: 0,
    });
    expect(stored.body.data.note).toBeNull();
    const untouched = await owner.get(
      `/api/v1/projects/projects/${ids.get("A-900")}/financials/reconciliation`,
    );
    expect(untouched.body.data.observed_at).toBeNull();
    expect(untouched.body.data.lines).toEqual([]);
    expect(untouched.body.data.note).toBe("No reconciliation has been stored. Refresh will write one.");

    await h.db.withTenant(tenant.id, (db) =>
      db.query(
        `UPDATE projects.st_financial_reconciliation
            SET lines = $2::jsonb
          WHERE project_id = $1`,
        [
          ids.get("A-300"),
          JSON.stringify([{ key: "billedLabor", label: "Billed labor", jp: 1.01, st: 1, delta: 0.01 }]),
        ],
      ),
    );
    const drifted = await owner.get(
      `/api/v1/projects/projects/${ids.get("A-300")}/financials/reconciliation`,
    );
    expect(drifted.body.data.lines).toEqual([
      expect.objectContaining({ key: "billedLabor", jp: 1.01, st: 1, delta: 0.01 }),
    ]);
  });

  it("skips the whole run when the advisory lock is already held", async () => {
    const before = jobsSeen.length;
    const report = await runHourlyLaborRefresh(h.db, connection, {
      gapMs: 0,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      tryLock: async () => null,
    });
    expect(report).toEqual({
      skipped: "locked",
      projects: 0,
      refreshed: [],
      failed: [],
      laborCode: null,
    });
    expect(jobsSeen).toHaveLength(before);
    const row = await h.as(tenant.staff.owner!.token).get(
      `/api/v1/projects/projects/${ids.get("A-100")}/labor`,
    );
    expect(row.body.data.observed_at).toBe(WHEN);
    expect(row.body.data.source).toBe("scheduled");
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
      expect(lines).toContain("Overnight ServiceTitan refresh is off. ServiceTitan is not configured.");
    } finally {
      spy.mockRestore();
    }
  });

  it("waits until the next 2 AM America/New_York and does not run on a first boot", async () => {
    const now = new Date("2026-01-15T06:59:00.000Z");
    const delays: number[] = [];
    const timer = startLaborRefreshScheduler(h.db, { serviceTitan: connection }, {
      env: {},
      now: () => now,
      schedule: (_run, delayMs) => {
        delays.push(delayMs);
        return { cancel() {} };
      },
    });
    expect(timer).toBeDefined();
    await vi.waitFor(() => {
      expect(delays.length).toBeGreaterThan(0);
    });
    expect(delays[0]).toBe(60_000);
    timer?.cancel();
  });

  it("catch-up runs a morning restart that has no finish stamp, and a lock retries without finishing the night", async () => {
    const now = new Date("2026-10-27T09:43:00.000Z");
    const lines: string[] = [];
    const delays: number[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((message) => {
      lines.push(String(message));
    });
    const timer = startLaborRefreshScheduler(h.db, { serviceTitan: connection }, {
      env: {},
      now: () => now,
      gapMs: 0,
      tryLock: async () => null,
      schedule: (_run, delayMs) => {
        delays.push(delayMs);
        return { cancel() {} };
      },
    });
    try {
      await vi.waitFor(() => {
        expect(lines.some((line) => line.includes("Missed the 2 AM America/New_York refresh. Running one catch-up."))).toBe(true);
      });
      expect(lines.some((line) => line.includes("Retrying in 15 minutes."))).toBe(true);
      expect(delays).toEqual([OVERNIGHT_LOCK_RETRY_MS]);
      const finished = await h.db.withTenant(tenant.id, (db) =>
        db.query<{ finished: Date | null }>(
          `SELECT overnight_refresh_finished_at AS finished
             FROM projects.tenant_settings WHERE tenant_id = $1`,
          [tenant.id],
        ),
      );
      expect(finished.rows[0]?.finished).toBeNull();
    } finally {
      timer?.cancel();
      spy.mockRestore();
    }
  });
});

const PORTFOLIO_TENANT = "11111111-1111-4111-8111-111111111111";
const CONNECTOR_TENANT = "22222222-2222-4222-8222-222222222222";

describe("labor refresh tenant", () => {
  it("uses the sign-in tenant, not the ServiceTitan connector tenant", () => {
    expect(
      laborRefreshTenantId(
        {
          SSO_TENANT_ID: PORTFOLIO_TENANT,
          PM_PORTFOLIO_TENANT_ID: CONNECTOR_TENANT,
          PM_ST_TENANT_ID: CONNECTOR_TENANT,
        },
        CONNECTOR_TENANT,
      ),
    ).toBe(PORTFOLIO_TENANT);
    expect(
      laborRefreshTenantId(
        { PM_PORTFOLIO_TENANT_ID: PORTFOLIO_TENANT, PM_ST_TENANT_ID: CONNECTOR_TENANT },
        CONNECTOR_TENANT,
      ),
    ).toBe(PORTFOLIO_TENANT);
    expect(laborRefreshTenantId({ PM_ST_TENANT_ID: CONNECTOR_TENANT }, CONNECTOR_TENANT)).toBe(
      CONNECTOR_TENANT,
    );
    expect(
      laborRefreshTenantId(
        { SSO_TENANT_ID: "not-a-uuid", PM_PORTFOLIO_TENANT_ID: PORTFOLIO_TENANT },
        CONNECTOR_TENANT,
      ),
    ).toBe(PORTFOLIO_TENANT);
  });
});

describe("scheduler uses the manual refresh env", () => {
  let h: Harness;
  let portfolio: TenantFixture;
  let timer: { cancel: () => void } | undefined;
  const ids = new Map<string, string>();
  const calls: Array<{ url: string; method: string }> = [];
  const secret = "scheduler-fix-client-secret";

  beforeAll(async () => {
    h = await startHarness(SCHEMA_FILES);
    portfolio = await createTenant(h, { slug: "labor-sign-in", displayName: "Sign-in Co" });
    const connector = await createTenant(h, { slug: "labor-connector", displayName: "Connector Co" });
    const env = {
      SSO_TENANT_ID: "",
      PM_PORTFOLIO_TENANT_ID: portfolio.id,
      PM_ST_TENANT_ID: connector.id,
      PM_ST_EXTERNAL_SYSTEM_ID: SYSTEM_ID,
      ST_ENV: "integration",
      ST_TENANT_ID: "99887766",
      ST_CLIENT_ID: "labor-refresh-client",
      ST_CLIENT_SECRET: secret,
      ST_APP_KEY: "labor-refresh-app-key",
    };
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/connect/token")) {
        return Response.json({ access_token: "test-token", expires_in: 900 });
      }
      if (/\/jobs\/\d+$/.test(url.split("?")[0] ?? url)) {
        const jobId = url.match(/jobs\/(\d+)/)?.[1] ?? "0";
        return Response.json({
          id: Number(jobId),
          jobNumber: jobId,
          customerId: 1,
          locationId: 1,
          jobStatus: "Scheduled",
          modifiedOn: "2026-10-25T12:00:00Z",
        });
      }
      if (
        url.includes("/appointments") ||
        url.includes("/appointment-assignments") ||
        url.includes("/invoices") ||
        url.includes("/purchase-orders")
      ) {
        return Response.json({ data: [], hasMore: false });
      }
      if (url.includes("/timesheets")) {
        const jobId = url.match(/jobs\/(\d+)\/timesheets/)?.[1] ?? "0";
        return Response.json({
          data: [
            {
              id: Number(jobId),
              appointmentId: 4,
              technicianId: 6,
              technicianName: "Casey Nguyen",
              arrivedOn: "2026-10-25T13:00:00Z",
              doneOn: "2026-10-25T15:00:00Z",
              canceledOn: null,
              paidDurationHours: 2,
              hourlyRate: 99,
            },
          ],
          hasMore: false,
        });
      }
      if (url.includes("/technicians")) {
        return Response.json({
          data: [
            { id: 6, name: "Casey Nguyen", active: true, hourlyRate: 40, burdenRate: 12 },
          ],
          hasMore: false,
        });
      }
      if (url.includes("/pricebook/") && url.includes("/services")) {
        return Response.json({
          page: 1,
          pageSize: 50,
          hasMore: false,
          data: [
            {
              id: 91025,
              code: "MHM.25PLFE",
              displayName: "Project Labor From Estimate",
              active: true,
              description: "stripped",
            },
          ],
        });
      }
      return Response.json({ data: [], hasMore: false }, { status: 404 });
    };
    vi.stubGlobal("fetch", fetchMock);
    const sources = readSourceConnections(env);
    expect(sources.serviceTitan?.tenantId).toBe(connector.id);
    expect(sources.serviceTitan?.tenantId).not.toBe(portfolio.id);
    const owner = h.as(portfolio.staff.owner!.token);
    for (const number of ["H-1", "M-1", "P-1", "C-1", "X-1"]) {
      const created = await owner.post("/api/v1/projects/projects").send(
        projectBody({
          project_number: number,
          name: `Sample ${number}`,
          scheduled_start: "2026-10-19",
        }),
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      ids.set(number, created.body.data.id as string);
    }
    await h.db.withTenant(portfolio.id, async (db) => {
      await db.query(
        `INSERT INTO projects.external_systems (id, tenant_id, adapter_key, display_name)
         VALUES ($1, $2, 'servicetitan', 'ServiceTitan')`,
        [SYSTEM_ID, portfolio.id],
      );
      for (const [number, jobId] of [
        ["H-1", "100"],
        ["M-1", "200"],
        ["P-1", "300"],
        ["C-1", "400"],
        ["X-1", "500"],
      ] as const) {
        await db.query(
          `INSERT INTO projects.project_job_links
             (tenant_id, project_id, external_system_id, external_job_id, title)
           VALUES ($1, $2, $3, $4, $5)`,
          [portfolio.id, ids.get(number), SYSTEM_ID, jobId, `Sample job ${jobId}`],
        );
        if (stageOf(number) !== "handoff") {
          await db.query(
            `UPDATE projects.projects SET stage = $2::projects.project_stage WHERE id = $1`,
            [ids.get(number), stageOf(number)],
          );
        }
      }
    });

    await h.db.withTenant(portfolio.id, (db) =>
      db.query(
        `UPDATE projects.tenant_settings
            SET overnight_refresh_finished_at = $2
          WHERE tenant_id = $1`,
        [portfolio.id, "2026-10-24T06:05:00.000Z"],
      ),
    );
    const lines: string[] = [];
    const errors: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message) => {
      lines.push(String(message));
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      timer = startLaborRefreshScheduler(h.db, sources, {
        env,
        gapMs: 0,
        now: () => new Date(WHEN),
      });
      expect(timer).toBeDefined();
      await vi.waitFor(() => {
        if (!lines.some((line) => line.includes("Labor refresh run: 3 refreshed, 0 failed; labor code: MHM.25PLFE Project Labor From Estimate"))) {
          throw new Error(`logs=${lines.join(" | ")} errors=${errors.join(" | ")}`);
        }
      }, { timeout: 5000 });
      expect(lines).toContain("Missed the 2 AM America/New_York refresh. Running one catch-up.");
      expect(lines.join("\n")).not.toContain(secret);
      expect(errors.join("\n")).not.toContain(secret);
      expect(calls.some((call) => call.method !== "GET" && !call.url.includes("/connect/token"))).toBe(
        false,
      );
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    const manualApp = supertest(
      createApp({
        database: h.db,
        staffSessions: h.sessions,
        serveConsole: false,
        sources,
      }),
    );
    const manual = await manualApp
      .post(`/api/v1/projects/projects/${ids.get("H-1")}/labor/refresh`)
      .set("Authorization", `Bearer ${portfolio.staff.owner!.token}`);
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);
    expect(manual.body.data.source).toBe("manual");
    expect(manual.body.data.hours).toBe(2);
  });

  afterAll(async () => {
    timer?.cancel();
    vi.unstubAllGlobals();
    await h?.close();
  });

  it("stamps handoff, mobilization, and precon, and leaves other project fields", async () => {
    const owner = h.as(portfolio.staff.owner!.token);
    const stamped = await owner.get(`/api/v1/projects/projects/${ids.get("M-1")}/labor`);
    expect(stamped.status).toBe(200);
    expect(stamped.body.data.source).toBe("scheduled");
    expect(stamped.body.data.hours).toBe(2);
    expect(stamped.body.data.observed_at).toBe(WHEN);

    const precon = await owner.get(`/api/v1/projects/projects/${ids.get("P-1")}/labor`);
    expect(precon.body.data.source).toBe("scheduled");
    expect(precon.body.data.hours).toBe(2);

    const handoff = await owner.get(`/api/v1/projects/projects/${ids.get("H-1")}/labor`);
    expect(handoff.body.data.source).toBe("manual");

    for (const number of ["C-1", "X-1"]) {
      const closed = await owner.get(`/api/v1/projects/projects/${ids.get(number)}/labor`);
      expect(closed.body.data.source).toBeNull();
      expect(closed.body.data.observed_at).toBeNull();
    }

    const row = await h.db.withTenant(portfolio.id, (db) =>
      db.query<{
        project_number: string;
        name: string;
        stage: string;
        scheduled_start: string;
        contract_value: string;
        labor_refresh_source: string;
      }>(
        `SELECT project_number, name, stage::text AS stage, scheduled_start::text AS scheduled_start,
                contract_value::text AS contract_value, labor_refresh_source
           FROM projects.projects WHERE id = $1`,
        [ids.get("M-1")],
      ),
    );
    expect(row.rows[0]).toMatchObject({
      project_number: "M-1",
      name: "Sample M-1",
      stage: "mobilization",
      scheduled_start: "2026-10-19",
      labor_refresh_source: "scheduled",
    });
  });
});

function stageOf(number: string): string {
  if (number.startsWith("M-")) return "mobilization";
  if (number.startsWith("P-")) return "precon";
  if (number.startsWith("C-")) return "complete";
  if (number.startsWith("X-")) return "cancelled";
  return "handoff";
}
