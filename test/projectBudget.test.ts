import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  budgetFromSums,
  summaryLineAmount,
} from "../src/domain/projectBudget.js";
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

describe("budget category math", () => {
  it("sums only the categories that were entered and keeps a real zero", () => {
    expect(
      budgetFromSums({
        contractValue: null,
        laborHours: 120,
        rows: [
          { costType: "L", amount: 21480, count: 1 },
          { costType: "M", amount: 6708.8, count: 1 },
          { costType: "S", amount: 10728, count: 1 },
        ],
      }),
    ).toEqual({
      entered: true,
      contractValue: null,
      laborHours: 120,
      labor: 21480,
      materials: 6708.8,
      subcontractor: 10728,
      other: null,
      totalBudgetedExpense: 38916.8,
    });
    expect(
      budgetFromSums({ contractValue: null, laborHours: null, rows: [] }).entered,
    ).toBe(false);
    expect(
      budgetFromSums({
        contractValue: null,
        laborHours: null,
        rows: [{ costType: "L", amount: 0, count: 1 }],
      }).labor,
    ).toBe(0);
  });

  it("adjusts only the summary line and rejects a total below the other cost codes", () => {
    expect(summaryLineAmount(21480, 1000)).toEqual({ action: "upsert", amount: 20480 });
    expect(summaryLineAmount(1000, 1000)).toEqual({ action: "delete" });
    expect(summaryLineAmount(null, 1000)).toEqual({ action: "delete" });
    expect(summaryLineAmount(0, 0)).toEqual({ action: "upsert", amount: 0 });
    expect(summaryLineAmount(500, 1000)).toEqual({ action: "reject", otherLines: 1000 });
  });
});

