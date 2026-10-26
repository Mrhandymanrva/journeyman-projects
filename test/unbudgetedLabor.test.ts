import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import {
  SCHEMA_FILES,
  createTenant,
  estimatePayload,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const FEED_TOKEN = "unbudgeted-labor-feed-token-01";

interface CostRow {
  cost_code: string | null;
  description: string;
  cost_type: string;
  baseline: number;
  budget_amount: number;
  actual_cost: number;
  committed_open: number;
  total_committed: number;
  variance: number;
}

describe("unbudgeted labor in the cost position", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness(SCHEMA_FILES);
  });
  afterAll(async () => {
    await h?.close();
  });

  async function opened() {
    const tenant = await createTenant(h, {
      slug: `unbudgeted-${Math.random().toString(36).slice(2, 8)}`,
    });
    const owner = h.as(tenant.staff.owner!.token);
    const imported = await owner.post("/api/v1/projects/estimate-imports").send(estimatePayload());
    const created = await owner.post("/api/v1/projects/projects").send(
      projectBody({
        estimate_import_id: imported.body.data.id,
        source_kind: "journeyman_estimate",
        contract_value: 41800,
      }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const codes = await owner.get("/api/v1/projects/cost-codes");
    const codeId = (codes.body.data as Array<{ id: string; code: string }>).find(
      (row) => row.code === "210",
    )!.id;
    const projectId = created.body.data.id as string;
    const budget = await owner.get(`/api/v1/projects/projects/${projectId}/budget`);
    const hasLaborLine = (budget.body.data.lines as Array<{ cost_code_id: string; cost_type: string }>).some(
      (line) => line.cost_code_id === codeId && line.cost_type === "L",
    );
    expect(hasLaborLine).toBe(false);
    return { tenant, owner, projectId, codeId };
  }

  async function putHours(
    tenant: TenantFixture,
    projectId: string,
    codeId: string | null,
    hours: number,
    hourly: number | null,
    burden: number | null,
    timesheetId: string,
    technicianId = "tech-1",
  ) {
    await h.db.withTenant(tenant.id, async (db) => {
      if (hourly !== null && burden !== null) {
        await db.query(
          `INSERT INTO projects.technician_labor_rates
             (tenant_id, external_technician_id, technician_name, active, hourly_rate, burden_rate)
           VALUES ($1, $2, 'Alex', true, $3, $4)
           ON CONFLICT (tenant_id, external_technician_id) DO UPDATE
             SET hourly_rate = EXCLUDED.hourly_rate, burden_rate = EXCLUDED.burden_rate`,
          [tenant.id, technicianId, hourly, burden],
        );
      }
      await db.query(
        `INSERT INTO projects.labor_actuals
           (tenant_id, project_id, external_job_id, external_timesheet_id,
            external_technician_id, technician_name, work_date, hours, source, cost_code_id)
         VALUES ($1,$2,'job-1',$3,$4,'Alex','2026-10-23',$5,'timesheet',$6)`,
        [tenant.id, projectId, timesheetId, technicianId, hours, codeId],
      );
    });
  }

  async function costPosition(
    owner: ReturnType<Harness["as"]>,
    projectId: string,
  ): Promise<CostRow[]> {
    const res = await owner.get(`/api/v1/projects/projects/${projectId}/cost-position`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as CostRow[];
  }

  function unbudgeted(rows: CostRow[]) {
    return rows.filter((row) => row.description === "Unbudgeted labor");
  }

  async function margin(owner: ReturnType<Harness["as"]>, projectId: string) {
    const res = await owner.get(`/api/v1/projects/projects/${projectId}/margin`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as {
      committed_cost: number;
      projected_cost: number;
      projected_margin: number;
    };
  }

  async function feedTotals(tenantId: string) {
    const app = supertest(
      createApp({
        database: h.db,
        staffSessions: new MemoryStaffSessions(),
        serveConsole: false,
        portfolio: { tenantId, token: FEED_TOKEN },
      }),
    );
    const res = await app
      .get("/api/v1/portfolio/summary")
      .set("Authorization", `Bearer ${FEED_TOKEN}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data.totals as { committed_cost: number; projected_cost: number };
  }

  it("adds the row and counts it in margin and the portfolio total when no labor budget line exists", async () => {
    const { tenant, owner, projectId, codeId } = await opened();
    const before = await margin(owner, projectId);
    const beforeFeed = await feedTotals(tenant.id);
    const beforeRows = await costPosition(owner, projectId);
    expect(unbudgeted(beforeRows)).toEqual([]);

    await putHours(tenant, projectId, codeId, 4, 40, 12, "ts-open");

    const rows = await costPosition(owner, projectId);
    expect(unbudgeted(rows)).toEqual([
      {
        cost_code: null,
        description: "Unbudgeted labor",
        cost_type: "L",
        baseline: 0,
        budget_amount: 0,
        actual_cost: 208,
        committed_open: 0,
        total_committed: 208,
        variance: -208,
      },
    ]);
    const after = await margin(owner, projectId);
    expect(after.committed_cost).toBe(before.committed_cost + 208);
    expect(after.projected_cost).toBe(before.projected_cost + 208);
    expect(after.projected_margin).toBeCloseTo(
      (41800 - after.projected_cost) / 41800,
      4,
    );
    const afterFeed = await feedTotals(tenant.id);
    expect(afterFeed.committed_cost).toBe(beforeFeed.committed_cost + 208);
    expect(afterFeed.projected_cost).toBe(beforeFeed.projected_cost + 208);
  });

  it("keeps the dollars on the matching labor budget line and does not add the row", async () => {
    const { tenant, owner, projectId, codeId } = await opened();
    await putHours(tenant, projectId, codeId, 4, 40, 12, "ts-matched");
    const open = await margin(owner, projectId);
    const added = await owner.post(`/api/v1/projects/projects/${projectId}/budget`).send({
      cost_code_id: codeId,
      cost_type: "L",
      budget_amount: 2200,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);

    const rows = await costPosition(owner, projectId);
    expect(unbudgeted(rows)).toEqual([]);
    const line = rows.find((row) => row.cost_code === "210" && row.cost_type === "L");
    expect(line?.actual_cost).toBe(208);
    expect(line?.description).not.toBe("Unbudgeted labor");
    const after = await margin(owner, projectId);
    expect(after.committed_cost).toBe(open.committed_cost);
    const laborDollars = rows
      .filter((row) => row.cost_code === "210" && row.cost_type === "L")
      .reduce((sum, row) => sum + row.actual_cost, 0);
    expect(laborDollars).toBe(208);
  });

  it("does not add the row when labor dollars are zero", async () => {
    const { tenant, owner, projectId, codeId } = await opened();
    const before = await margin(owner, projectId);
    expect(unbudgeted(await costPosition(owner, projectId))).toEqual([]);

    await putHours(tenant, projectId, codeId, 0, 40, 12, "ts-zero-hours");
    expect(unbudgeted(await costPosition(owner, projectId))).toEqual([]);

    await putHours(tenant, projectId, codeId, 4, 0, 0, "ts-zero-rates");
    expect(unbudgeted(await costPosition(owner, projectId))).toEqual([]);

    await putHours(tenant, projectId, null, 6, 40, 12, "ts-uncoded", "tech-uncoded");
    const rows = await costPosition(owner, projectId);
    expect(unbudgeted(rows)).toEqual([]);
    expect((await margin(owner, projectId)).committed_cost).toBe(before.committed_cost);
    expect((await margin(owner, projectId)).projected_cost).toBe(before.projected_cost);
  });
});
