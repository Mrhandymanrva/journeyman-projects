import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ServiceTitanReadError } from "../src/adapters/serviceTitan.js";
import { draftsFromTimesheets, stampLaborCodes, storeJobLabor, storeTechnicianRates } from "../src/domain/laborActuals.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import { SCHEMA_FILES, createTenant, estimatePayload, projectBody, startHarness, type Harness, type TenantFixture } from "./support/harness.js";

let h: Harness;
let t: TenantFixture;
let projectId: string;
let laborCodeId: string;
let n = 0;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  t = await createTenant(h, { slug: `labor-${n++}` });
  const imported = await owner().post("/api/v1/projects/estimate-imports").send(estimatePayload());
  const created = await owner()
    .post("/api/v1/projects/projects")
    .send(
      projectBody({
        estimate_import_id: imported.body.data.id,
        source_kind: "journeyman_estimate",
        contract_value: 41800,
      }),
    );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  projectId = created.body.data.id;
  const codes = await owner().get("/api/v1/projects/cost-codes");
  laborCodeId = (codes.body.data as Array<{ id: string; code: string }>).find((row) => row.code === "210")!.id;
  const budget = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
  const hasLabor = (budget.body.data.lines as Array<{ cost_code_id: string; cost_type: string }>).some(
    (line) => line.cost_code_id === laborCodeId && line.cost_type === "L",
  );
  if (!hasLabor) {
    const added = await owner().post(`/api/v1/projects/projects/${projectId}/budget`).send({
      cost_code_id: laborCodeId,
      cost_type: "L",
      budget_amount: 2200,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
  }
});

const owner = () => h.as(t.staff.owner!.token);
const pm = () => h.as(t.staff.pm!.token);
const office = () => h.as(t.staff.office!.token);

