import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceTitanReadError } from "../src/adapters/serviceTitan.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import { storeJobLabor, storeTechnicianRates } from "../src/domain/laborActuals.js";
import {
  clearStLaborCodeCache,
  LABOR_SERVICE_CODE,
  LABOR_SERVICE_MISSING_MESSAGE,
  LABOR_SERVICE_READ_FAILED_MESSAGE,
  LABOR_SERVICE_SOURCE,
  laborCodeCollisionMessage,
  resetLaborCodeErrorLog,
  resolveStLaborCode,
  ST_LABOR_CODE_FAILURE_TTL_MS,
  ST_LABOR_CODE_SUCCESS_TTL_MS,
  type PricebookServiceRow,
} from "../src/domain/stLaborCode.js";
import { formatLaborRefreshRun, runHourlyLaborRefresh } from "../src/workers/laborRefresh.js";
import {
  createTenant,
  projectBody,
  SCHEMA_FILES,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const service = (
  id: string,
  code = LABOR_SERVICE_CODE,
  name: string | null = "Project Labor From Estimate",
  active = true,
): PricebookServiceRow => ({ id, code, name, active });

describe("ServiceTitan labor code cache", () => {
  beforeEach(() => {
    clearStLaborCodeCache();
    resetLaborCodeErrorLog();
  });

  it("remembers a found service for an hour and a failure for five minutes", async () => {
    let calls = 0;
    let missing = false;
    const client = {
      sourceTenantId: "cache-a",
      readLaborService: async () => {
        calls += 1;
        return { services: missing ? [] : [service("91025")] };
      },
    };
    const start = 1_700_000_000_000;
    const first = await resolveStLaborCode(client, start);
    expect(first).toMatchObject({
      ok: true,
      code: LABOR_SERVICE_CODE,
      name: "Project Labor From Estimate",
      stId: "91025",
    });
    missing = true;
    expect(await resolveStLaborCode(client, start + ST_LABOR_CODE_SUCCESS_TTL_MS - 1)).toMatchObject({
      ok: true,
      code: LABOR_SERVICE_CODE,
    });
    expect(calls).toBe(1);
    expect(await resolveStLaborCode(client, start + ST_LABOR_CODE_SUCCESS_TTL_MS)).toMatchObject({
      ok: false,
      reason: "missing",
      message: LABOR_SERVICE_MISSING_MESSAGE,
    });
    expect(calls).toBe(2);
    const failedAt = start + ST_LABOR_CODE_SUCCESS_TTL_MS;
    expect(await resolveStLaborCode(client, failedAt + ST_LABOR_CODE_FAILURE_TTL_MS - 1)).toMatchObject({
      reason: "missing",
    });
    expect(calls).toBe(2);
    missing = false;
    expect(await resolveStLaborCode(client, failedAt + ST_LABOR_CODE_FAILURE_TTL_MS)).toMatchObject({
      ok: true,
      code: LABOR_SERVICE_CODE,
    });
    expect(calls).toBe(3);
  });

  it("does not share a cached service across ServiceTitan tenants", async () => {
    const seen: string[] = [];
    const clientFor = (tenant: string) => ({
      sourceTenantId: tenant,
      readLaborService: async () => {
        seen.push(tenant);
        return { services: [service(tenant)] };
      },
    });
    const now = 50_000;
    expect(await resolveStLaborCode(clientFor("ten-a"), now)).toMatchObject({ stId: "ten-a" });
    expect(await resolveStLaborCode(clientFor("ten-b"), now)).toMatchObject({ stId: "ten-b" });
    expect(await resolveStLaborCode(clientFor("ten-a"), now)).toMatchObject({ stId: "ten-a" });
    expect(seen).toEqual(["ten-a", "ten-b"]);
  });

  it("accepts an exact case-insensitive active match and rejects the rest", async () => {
    const read = async (services: PricebookServiceRow[]) =>
      resolveStLaborCode(
        {
          sourceTenantId: `shape-${services.map((row) => `${row.id}:${row.code}:${row.active}`).join(",") || "empty"}`,
          readLaborService: async () => ({ services }),
        },
        10,
      );
    expect(await read([])).toEqual({
      ok: false,
      reason: "missing",
      message: LABOR_SERVICE_MISSING_MESSAGE,
    });
    expect(await read([service("1", "MHM.25PLFE-EXTRA")])).toEqual({
      ok: false,
      reason: "missing",
      message: LABOR_SERVICE_MISSING_MESSAGE,
    });
    expect(await read([service("1", LABOR_SERVICE_CODE, "Project Labor From Estimate", false)])).toEqual({
      ok: false,
      reason: "inactive",
      message: LABOR_SERVICE_MISSING_MESSAGE,
    });
    expect(await read([service("7", "mhm.25plfe", "Project Labor From Estimate")])).toMatchObject({
      ok: true,
      code: LABOR_SERVICE_CODE,
      name: "Project Labor From Estimate",
      stId: "7",
    });
    expect(
      await read([
        service("1", "OTHER", "Other"),
        service("8", "mhm.25plfe", "  "),
      ]),
    ).toMatchObject({ ok: true, code: LABOR_SERVICE_CODE, name: LABOR_SERVICE_CODE, stId: "8" });
    await expect(
      resolveStLaborCode(
        {
          sourceTenantId: "throws-500",
          readLaborService: async () => {
            throw new ServiceTitanReadError("ServiceTitan read failed (HTTP 500).");
          },
        },
        10,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "read_failed",
      message: LABOR_SERVICE_READ_FAILED_MESSAGE,
    });
    await expect(
      resolveStLaborCode(
        {
          sourceTenantId: "throws-403",
          readLaborService: async () => {
            throw new ServiceTitanReadError("ServiceTitan read failed (HTTP 403).");
          },
        },
        10,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "read_failed",
      message: LABOR_SERVICE_READ_FAILED_MESSAGE,
    });
  });

  it("logs a read failure once per process, not on a cached miss", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    const client = {
      sourceTenantId: "log-once",
      readLaborService: async () => ({ services: [] as PricebookServiceRow[] }),
    };
    try {
      await resolveStLaborCode(client, 10);
      await resolveStLaborCode(client, 11);
      expect(errors).toEqual([LABOR_SERVICE_MISSING_MESSAGE]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("stamping the pricebook labor code", () => {
  let h: Harness;
  let tenant: TenantFixture;
  let activeId: string;
  let doneId: string;
  let mode: "found" | "missing" | "inactive" | "throw" | "rename" = "found";
  let reads = 0;

  const sources: SourceConnections = {
    serviceTitan: {
      tenantId: "00000000-0000-4000-8000-0000000000aa",
      externalSystemId: "00000000-0000-4000-8000-0000000000bb",
      key: "st:labor-code",
      client: {
        sourceTenantId: "st-labor-suite",
        readJob: async () => {
          throw new Error("appointment fallback should not run");
        },
        readJobTimesheets: async (jobId: string) => ({
          jobId,
          forbidden: false,
          timesheets: [],
        }),
        readLaborService: async () => {
          reads += 1;
          if (mode === "throw") throw new ServiceTitanReadError("ServiceTitan read failed (HTTP 500).");
          if (mode === "missing") return { services: [] };
          if (mode === "inactive") return { services: [service("91025", LABOR_SERVICE_CODE, "Project Labor From Estimate", false)] };
          if (mode === "rename") return { services: [service("91025", "mhm.25plfe", "Crew labor")] };
          return { services: [service("91025")] };
        },
      },
    },
  };

  beforeAll(async () => {
    h = await startHarness(SCHEMA_FILES, sources);
    tenant = await createTenant(h, { slug: "st-labor" });
    sources.serviceTitan!.tenantId = tenant.id;
    const owner = h.as(tenant.staff.owner!.token);
    const created = async (number: string) => {
      const res = await owner.post("/api/v1/projects/projects").send(
        projectBody({ project_number: number, name: number, scheduled_start: "2026-10-19" }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.data.id as string;
    };
    activeId = await created("L-1");
    doneId = await created("L-9");
    await h.db.withTenant(tenant.id, async (db) => {
      await db.query(
        `UPDATE projects.projects
            SET stage = 'complete'::projects.project_stage,
                field_start = '2026-10-20',
                field_start_source = 'manual',
                field_start_observed_at = now(),
                field_start_set_by = $2
          WHERE id = $1`,
        [doneId, tenant.staff.owner!.id],
      );
      await db.query(
        `UPDATE projects.projects
            SET field_start = '2026-10-21',
                field_start_source = 'manual',
                field_start_observed_at = now(),
                field_start_set_by = $2
          WHERE id = $1`,
        [activeId, tenant.staff.owner!.id],
      );
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    clearStLaborCodeCache();
    resetLaborCodeErrorLog();
    mode = "found";
    reads = 0;
    await h.db.withTenant(tenant.id, (db) =>
      db.query(`DELETE FROM projects.labor_actuals WHERE tenant_id = $1`, [tenant.id]),
    );
  });

  async function putHours(projectId: string, timesheetId: string) {
    await h.db.withTenant(tenant.id, (db) =>
      storeJobLabor(db, {
        tenantId: tenant.id,
        projectId,
        jobId: "900",
        jobLinkId: null,
        observedAt: new Date("2026-10-25T12:00:00Z"),
        result: {
          jobId: "900",
          outcome: "timesheet",
          drafts: [
            {
              externalTimesheetId: timesheetId,
              externalAppointmentId: null,
              externalTechnicianId: "tech-1",
              technicianName: "Casey Nguyen",
              workDate: "2026-10-23",
              hours: 4,
              source: "timesheet",
            },
          ],
        },
      }),
    );
  }

  async function codes(projectId: string) {
    return h.db.withTenant(tenant.id, (db) =>
      db.query<{ cost_code_id: string | null; code: string | null; description: string | null; external_source: string | null }>(
        `SELECT a.cost_code_id::text, c.code, c.description, c.external_source
           FROM projects.labor_actuals a
           LEFT JOIN projects.cost_codes c ON c.id = a.cost_code_id
          WHERE a.project_id = $1`,
        [projectId],
      ),
    );
  }

  it("codes every project, including a completed one, and leaves start dates alone", async () => {
    await putHours(activeId, "ts-active");
    await putHours(doneId, "ts-done");
    const owner = h.as(tenant.staff.owner!.token);
    const refreshed = await owner.post(`/api/v1/projects/projects/${activeId}/labor/refresh`);
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body.data.st_labor_code).toEqual({
      code: LABOR_SERVICE_CODE,
      name: "Project Labor From Estimate",
      st_id: "91025",
    });
    expect(refreshed.body.data.st_labor_code_error).toBeNull();
    expect(refreshed.body.data.uncoded_hours).toBe(0);
    expect(refreshed.body.data.cost_code.code).toBe(LABOR_SERVICE_CODE);

    const active = await codes(activeId);
    const done = await codes(doneId);
    expect(active.rows[0]?.code).toBe(LABOR_SERVICE_CODE);
    expect(active.rows[0]?.external_source).toBe(LABOR_SERVICE_SOURCE);
    expect(done.rows[0]?.cost_code_id).toBe(active.rows[0]?.cost_code_id);
    expect(done.rows[0]?.code).toBe(LABOR_SERVICE_CODE);

    const dates = await h.db.withTenant(tenant.id, (db) =>
      db.query<{ id: string; scheduled_start: string; field_start: string; field_start_source: string; stage: string }>(
        `SELECT id::text, scheduled_start::text AS scheduled_start, field_start::text AS field_start,
                field_start_source, stage::text AS stage
           FROM projects.projects
          WHERE id = ANY($1::uuid[])`,
        [[activeId, doneId]],
      ),
    );
    const byId = new Map(dates.rows.map((row) => [row.id, row]));
    expect(byId.get(activeId)).toMatchObject({
      scheduled_start: "2026-10-19",
      field_start: "2026-10-21",
      field_start_source: "manual",
    });
    expect(byId.get(doneId)).toMatchObject({
      scheduled_start: "2026-10-19",
      field_start: "2026-10-20",
      field_start_source: "manual",
      stage: "complete",
    });

    clearStLaborCodeCache();
    mode = "rename";
    const again = await owner.post(`/api/v1/projects/projects/${activeId}/labor/refresh`);
    expect(again.status).toBe(200);
    expect(again.body.data.st_labor_code.name).toBe("Crew labor");
    const renamed = await codes(activeId);
    expect(renamed.rows[0]?.description).toBe("Crew labor");
    expect(renamed.rows[0]?.code).toBe(LABOR_SERVICE_CODE);
    expect(renamed.rows[0]?.cost_code_id).toBe(active.rows[0]?.cost_code_id);
  });

  it("codes the burden and the unbudgeted row, then the labor budget line", async () => {
    await h.db.withTenant(tenant.id, (db) =>
      storeTechnicianRates(
        db,
        tenant.id,
        [{ id: "tech-1", name: "Casey Nguyen", active: true, hourlyRate: 40, burdenRate: 12 }],
        new Date("2026-10-25T12:00:00Z"),
      ),
    );
    await putHours(activeId, "ts-priced");
    const owner = h.as(tenant.staff.owner!.token);
    const refreshed = await owner.post(`/api/v1/projects/projects/${activeId}/labor/refresh`);
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body.data.labor_wage).toBe(160);
    expect(refreshed.body.data.labor_burden).toBe(48);
    expect(refreshed.body.data.total).toBe(208);

    const open = await owner.get(`/api/v1/projects/projects/${activeId}/cost-position`);
    expect(open.status).toBe(200);
    const unbudgeted = (open.body.data as Array<Record<string, unknown>>).find(
      (row) => row.description === "Unbudgeted labor",
    );
    expect(unbudgeted).toMatchObject({
      cost_code: LABOR_SERVICE_CODE,
      description: "Unbudgeted labor",
      cost_type: "L",
      baseline: 0,
      budget_amount: 0,
      actual_cost: 208,
      labor_wage: 160,
      labor_burden: 48,
    });

    const codeId = (await codes(activeId)).rows[0]?.cost_code_id;
    const added = await owner.post(`/api/v1/projects/projects/${activeId}/budget`).send({
      cost_code_id: codeId,
      cost_type: "L",
      budget_amount: 4800,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const closed = await owner.get(`/api/v1/projects/projects/${activeId}/cost-position`);
    const rows = closed.body.data as Array<Record<string, unknown>>;
    expect(rows.find((row) => row.description === "Unbudgeted labor")).toBeUndefined();
    expect(rows.find((row) => row.cost_code === LABOR_SERVICE_CODE && row.cost_type === "L")).toMatchObject({
      description: "Project Labor From Estimate",
      actual_cost: 208,
      labor_wage: 160,
      labor_burden: 48,
      budget_amount: 4800,
    });
  });

  it("retires a payroll labor-type row without deleting it or clearing the stamp", async () => {
    await putHours(activeId, "ts-retire");
    const oldId = await h.db.withTenant(tenant.id, async (db) => {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO projects.cost_codes
           (tenant_id, code, division_code, division_name, description,
            default_cost_type, sort_order, active, external_source, external_id)
         VALUES ($1, 'ST-LAB', 'ST', 'ServiceTitan', 'Field labor', 'L'::projects.cost_type,
                 0, true, 'servicetitan_labor_type', '9001')
         ON CONFLICT (tenant_id, code) DO UPDATE
           SET active = true, external_source = 'servicetitan_labor_type'
         RETURNING id::text`,
        [tenant.id],
      );
      await db.query(
        `UPDATE projects.labor_actuals SET cost_code_id = $2 WHERE project_id = $1`,
        [activeId, inserted.rows[0]!.id],
      );
      return inserted.rows[0]!.id;
    });
    const owner = h.as(tenant.staff.owner!.token);
    const refreshed = await owner.post(`/api/v1/projects/projects/${activeId}/labor/refresh`);
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    const stored = await codes(activeId);
    expect(stored.rows[0]?.code).toBe(LABOR_SERVICE_CODE);
    expect(stored.rows[0]?.cost_code_id).not.toBe(oldId);
    const retired = await h.db.withTenant(tenant.id, (db) =>
      db.query<{ id: string; active: boolean; external_source: string }>(
        `SELECT id::text, active, external_source FROM projects.cost_codes WHERE id = $1`,
        [oldId],
      ),
    );
    expect(retired.rows[0]).toMatchObject({
      id: oldId,
      active: false,
      external_source: "servicetitan_labor_type",
    });
  });

  it("leaves hours uncoded when the service is missing, inactive, or unread, and keeps an earlier stamp", async () => {
    await putHours(activeId, "ts-open");
    const owner = h.as(tenant.staff.owner!.token);
    for (const next of ["missing", "inactive", "throw"] as const) {
      clearStLaborCodeCache();
      resetLaborCodeErrorLog();
      mode = next;
      const refreshed = await owner.post(`/api/v1/projects/projects/${activeId}/labor/refresh`);
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
      expect(refreshed.body.data.st_labor_code).toBeNull();
      expect(refreshed.body.data.uncoded_hours).toBe(4);
      if (next === "throw") {
        expect(refreshed.body.data.st_labor_code_error).toBe(LABOR_SERVICE_READ_FAILED_MESSAGE);
      } else {
        expect(refreshed.body.data.st_labor_code_error).toBe(LABOR_SERVICE_MISSING_MESSAGE);
      }
      expect((await codes(activeId)).rows[0]?.cost_code_id).toBeNull();
    }

    mode = "found";
    clearStLaborCodeCache();
    const coded = await owner.post(`/api/v1/projects/projects/${activeId}/labor/refresh`);
    expect(coded.body.data.st_labor_code.code).toBe(LABOR_SERVICE_CODE);
    const kept = (await codes(activeId)).rows[0]?.cost_code_id;
    expect(kept).toBeTruthy();

    mode = "missing";
    clearStLaborCodeCache();
    const again = await owner.post(`/api/v1/projects/projects/${activeId}/labor/refresh`);
    expect(again.body.data.st_labor_code).toBeNull();
    expect(again.body.data.st_labor_code_error).toBe(LABOR_SERVICE_MISSING_MESSAGE);
    expect((await codes(activeId)).rows[0]?.cost_code_id).toBe(kept);
  });

  it("reads the service once per refresh run and logs a failure once per process", async () => {
    await putHours(activeId, "ts-run");
    const second = await h.as(tenant.staff.owner!.token).post("/api/v1/projects/projects").send(
      projectBody({ project_number: "L-2", name: "L-2", scheduled_start: "2026-10-19" }),
    );
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const secondId = second.body.data.id as string;
    await putHours(secondId, "ts-run-2");

    reads = 0;
    clearStLaborCodeCache();
    const report = await runHourlyLaborRefresh(h.db, sources.serviceTitan!, {
      tenantId: tenant.id,
      gapMs: 0,
      sleep: async () => undefined,
    });
    expect(report.failed).toEqual([]);
    expect(report.refreshed.sort()).toEqual([activeId, secondId].sort());
    expect(reads).toBe(1);
    expect(formatLaborRefreshRun(report)).toBe(
      "Labor refresh run: 2 refreshed, 0 failed; labor code: MHM.25PLFE Project Labor From Estimate",
    );
    expect((await codes(activeId)).rows[0]?.code).toBe(LABOR_SERVICE_CODE);
    expect((await codes(secondId)).rows[0]?.code).toBe(LABOR_SERVICE_CODE);

    mode = "missing";
    clearStLaborCodeCache();
    resetLaborCodeErrorLog();
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const firstFail = await runHourlyLaborRefresh(h.db, sources.serviceTitan!, {
        tenantId: tenant.id,
        gapMs: 0,
        sleep: async () => undefined,
      });
      const secondFail = await runHourlyLaborRefresh(h.db, sources.serviceTitan!, {
        tenantId: tenant.id,
        gapMs: 0,
        sleep: async () => undefined,
      });
      expect(firstFail.failed).toEqual([]);
      expect(secondFail.failed).toEqual([]);
      expect(formatLaborRefreshRun(firstFail)).toBe(
        `Labor refresh run: 2 refreshed, 0 failed; labor code: ${LABOR_SERVICE_MISSING_MESSAGE}`,
      );
    } finally {
      spy.mockRestore();
    }
    expect(errors.filter((line) => line.includes(LABOR_SERVICE_CODE))).toEqual([
      LABOR_SERVICE_MISSING_MESSAGE,
    ]);
    expect((await codes(activeId)).rows[0]?.code).toBe(LABOR_SERVICE_CODE);
  });

  it("refuses a code that already exists as a Journeyman cost code", async () => {
    await h.db.withTenant(tenant.id, (db) =>
      db.query(
        `INSERT INTO projects.cost_codes
           (tenant_id, code, division_code, division_name, description,
            default_cost_type, sort_order, active, external_source)
         VALUES ($1, $2, 'ST', 'ServiceTitan', 'User entered labor', 'L'::projects.cost_type, 0, true, NULL)
         ON CONFLICT (tenant_id, code) DO UPDATE
           SET external_source = NULL,
               external_id = NULL,
               description = 'User entered labor',
               active = true`,
        [tenant.id, LABOR_SERVICE_CODE],
      ),
    );
    await putHours(activeId, "ts-collision");
    mode = "found";
    clearStLaborCodeCache();
    const owner = h.as(tenant.staff.owner!.token);
    const refreshed = await owner.post(`/api/v1/projects/projects/${activeId}/labor/refresh`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.st_labor_code).toBeNull();
    expect(refreshed.body.data.st_labor_code_error).toBe(laborCodeCollisionMessage(LABOR_SERVICE_CODE));
    expect(refreshed.body.data.uncoded_hours).toBe(4);
    const seeded = await h.db.withTenant(tenant.id, (db) =>
      db.query<{ description: string; external_source: string | null }>(
        `SELECT description, external_source FROM projects.cost_codes WHERE code = $1`,
        [LABOR_SERVICE_CODE],
      ),
    );
    expect(seeded.rows[0]).toEqual({
      description: "User entered labor",
      external_source: null,
    });
    await h.db.withTenant(tenant.id, (db) =>
      db.query(
        `UPDATE projects.cost_codes
            SET external_source = $3, description = 'Project Labor From Estimate', active = true
          WHERE tenant_id = $1 AND code = $2`,
        [tenant.id, LABOR_SERVICE_CODE, LABOR_SERVICE_SOURCE],
      ),
    );
    const settings = await owner.put("/api/v1/projects/settings/labor").send({ labor_cost_code_id: null });
    expect(settings.status).toBe(404);
    const override = await owner
      .put(`/api/v1/projects/projects/${activeId}/labor-cost-code`)
      .send({ cost_code_id: null });
    expect(override.status).toBe(404);
  });

  it("retires the old mirror in place and does not add a check constraint", () => {
    const current = SCHEMA_FILES.find((item) => item.endsWith("048_pricebook_labor_code.sql"));
    expect(current).toBeTruthy();
    const sql = readFileSync(current!, "utf8");
    expect(sql).toMatch(/servicetitan_labor_type/);
    expect(sql).toMatch(/SET active = false/);
    expect(sql).toMatch(/labor_wage/);
    expect(sql).toMatch(/labor_burden/);
    expect(sql).toMatch(/Unbudgeted labor/);
    expect(sql).not.toMatch(/ADD CONSTRAINT/i);
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/scheduled_start/);

    const previous = SCHEMA_FILES.find((item) => item.endsWith("046_st_labor_code.sql"));
    const old = readFileSync(previous!, "utf8");
    expect(old).toMatch(/external_source/);
    expect(old).toMatch(/external_id/);
    expect(old).not.toMatch(/DELETE FROM/i);
    expect(old).not.toMatch(/DROP COLUMN/i);
  });
});