describe("project budget entry", () => {
  let h: Harness;
  let tenant: TenantFixture;

  beforeAll(async () => {
    h = await startHarness();
    tenant = await createTenant(h, { slug: "budget-entry" });
  });
  afterAll(async () => {
    await h?.close();
  });

  const entry = {
    contract_value: null as number | null,
    labor: 21480,
    labor_hours: 120,
    materials: 6708.8,
    subcontractor: 10728,
    other: null as number | null,
  };

  async function project() {
    const created = await h.as(tenant.staff.owner!.token).post("/api/v1/projects/projects").send(projectBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.data.id as string;
  }

  it("lets owner, manager, and project manager save one budget, and keeps other roles read-only", async () => {
    const projectId = await project();
    const path = `/api/v1/projects/projects/${projectId}/budget/entry`;
    const denied = await h.as(tenant.staff.office!.token).put(path).send(entry);
    expect(denied.status).toBe(403);
    expect((await h.as(tenant.staff.estimator!.token).put(path).send(entry)).status).toBe(403);
    expect((await h.as(tenant.staff.bookkeeper!.token).put(path).send(entry)).status).toBe(403);

    const pm = await h.as(tenant.staff.pm!.token).put(path).send(entry);
    expect(pm.status, JSON.stringify(pm.body)).toBe(200);
    expect(pm.body.data).toMatchObject({
      contract_value: null,
      labor_hours: 120,
      labor: 21480,
      materials: 6708.8,
      subcontractor: 10728,
      other: null,
      total: 38916.8,
      entered: true,
      summary_code: "JP.BUDGET",
    });

    const manager = await h.as(tenant.staff.manager!.token).put(path).send({ ...entry, labor_hours: 121 });
    expect(manager.status).toBe(200);
    expect(manager.body.data.labor_hours).toBe(121);

    const saved = await h.as(tenant.staff.owner!.token).put(path).send(entry);
    expect(saved.status).toBe(200);

    const projectRow = await h.as(tenant.staff.owner!.token).get(`/api/v1/projects/projects/${projectId}`);
    expect(projectRow.body.data.contract_value).toBeNull();

    const summary = await h
      .as(tenant.staff.owner!.token)
      .get(`/api/v1/projects/projects/${projectId}/financials/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.data.budgetEntered).toBe(true);
    expect(summary.body.data.contractValue).toEqual({ value: null, source: "missing", gap: "budget" });
    expect(summary.body.data.totalBudgetedExpense).toEqual({ value: 38916.8, source: "journeyman" });
    expect(summary.body.data.budgetedLaborExpense).toEqual({ value: 21480, source: "journeyman" });
    expect(summary.body.data.budgetedLaborHours).toEqual({ value: 120, source: "journeyman" });
    expect(summary.body.data.budgetedMaterials).toEqual({ value: 6708.8, source: "journeyman" });
    expect(summary.body.data.costToComplete.gap).toBe("computed");
    expect(summary.body.data.costToComplete.value).toBeNull();
    expect(summary.body.data.earnedRevenue.value).toBeNull();
    expect(summary.body.data.percentOfWorkCompleted.value).toBeNull();
    expect(summary.body.data.budgetedMargin.value).toBeNull();
  });

  it("clears a budget back to the empty state instead of storing zero", async () => {
    const projectId = await project();
    const path = `/api/v1/projects/projects/${projectId}/budget/entry`;
    const cleared = await h.as(tenant.staff.owner!.token).put(path).send({
      contract_value: null,
      labor: null,
      labor_hours: null,
      materials: null,
      subcontractor: null,
      other: null,
    });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.data.entered).toBe(false);
    expect(cleared.body.data.total).toBeNull();
    expect(cleared.body.data.contract_value).toBeNull();

    const summary = await h
      .as(tenant.staff.owner!.token)
      .get(`/api/v1/projects/projects/${projectId}/financials/summary`);
    expect(summary.body.data.budgetEntered).toBe(false);
    expect(summary.body.data.contractValue.value).toBeNull();
    expect(summary.body.data.totalBudgetedExpense.value).toBeNull();
  });

  it("keeps cost-code lines in the same total and rejects a category below those lines", async () => {
    const projectId = await project();
    const owner = h.as(tenant.staff.owner!.token);
    const codes = await owner.get("/api/v1/projects/cost-codes");
    const laborCode = (codes.body.data as Array<{ id: string; code: string }>).find(
      (row) => row.code === "210",
    );
    expect(laborCode).toBeTruthy();
    const added = await owner.post(`/api/v1/projects/projects/${projectId}/budget`).send({
      cost_code_id: laborCode!.id,
      cost_type: "L",
      budget_amount: 1000,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);

    const path = `/api/v1/projects/projects/${projectId}/budget/entry`;
    const saved = await owner.put(path).send(entry);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.labor).toBe(21480);
    expect(saved.body.data.total).toBe(38916.8);

    const lines = await owner.get(`/api/v1/projects/projects/${projectId}/budget`);
    const summaryLine = (lines.body.data.lines as Array<{ code: string; cost_type: string; budget_amount: number }>).find(
      (line) => line.code === "JP.BUDGET" && line.cost_type === "L",
    );
    expect(summaryLine?.budget_amount).toBe(20480);

    const tooLow = await owner.put(path).send({ ...entry, labor: 500 });
    expect(tooLow.status).toBe(409);
    expect(tooLow.body.error.code).toBe("conflict");
    const afterReject = await owner.get(`/api/v1/projects/projects/${projectId}/budget`);
    expect(afterReject.body.data.entry.labor).toBe(21480);

    const cleared = await owner.put(path).send({ ...entry, labor: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.data.labor).toBe(1000);
    const remaining = await owner.get(`/api/v1/projects/projects/${projectId}/budget`);
    const rows = remaining.body.data.lines as Array<{ code: string; cost_type: string }>;
    expect(rows.some((line) => line.code === "210" && line.cost_type === "L")).toBe(true);
    expect(rows.some((line) => line.code === "JP.BUDGET" && line.cost_type === "L")).toBe(false);
  });

  it("blocks a budget change after the baseline is frozen", async () => {
    const projectId = await project();
    const owner = h.as(tenant.staff.owner!.token);
    await h.db.withTenant(tenant.id, (db) =>
      db.query(
        `UPDATE projects.stage_gates
            SET status = 'approved', approved_by = $2, approved_at = now()
          WHERE project_id = $1 AND gate_number = 1`,
        [projectId, tenant.staff.owner!.id],
      ),
    );
    const frozen = await owner.put(`/api/v1/projects/projects/${projectId}/budget/entry`).send(entry);
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.code).toBe("baseline_frozen");
  });
});
