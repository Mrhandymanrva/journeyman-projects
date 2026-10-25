import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetAlert } from "../src/domain/budgetAlert.js";
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

describe("budget alert thresholds", () => {
  it("stays quiet under 80 percent", () => {
    expect(budgetAlert(790, 1000)).toEqual({
      budget_alert: "none",
      actual_to_budget_pct: 79,
    });
    expect(budgetAlert(79.99, 100)).toMatchObject({ budget_alert: "none" });
  });

  it("warns at 80 percent and through 99 percent", () => {
    expect(budgetAlert(80, 100)).toEqual({
      budget_alert: "warning",
      actual_to_budget_pct: 80,
    });
    expect(budgetAlert(800, 1000)).toEqual({
      budget_alert: "warning",
      actual_to_budget_pct: 80,
    });
    expect(budgetAlert(99.99, 100)).toMatchObject({ budget_alert: "warning" });
  });

  it("is over budget at 100 percent and above", () => {
    expect(budgetAlert(100, 100)).toEqual({
      budget_alert: "over_budget",
      actual_to_budget_pct: 100,
    });
    expect(budgetAlert(1250, 1000)).toEqual({
      budget_alert: "over_budget",
      actual_to_budget_pct: 125,
    });
  });

  it("does not invent a ratio when no budget is set", () => {
    expect(budgetAlert(0, 0)).toEqual({
      budget_alert: "no_budget",
      actual_to_budget_pct: null,
    });
    expect(budgetAlert(500, 0)).toEqual({
      budget_alert: "no_budget",
      actual_to_budget_pct: null,
    });
  });
});