describe("labor actuals", () => {
  it("uses payroll paid hours and ignores clock times and a cancelled row", () => {
    const drafts = draftsFromTimesheets([
      {
        id: "9",
        appointmentId: "4",
        technicianId: "6",
        technicianName: "Alex",
        arrivedOn: "2026-09-15T16:00:00Z",
        dispatchedOn: null,
        doneOn: "2026-09-15T19:30:00Z",
        canceledOn: null,
        paidDurationHours: 3.5,
      },
      {
        id: "10",
        appointmentId: null,
        technicianId: "7",
        technicianName: "Bea",
        arrivedOn: "2026-09-15T16:00:00Z",
        dispatchedOn: null,
        doneOn: "2026-09-15T18:00:00Z",
        canceledOn: "2026-09-15T17:00:00Z",
        paidDurationHours: 2,
      },
      {
        id: "11",
        appointmentId: "5",
        technicianId: "8",
        technicianName: "Cam",
        arrivedOn: "2026-09-15T16:00:00Z",
        dispatchedOn: null,
        doneOn: "2026-09-15T20:00:00Z",
        canceledOn: null,
        paidDurationHours: null,
      },
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.hours).toBe(3.5);
    expect(drafts[0]?.workDate).toBe("2026-09-15");
    expect(drafts[0]?.source).toBe("timesheet");
  });

  it("posts wage and burden from the technician profile and hides rates from other roles", async () => {
    const saved = await owner().get("/api/v1/projects/settings/labor");
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.st_labor_code).toBeNull();
    expect(saved.body.data.st_labor_code_error).toMatch(/labor hours are uncoded/);
    expect(saved.body.data).not.toHaveProperty("labor_cost_code_id");
    expect(saved.body.data).not.toHaveProperty("labor_burdened_hourly_rate");

    await h.db.withTenant(t.id, async (db) => {
      await db.query(
        `UPDATE projects.tenant_settings SET labor_burdened_hourly_rate = 999 WHERE tenant_id = $1`,
        [t.id],
      );
      await storeJobLabor(db, {
        tenantId: t.id,
        projectId,
        jobId: "900",
        jobLinkId: null,
        observedAt: new Date("2026-10-25T12:00:00Z"),
        result: {
          jobId: "900",
          outcome: "timesheet",
          drafts: [
            {
              externalTimesheetId: "ts-1",
              externalAppointmentId: null,
              externalTechnicianId: "tech-1",
              technicianName: "Casey Nguyen",
              workDate: "2026-10-23",
              hours: 4,
              source: "timesheet",
            },
            {
              externalTimesheetId: "ts-2",
              externalAppointmentId: null,
              externalTechnicianId: "tech-2",
              technicianName: "Jordan Hale",
              workDate: "2026-10-23",
              hours: 2,
              source: "timesheet",
            },
          ],
        },
      });
      await stampLaborCodes(db, t.id, laborCodeId);
      await storeTechnicianRates(
        db,
        t.id,
        [
          { id: "tech-1", name: "Casey Nguyen", active: true, hourlyRate: 40, burdenRate: 12 },
          { id: "tech-2", name: "Jordan Hale", active: true, hourlyRate: 36, burdenRate: 0 },
          { id: "tech-3", name: "Riley Cho", active: true, hourlyRate: 0, burdenRate: 8 },
        ],
        new Date("2026-10-25T12:00:00Z"),
      );
    });

    const shown = await owner().get(`/api/v1/projects/projects/${projectId}/labor`);
    expect(shown.body.data.hours).toBe(6);
    expect(shown.body.data.labor_wage).toBe(232);
    expect(shown.body.data.labor_burden).toBe(48);
    expect(shown.body.data.total).toBe(280);
    expect(shown.body.data.uncoded_hours).toBe(0);
    expect(shown.body.data.billable_rate).toBe(188);
    const casey = shown.body.data.technicians.find(
      (tech: { technician_name: string }) => tech.technician_name === "Casey Nguyen",
    );
    expect(casey).toMatchObject({ hours: 4, pay_basis: "hourly", wage: 160, burden: 48 });
    expect(casey).not.toHaveProperty("hourly_rate");
    expect(casey).not.toHaveProperty("burden_rate");
    const jordan = shown.body.data.technicians.find(
      (tech: { technician_name: string }) => tech.technician_name === "Jordan Hale",
    );
    expect(jordan).toMatchObject({ hours: 2, pay_basis: "hourly", wage: 72, burden: null, burden_unset: true });
    expect(jordan).not.toHaveProperty("missing");
    expect(jordan.notices).toEqual(["burden not set for Jordan Hale"]);
    expect(shown.body.data.missing).toEqual([]);
    expect(shown.body.data).not.toHaveProperty("rate_gaps");
    expect(shown.body.data).not.toHaveProperty("burden_notices");
    const settings = await owner().get("/api/v1/projects/settings/labor");
    expect(settings.body.data.rate_gaps.map((gap: { technician_name: string }) => gap.technician_name)).toEqual([
      "Riley Cho",
    ]);
    expect(settings.body.data.burden_notices.map((gap: { technician_name: string }) => gap.technician_name)).toEqual([
      "Jordan Hale",
    ]);

    const coordinator = await pm().get(`/api/v1/projects/projects/${projectId}/labor`);
    expect(coordinator.body.data.labor_wage).toBe(232);
    expect(coordinator.body.data.total).toBe(280);
    expect(coordinator.body.data.missing).toEqual([]);
    expect(coordinator.body.data).not.toHaveProperty("rate_gaps");
    for (const tech of coordinator.body.data.technicians) {
      expect(tech).not.toHaveProperty("hourly_rate");
      expect(tech).not.toHaveProperty("burden_rate");
      expect(tech).not.toHaveProperty("wage");
    }

    const hidden = await office().get(`/api/v1/projects/projects/${projectId}/labor`);
    expect(hidden.status).toBe(200);
    expect(hidden.body.data.hours).toBe(6);
    expect(hidden.body.data.labor_wage).toBeUndefined();
    expect(hidden.body.data.total).toBeUndefined();
    expect(hidden.body.data).not.toHaveProperty("rate_gaps");
    for (const tech of hidden.body.data.technicians) {
      expect(tech).not.toHaveProperty("hourly_rate");
      expect(tech).not.toHaveProperty("burden_rate");
      expect(tech).not.toHaveProperty("wage");
    }

    const cost = await owner().get(`/api/v1/projects/projects/${projectId}/cost-position`);
    const row = (cost.body.data as Array<{ cost_code: string; cost_type: string; actual_cost: number }>).find(
      (line) => line.cost_code === "210" && line.cost_type === "L",
    );
    expect(Number(row?.actual_cost)).toBe(280);
    expect(row).toMatchObject({
      lines: [
        { description: "Labor", amount: 232 },
        { description: "Labor burden", amount: 48 },
      ],
    });

    const removed = await owner().put("/api/v1/projects/settings/labor").send({
      labor_cost_code_id: null,
    });
    expect(removed.status).toBe(404);
  });

  it("leaves hours uncoded until a cost code is set, and a later payroll miss does not replace timesheets", async () => {
    await h.db.withTenant(t.id, async (db) => {
      await storeJobLabor(db, {
        tenantId: t.id,
        projectId,
        jobId: "900",
        jobLinkId: null,
        observedAt: new Date("2026-10-25T12:00:00Z"),
        result: {
          jobId: "900",
          outcome: "timesheet",
          drafts: [
            {
              externalTimesheetId: "ts-keep",
              externalAppointmentId: null,
              externalTechnicianId: "tech-1",
              technicianName: "Alex",
              workDate: "2026-10-23",
              hours: 2,
              source: "timesheet",
            },
          ],
        },
      });
      await storeJobLabor(db, {
        tenantId: t.id,
        projectId,
        jobId: "900",
        jobLinkId: null,
        observedAt: new Date("2026-10-25T13:00:00Z"),
        result: {
          jobId: "900",
          outcome: "appointment_window",
          drafts: [
            {
              externalTimesheetId: null,
              externalAppointmentId: "ap-1",
              externalTechnicianId: "tech-1",
              technicianName: "Alex",
              workDate: "2026-10-23",
              hours: 8,
              source: "appointment_window",
            },
          ],
        },
      });
    });
    const shown = await owner().get(`/api/v1/projects/projects/${projectId}/labor`);
    expect(shown.body.data.hours).toBe(2);
    expect(shown.body.data.uncoded_hours).toBe(2);
    expect(shown.body.data.labor_wage).toBe(0);
    expect(shown.body.data.total).toBe(0);
    expect(shown.body.data.missing).toEqual([
      "No ServiceTitan commission percent or hourly rate for Alex",
    ]);
    expect(shown.body.data.lines).toHaveLength(1);
    expect(shown.body.data.lines[0].source).toBe("timesheet");
  });

  it("does not offer a labor-code picker and leaves the budget and start dates alone", async () => {
    await h.db.withTenant(t.id, async (db) => {
      await db.query(
        `UPDATE projects.projects
            SET scheduled_start = '2026-10-19',
                field_start = '2026-10-20',
                field_start_source = 'manual',
                field_start_observed_at = now(),
                field_start_set_by = $2
          WHERE id = $1`,
        [projectId, t.staff.owner!.id],
      );
    });
    const before = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
    const putSettings = await owner()
      .put("/api/v1/projects/settings/labor")
      .send({ labor_cost_code_id: laborCodeId });
    expect(putSettings.status).toBe(404);
    const putProject = await owner()
      .put(`/api/v1/projects/projects/${projectId}/labor-cost-code`)
      .send({ cost_code_id: laborCodeId });
    expect(putProject.status).toBe(404);
    const coordinator = await pm()
      .put(`/api/v1/projects/projects/${projectId}/labor-cost-code`)
      .send({ cost_code_id: null });
    expect(coordinator.status).toBe(404);
    const refresh = await owner().post(`/api/v1/projects/projects/${projectId}/labor/refresh`);
    expect(refresh.status).toBe(409);
    const after = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
    expect(after.body.data.lines).toEqual(before.body.data.lines);
    const dates = await h.db.withTenant(t.id, (db) =>
      db.query<{ scheduled_start: string; field_start: string; field_start_source: string }>(
        `SELECT scheduled_start::text AS scheduled_start,
                field_start::text AS field_start,
                field_start_source
           FROM projects.projects WHERE id = $1`,
        [projectId],
      ),
    );
    expect(dates.rows[0]).toMatchObject({
      scheduled_start: "2026-10-19",
      field_start: "2026-10-20",
      field_start_source: "manual",
    });
    expect(SCHEMA_FILES.some((file) => file.endsWith("040_labor_actuals.sql"))).toBe(true);
    expect(SCHEMA_FILES.some((file) => file.endsWith("043_technician_labor_rates.sql"))).toBe(true);
    expect(SCHEMA_FILES.some((file) => file.endsWith("046_st_labor_code.sql"))).toBe(true);
  });
});

