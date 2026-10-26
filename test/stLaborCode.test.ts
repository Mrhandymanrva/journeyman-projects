import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceTitanReadError } from "../src/adapters/serviceTitan.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import { storeJobLabor } from "../src/domain/laborActuals.js";
import {
  clearStLaborCodeCache,
  laborCodeCollisionMessage,
  laborTypeCountMessage,
  resolveStLaborCode,
  ST_LABOR_CODE_FAILURE_TTL_MS,
  ST_LABOR_CODE_SUCCESS_TTL_MS,
  ST_LABOR_FORBIDDEN_MESSAGE,
  type StLaborTypeRow,
} from "../src/domain/stLaborCode.js";
import { runHourlyLaborRefresh } from "../src/workers/laborRefresh.js";
import {
  createTenant,
  projectBody,
  SCHEMA_FILES,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const type = (id: string, code: string, name = "Field labor"): StLaborTypeRow => ({
  id,
  name,
  code,
  serviceCodeId: null,
  active: true,
});

describe("ServiceTitan labor code cache", () => {
  beforeEach(() => clearStLaborCodeCache());

  it("remembers one labor type for an hour and a failure for five minutes", async () => {
    let calls = 0;
    let forbidden = false;
    const client = {
      sourceTenantId: "cache-a",
      readLaborTypes: async () => {
        calls += 1;
        return {
          forbidden,
          laborTypes: forbidden ? [] : [type("42", "ST-LAB")],
        };
      },
    };
    const start = 1_700_000_000_000;
    const first = await resolveStLaborCode(client, start);
    expect(first).toMatchObject({ ok: true, code: "ST-LAB", name: "Field labor", stId: "42" });
    forbidden = true;
    expect(await resolveStLaborCode(client, start + ST_LABOR_CODE_SUCCESS_TTL_MS - 1)).toMatchObject({
      ok: true,
      code: "ST-LAB",
    });
    expect(calls).toBe(1);
    expect(await resolveStLaborCode(client, start + ST_LABOR_CODE_SUCCESS_TTL_MS)).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
    expect(calls).toBe(2);
    const failedAt = start + ST_LABOR_CODE_SUCCESS_TTL_MS;
    expect(await resolveStLaborCode(client, failedAt + ST_LABOR_CODE_FAILURE_TTL_MS - 1)).toMatchObject({
      reason: "forbidden",
    });
    expect(calls).toBe(2);
    forbidden = false;
    expect(await resolveStLaborCode(client, failedAt + ST_LABOR_CODE_FAILURE_TTL_MS)).toMatchObject({
      ok: true,
      code: "ST-LAB",
    });
    expect(calls).toBe(3);
  });

  it("does not share a cached code across ServiceTitan tenants", async () => {
    const seen: string[] = [];
    const clientFor = (tenant: string, code: string) => ({
      sourceTenantId: tenant,
      readLaborTypes: async () => {
        seen.push(tenant);
        return { forbidden: false, laborTypes: [type(tenant, code)] };
      },
    });
    const now = 50_000;
    expect(await resolveStLaborCode(clientFor("ten-a", "A"), now)).toMatchObject({ code: "A" });
    expect(await resolveStLaborCode(clientFor("ten-b", "B"), now)).toMatchObject({ code: "B" });
    expect(await resolveStLaborCode(clientFor("ten-a", "A"), now)).toMatchObject({ code: "A" });
    expect(seen).toEqual(["ten-a", "ten-b"]);
  });

  it("returns none, many, forbidden, and a blank code without throwing", async () => {
    const read = async (laborTypes: StLaborTypeRow[], forbidden = false) =>
      resolveStLaborCode(
        {
          sourceTenantId: `shape-${laborTypes.map((row) => `${row.id}:${row.code}:${row.active}`).join(",") || "empty"}-${forbidden}`,
          readLaborTypes: async () => ({ forbidden, laborTypes }),
        },
        10,
      );
    expect(await read([])).toEqual({ ok: false, reason: "none", message: laborTypeCountMessage(0) });
    expect(await read([type("1", "A"), type("2", "B")])).toEqual({
      ok: false,
      reason: "many",
      message: laborTypeCountMessage(2),
    });
    expect(await read([], true)).toEqual({
      ok: false,
      reason: "forbidden",
      message: ST_LABOR_FORBIDDEN_MESSAGE,
    });
    const inactive = await read([{ ...type("1", "A"), active: false }, type("2", "ST-LAB")]);
    expect(inactive).toMatchObject({ ok: true, code: "ST-LAB", stId: "2" });
    const blank = await read([type("1", "  ")]);
    expect(blank).toMatchObject({ ok: false, reason: "read_failed" });
    await expect(
      resolveStLaborCode(
        {
          sourceTenantId: "throws-403",
          readLaborTypes: async () => {
            throw new ServiceTitanReadError("ServiceTitan read failed (HTTP 403).");
          },
        },
        10,
      ),
    ).resolves.toMatchObject({ ok: false, reason: "forbidden", message: ST_LABOR_FORBIDDEN_MESSAGE });
    await expect(
      resolveStLaborCode(
        {
          sourceTenantId: "throws-500",
          readLaborTypes: async () => {
            throw new ServiceTitanReadError("ServiceTitan read failed (HTTP 500).");
          },
        },
        10,
      ),
    ).resolves.toMatchObject({ ok: false, reason: "read_failed" });
  });
});

describe("stamping the ServiceTitan labor code", () => {
  let h: Harness;
  let tenant: TenantFixture;
  let activeId: string;
  let doneId: string;
  let mode: "one" | "none" | "many" | "forbidden" | "throw" | "collision" | "rename" = "one";

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
        readLaborTypes: async () => {
          if (mode === "throw") throw new ServiceTitanReadError("ServiceTitan read failed (HTTP 500).");
          if (mode === "forbidden") return { forbidden: true, laborTypes: [] };
          if (mode === "none") return { forbidden: false, laborTypes: [] };
          if (mode === "many") {
            return { forbidden: false, laborTypes: [type("1", "ST-LAB"), type("2", "ST-SHOP")] };
          }
          if (mode === "collision") {
            return { forbidden: false, laborTypes: [type("9", "210", "Interior demolition — labor")] };
          }
          if (mode === "rename") return { forbidden: false, laborTypes: [type("42", "ST-LAB", "Crew labor")] };
          return { forbidden: false, laborTypes: [type("42", "ST-LAB")] };
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
    mode = "one";
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
      code: "ST-LAB",
      name: "Field labor",
      st_id: "42",
    });
    expect(refreshed.body.data.st_labor_code_error).toBeNull();
    expect(refreshed.body.data.uncoded_hours).toBe(0);
    expect(refreshed.body.data.cost_code.code).toBe("ST-LAB");

    const active = await codes(activeId);
    const done = await codes(doneId);
    expect(active.rows[0]?.code).toBe("ST-LAB");
    expect(active.rows[0]?.external_source).toBe("servicetitan_labor_type");
    expect(done.rows[0]?.cost_code_id).toBe(active.rows[0]?.cost_code_id);
    expect(done.rows[0]?.code).toBe("ST-LAB");

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
    expect(renamed.rows[0]?.cost_code_id).toBe(active.rows[0]?.cost_code_id);
  });

  it("leaves hours uncoded for none, many, forbidden, and a failed read, and the hourly job continues", async () => {
    await putHours(activeId, "ts-open");
    await putHours(doneId, "ts-closed");
    const owner = h.as(tenant.staff.owner!.token);
    for (const next of ["none", "many", "forbidden", "throw"] as const) {
      clearStLaborCodeCache();
      mode = next;
      const refreshed = await owner.post(`/api/v1/projects/projects/${activeId}/labor/refresh`);
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
      expect(refreshed.body.data.st_labor_code).toBeNull();
      expect(refreshed.body.data.uncoded_hours).toBe(4);
      expect(refreshed.body.data.st_labor_code_error).toMatch(/Hours stay uncoded/);
      if (next === "none") expect(refreshed.body.data.st_labor_code_error).toBe(laborTypeCountMessage(0));
      if (next === "many") expect(refreshed.body.data.st_labor_code_error).toBe(laborTypeCountMessage(2));
      if (next === "forbidden") expect(refreshed.body.data.st_labor_code_error).toBe(ST_LABOR_FORBIDDEN_MESSAGE);
      const stored = await codes(activeId);
      expect(stored.rows[0]?.cost_code_id).toBeNull();
    }

    mode = "forbidden";
    clearStLaborCodeCache();
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const report = await runHourlyLaborRefresh(h.db, sources.serviceTitan!, {
        tenantId: tenant.id,
        gapMs: 0,
        sleep: async () => undefined,
      });
      expect(report.failed).toEqual([]);
      expect(report.refreshed).toEqual([activeId]);
      expect(report.projects).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(errors.some((line) => line.includes(ST_LABOR_FORBIDDEN_MESSAGE))).toBe(true);
    expect((await codes(activeId)).rows[0]?.cost_code_id).toBeNull();
    expect((await codes(doneId)).rows[0]?.cost_code_id).toBeNull();

    mode = "throw";
    clearStLaborCodeCache();
    const second = await runHourlyLaborRefresh(h.db, sources.serviceTitan!, {
      tenantId: tenant.id,
      gapMs: 0,
      sleep: async () => undefined,
    });
    expect(second.failed).toEqual([]);
    expect(second.refreshed).toEqual([activeId]);
  });

  it("refuses a code that already exists as a Journeyman cost code", async () => {
    await putHours(activeId, "ts-collision");
    mode = "collision";
    const owner = h.as(tenant.staff.owner!.token);
    const refreshed = await owner.post(`/api/v1/projects/projects/${activeId}/labor/refresh`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.st_labor_code).toBeNull();
    expect(refreshed.body.data.st_labor_code_error).toBe(laborCodeCollisionMessage("210"));
    expect(refreshed.body.data.uncoded_hours).toBe(4);
    const seeded = await h.db.withTenant(tenant.id, (db) =>
      db.query<{ description: string; external_source: string | null }>(
        `SELECT description, external_source FROM projects.cost_codes WHERE code = '210'`,
      ),
    );
    expect(seeded.rows[0]).toEqual({
      description: "Interior demolition — labor",
      external_source: null,
    });
    const settings = await owner.put("/api/v1/projects/settings/labor").send({ labor_cost_code_id: null });
    expect(settings.status).toBe(404);
    const override = await owner
      .put(`/api/v1/projects/projects/${activeId}/labor-cost-code`)
      .send({ cost_code_id: null });
    expect(override.status).toBe(404);
  });

  it("adds the mirror columns without clearing stored hours or dropping the old columns", () => {
    const file = SCHEMA_FILES.find((item) => item.endsWith("046_st_labor_code.sql"));
    expect(file).toBeTruthy();
    const sql = readFileSync(file!, "utf8");
    expect(sql).toMatch(/external_source/);
    expect(sql).toMatch(/external_id/);
    expect(sql).toMatch(/Retired/);
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/labor_actuals/);
    expect(sql).not.toMatch(/scheduled_start/);
  });
});