describe("budget alerts on a project", () => {
  let h: Harness;
  let t: TenantFixture;

  beforeAll(async () => {
    h = await startHarness();
    t = await createTenant(h, { slug: "budget-alerts" });
  });
  afterAll(async () => {
    await h?.close();
  });

  const owner = () => h.as(t.staff.owner!.token);

  async function costCode() {
    const codes = await owner().get("/api/v1/projects/cost-codes");
    expect(codes.status).toBe(200);
    return codes.body.data[0] as {
      id: string;
      code: string;
      description: string;
    };
  }

  async function projectWithMaterialBudget(amount: number, number: string) {
    const created = await owner()
      .post("/api/v1/projects/projects")
      .send(projectBody({ project_number: number, name: `Budget ${number}` }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const code = await costCode();
    const line = await owner()
      .post(`/api/v1/projects/projects/${created.body.data.id}/budget`)
      .send({
        cost_code_id: code.id,
        cost_type: "M",
        budget_amount: amount,
      });
    expect(line.status, JSON.stringify(line.body)).toBe(201);
    return { projectId: created.body.data.id as string, code };
  }

  async function recordMaterial(
    projectId: string,
    costCodeId: string,
    amount: number,
    order: string,
  ) {
    const bill = await owner()
      .post(`/api/v1/projects/projects/${projectId}/material-bills`)
      .send({
        supplier_name: "Home Depot",
        cost_code_id: costCodeId,
        amount,
        order_number: order,
        invoice_date: "2026-10-01",
      });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
  }

  async function expectAlert(
    projectId: string,
    costCode: string,
    alert: "none" | "warning" | "over_budget" | "no_budget",
    pct: number | null,
  ) {
    const detail = await owner().get(`/api/v1/projects/projects/${projectId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      budget_alert: alert,
      actual_to_budget_pct: pct,
    });

    const listed = await owner().get("/api/v1/projects/projects?per_page=200");
    const row = (
      listed.body.data as Array<{
        id: string;
        budget_alert: string;
        actual_to_budget_pct: number | null;
      }>
    ).find((project) => project.id === projectId);
    expect(row).toMatchObject({
      budget_alert: alert,
      actual_to_budget_pct: pct,
    });

    const cost = await owner().get(
      `/api/v1/projects/projects/${projectId}/cost-position`,
    );
    const line = (
      cost.body.data as Array<{
        cost_code: string;
        budget_alert: string;
        actual_to_budget_pct: number | null;
      }>
    ).find((entry) => entry.cost_code === costCode);
    if (alert === "no_budget" && !line) return;
    expect(line).toMatchObject({
      budget_alert: alert,
      actual_to_budget_pct: pct,
    });
  }

  it("flags a project under 80, at 80, at 100, and over 100", async () => {
    const under = await projectWithMaterialBudget(1000, "BA-UNDER");
    await recordMaterial(under.projectId, under.code.id, 790, "BA-790");
    await expectAlert(under.projectId, under.code.code, "none", 79);

    const warning = await projectWithMaterialBudget(1000, "BA-EIGHTY");
    await recordMaterial(warning.projectId, warning.code.id, 800, "BA-800");
    await expectAlert(warning.projectId, warning.code.code, "warning", 80);

    const even = await projectWithMaterialBudget(1000, "BA-EVEN");
    await recordMaterial(even.projectId, even.code.id, 1000, "BA-1000");
    await expectAlert(even.projectId, even.code.code, "over_budget", 100);

    const over = await projectWithMaterialBudget(1000, "BA-OVER");
    await recordMaterial(over.projectId, over.code.id, 1250, "BA-1250");
    await expectAlert(over.projectId, over.code.code, "over_budget", 125);
  });

  it("does not flag a project with no budget, including a zero budget line", async () => {
    const empty = await owner()
      .post("/api/v1/projects/projects")
      .send(projectBody({ project_number: "BA-NONE", name: "No budget yet" }));
    expect(empty.status).toBe(201);
    const detail = await owner().get(
      `/api/v1/projects/projects/${empty.body.data.id}`,
    );
    expect(detail.body.data).toMatchObject({
      budget_alert: "no_budget",
      budget_amount: 0,
      actual_cost: 0,
      actual_to_budget_pct: null,
    });
    const cost = await owner().get(
      `/api/v1/projects/projects/${empty.body.data.id}/cost-position`,
    );
    expect(cost.body.data).toEqual([]);

    const code = await costCode();
    const zero = await owner()
      .post("/api/v1/projects/projects")
      .send(
        projectBody({ project_number: "BA-ZERO", name: "Zero budget line" }),
      );
    expect(zero.status).toBe(201);
    const line = await owner()
      .post(`/api/v1/projects/projects/${zero.body.data.id}/budget`)
      .send({
        cost_code_id: code.id,
        cost_type: "M",
        budget_amount: 0,
      });
    expect(line.status, JSON.stringify(line.body)).toBe(201);
    await recordMaterial(zero.body.data.id, code.id, 400, "BA-ZERO-BILL");
    const position = await owner().get(
      `/api/v1/projects/projects/${zero.body.data.id}/cost-position`,
    );
    const row = (
      position.body.data as Array<{
        cost_code: string;
        budget_alert: string;
        actual_cost: number;
      }>
    ).find((entry) => entry.cost_code === code.code);
    expect(row).toMatchObject({
      budget_alert: "no_budget",
      actual_cost: 400,
      actual_to_budget_pct: null,
    });
    const project = await owner().get(
      `/api/v1/projects/projects/${zero.body.data.id}`,
    );
    expect(project.body.data.budget_alert).toBe("no_budget");
    expect(project.body.data.actual_to_budget_pct).toBeNull();
  });

  it("flags the cost code that is hot when the project total is still under 80", async () => {
    const created = await owner()
      .post("/api/v1/projects/projects")
      .send(projectBody({ project_number: "BA-SPLIT", name: "Split codes" }));
    expect(created.status).toBe(201);
    const codes = await owner().get("/api/v1/projects/cost-codes");
    const [first, second] = codes.body.data as Array<{
      id: string;
      code: string;
    }>;
    expect(second).toBeTruthy();
    for (const code of [first!, second!]) {
      const line = await owner()
        .post(`/api/v1/projects/projects/${created.body.data.id}/budget`)
        .send({
          cost_code_id: code.id,
          cost_type: "M",
          budget_amount: 1000,
        });
      expect(line.status, JSON.stringify(line.body)).toBe(201);
    }
    await recordMaterial(
      created.body.data.id,
      first!.id,
      1000,
      "BA-SPLIT-BILL",
    );

    const detail = await owner().get(
      `/api/v1/projects/projects/${created.body.data.id}`,
    );
    expect(detail.body.data).toMatchObject({
      budget_amount: 2000,
      actual_cost: 1000,
      budget_alert: "none",
      actual_to_budget_pct: 50,
    });
    const cost = await owner().get(
      `/api/v1/projects/projects/${created.body.data.id}/cost-position`,
    );
    const hot = (
      cost.body.data as Array<{ cost_code: string; budget_alert: string }>
    ).find((entry) => entry.cost_code === first!.code);
    const quiet = (
      cost.body.data as Array<{ cost_code: string; budget_alert: string }>
    ).find((entry) => entry.cost_code === second!.code);
    expect(hot?.budget_alert).toBe("over_budget");
    expect(quiet?.budget_alert).toBe("none");
  });
});