describe("a denied technician read", () => {
  let h2: Harness;
  let mode: "forbidden" | "rates" = "forbidden";
  const sources: SourceConnections = {
    serviceTitan: {
      tenantId: "00000000-0000-4000-8000-000000000010",
      externalSystemId: "00000000-0000-4000-8000-000000000011",
      key: "st:test",
      client: {
        readJob: async () => {
          throw new Error("unused");
        },
        sourceTenantId: "labor-403",
        readLaborService: async () => ({
          services: [
            {
              id: "91025",
              code: "MHM.25PLFE",
              name: "Project Labor From Estimate",
              active: true,
            },
          ],
        }),
        readJobTimesheets: async () => ({ jobId: "1", forbidden: true, timesheets: [] }),
        readTechnicians: async () => {
          if (mode === "forbidden") {
            throw new ServiceTitanReadError("ServiceTitan read failed (HTTP 403).");
          }
          return [
            {
              id: "tech-casey",
              name: "Casey Nguyen",
              active: true,
              hourlyRate: 40,
              burdenRate: 12,
              commissionRate: null,
            },
          ];
        },
      },
    },
  };

  beforeAll(async () => {
    h2 = await startHarness(SCHEMA_FILES, sources);
  });
  afterAll(async () => {
    await h2?.close();
  });

  it("keeps hours, posts no dollars, and prices them after a later read", async () => {
    const tenant = await createTenant(h2, { slug: "labor-403" });
    const asOwner = h2.as(tenant.staff.owner!.token);
    const imported = await asOwner.post("/api/v1/projects/estimate-imports").send(estimatePayload());
    const created = await asOwner.post("/api/v1/projects/projects").send(
      projectBody({
        estimate_import_id: imported.body.data.id,
        source_kind: "journeyman_estimate",
        contract_value: 41800,
      }),
    );
    const id = created.body.data.id as string;
    const codes = await asOwner.get("/api/v1/projects/cost-codes");
    const codeId = (codes.body.data as Array<{ id: string; code: string }>).find((row) => row.code === "210")!.id;
    const budget = await asOwner.get(`/api/v1/projects/projects/${id}/budget`);
    const hasLabor = (budget.body.data.lines as Array<{ cost_code_id: string; cost_type: string }>).some(
      (line) => line.cost_code_id === codeId && line.cost_type === "L",
    );
    if (!hasLabor) {
      expect(
        (await asOwner.post(`/api/v1/projects/projects/${id}/budget`).send({
          cost_code_id: codeId,
          cost_type: "L",
          budget_amount: 2200,
        })).status,
      ).toBe(201);
    }
    await h2.db.withTenant(tenant.id, async (db) => {
      await storeJobLabor(db, {
        tenantId: tenant.id,
        projectId: id,
        jobId: "900",
        jobLinkId: null,
        observedAt: new Date("2026-10-25T12:00:00Z"),
        result: {
          jobId: "900",
          outcome: "timesheet",
          drafts: [
            {
              externalTimesheetId: "ts-403",
              externalAppointmentId: null,
              externalTechnicianId: "tech-casey",
              technicianName: "Casey Nguyen",
              workDate: "2026-10-23",
              hours: 4,
              source: "timesheet",
            },
          ],
        },
      });
    });

    mode = "forbidden";
    const denied = await asOwner.post(`/api/v1/projects/projects/${id}/labor/refresh`);
    expect(denied.status, JSON.stringify(denied.body)).toBe(200);
    expect(denied.body.data.rates_forbidden).toBe(true);
    expect(denied.body.data.hours).toBe(4);
    expect(denied.body.data.labor_wage).toBe(0);
    expect(denied.body.data.labor_burden).toBe(0);
    expect(denied.body.data.total).toBe(0);
    expect(denied.body.data.missing).toEqual([
      "No ServiceTitan commission percent or hourly rate for Casey Nguyen",
    ]);
    const deniedCost = await asOwner.get(`/api/v1/projects/projects/${id}/cost-position`);
    const deniedRows = deniedCost.body.data as Array<{
      cost_code: string | null;
      description: string;
      cost_type: string;
      actual_cost: number;
    }>;
    const deniedLabor = deniedRows.find((line) => line.cost_code === "210" && line.cost_type === "L");
    expect(Number(deniedLabor?.actual_cost ?? 0)).toBe(0);
    expect(deniedRows.find((line) => line.description === "Unbudgeted labor")).toBeUndefined();

    mode = "rates";
    const priced = await asOwner.post(`/api/v1/projects/projects/${id}/labor/refresh`);
    expect(priced.status, JSON.stringify(priced.body)).toBe(200);
    expect(priced.body.data.rates_forbidden).toBe(false);
    expect(priced.body.data.labor_wage).toBe(160);
    expect(priced.body.data.labor_burden).toBe(48);
    expect(priced.body.data.total).toBe(208);
    expect(priced.body.data.source).toBe("manual");
    expect(priced.body.data.hours_source).toBe("timesheet");
    expect(typeof priced.body.data.observed_at).toBe("string");
    expect(priced.body.data.missing).toEqual([]);
    const casey = priced.body.data.technicians[0];
    expect(casey).toMatchObject({ pay_basis: "hourly", wage: 160, burden: 48 });
    expect(casey).not.toHaveProperty("hourly_rate");
    expect(casey).not.toHaveProperty("burden_rate");
    expect(priced.body.data.uncoded_hours).toBe(0);
    expect(priced.body.data.st_labor_code).toEqual({
      code: "MHM.25PLFE",
      name: "Project Labor From Estimate",
      st_id: "91025",
    });
    expect(priced.body.data.st_labor_code_error).toBeNull();
    const pricedCost = await asOwner.get(`/api/v1/projects/projects/${id}/cost-position`);
    const rows = pricedCost.body.data as Array<{
      cost_code: string | null;
      description: string;
      cost_type: string;
      baseline: number;
      budget_amount: number;
      actual_cost: number;
      labor_wage: number;
      labor_burden: number;
    }>;
    const pricedLabor = rows.find((line) => line.cost_code === "210" && line.cost_type === "L");
    expect(Number(pricedLabor?.actual_cost ?? 0)).toBe(0);
    expect(rows.find((line) => line.description === "Unbudgeted labor")).toMatchObject({
      cost_code: "MHM.25PLFE",
      description: "Unbudgeted labor",
      cost_type: "L",
      baseline: 0,
      budget_amount: 0,
      actual_cost: 208,
      labor_wage: 160,
      labor_burden: 48,
    });
  });
});
