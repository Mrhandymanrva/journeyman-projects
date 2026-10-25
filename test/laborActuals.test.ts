import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { draftsFromTimesheets, stampLaborCodes, storeJobLabor } from "../src/domain/laborActuals.js";
import { SCHEMA_FILES, createTenant, estimatePayload, projectBody, startHarness, type Harness, type TenantFixture } from "./support/harness.js";
import { tickGate } from "./support/tickGate.js";

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
  it("turns a timesheet window into hours and ignores a cancelled row", () => {
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
      },
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.hours).toBe(3.5);
    expect(drafts[0]?.workDate).toBe("2026-09-15");
    expect(drafts[0]?.source).toBe("timesheet");
  });

  it("posts coded hours onto the labor budget line and hides dollars from office", async () => {
    const saved = await owner().put("/api/v1/projects/settings/labor").send({
      labor_burdened_hourly_rate: 80,
      labor_cost_code_id: laborCodeId,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.labor_cost_code).toBe("210");

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
              externalTimesheetId: "ts-1",
              externalAppointmentId: null,
              externalTechnicianId: "tech-1",
              technicianName: "Alex",
              workDate: "2026-10-23",
              hours: 4,
              source: "timesheet",
            },
          ],
        },
      });
      await stampLaborCodes(db, t.id, projectId);
    });

    const shown = await owner().get(`/api/v1/projects/projects/${projectId}/labor`);
    expect(shown.body.data.hours).toBe(4);
    expect(shown.body.data.amount).toBe(320);
    expect(shown.body.data.uncoded_hours).toBe(0);
    expect(shown.body.data.source).toBe("timesheet");

    const hidden = await office().get(`/api/v1/projects/projects/${projectId}/labor`);
    expect(hidden.status).toBe(200);
    expect(hidden.body.data.hours).toBe(4);
    expect(hidden.body.data.amount).toBeUndefined();
    expect(hidden.body.data.rate).toBeUndefined();

    const cost = await owner().get(`/api/v1/projects/projects/${projectId}/cost-position`);
    const row = (cost.body.data as Array<{ cost_code: string; cost_type: string; actual_cost: number }>).find(
      (line) => line.cost_code === "210" && line.cost_type === "L",
    );
    expect(row?.actual_cost).toBe(320);

    const refused = await pm().put("/api/v1/projects/settings/labor").send({
      labor_burdened_hourly_rate: 10,
      labor_cost_code_id: null,
    });
    expect(refused.status).toBe(403);
  });

  it("leaves hours uncoded until a rate is set, and a later payroll miss does not replace timesheets", async () => {
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
    expect(shown.body.data.amount).toBeNull();
    expect(shown.body.data.lines).toHaveLength(1);
    expect(shown.body.data.lines[0].source).toBe("timesheet");
  });

  it("lets an owner move the cost code after the baseline is frozen without changing the budget", async () => {
    await owner().post(`/api/v1/projects/projects/${projectId}/gates/0/approve`);
    await tickGate(owner(), projectId, 1);
    await owner().post(`/api/v1/projects/projects/${projectId}/gates/1/approve`);
    const before = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
    const moved = await owner()
      .put(`/api/v1/projects/projects/${projectId}/labor-cost-code`)
      .send({ cost_code_id: laborCodeId });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.data.cost_code.code).toBe("210");
    const after = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
    expect(after.body.data.lines).toEqual(before.body.data.lines);
    const coordinator = await pm()
      .put(`/api/v1/projects/projects/${projectId}/labor-cost-code`)
      .send({ cost_code_id: null });
    expect(coordinator.status).toBe(403);
    const refresh = await owner().post(`/api/v1/projects/projects/${projectId}/labor/refresh`);
    expect(refresh.status).toBe(409);
    expect(SCHEMA_FILES.some((file) => file.endsWith("037_labor_actuals.sql"))).toBe(true);
  });
});
