import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasExecutableSql, splitSqlStatements } from "../src/db/splitSql.js";
import { saveBudgetEntry } from "../src/domain/projectBudget.js";
import {
  createTenant,
  projectBody,
  SCHEMA_FILES,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

/**
 * 054 copied JP.BUDGET only when both estimating and projects were live, and it
 * asked module_live() before selecting the company, so a projects company
 * without estimating never received the row. 061 copies it for every company
 * with projects live. Saving creates the same row when it is still missing.
 */
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const migration = path.join(repoRoot, "db/061_project_budget_cost_code.sql");

const entry = {
  contract_value: 100000,
  labor: 40000,
  labor_hours: 200,
  materials: 15000,
  subcontractor: 10000,
  other: 5000,
};

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
});

async function applyBudgetCodeMigration(): Promise<void> {
  for (const statement of splitSqlStatements(readFileSync(migration, "utf8"))) {
    if (!hasExecutableSql(statement.text)) continue;
    await h.db.asOwner((db) => db.query(statement.text));
  }
}

async function budgetCodes(
  tenantId: string,
): Promise<Array<{ id: string; active: boolean }>> {
  const found = await h.db.asOwner((db) =>
    db.query<{ id: string; active: boolean }>(
      `SELECT id, active
         FROM projects.cost_codes
        WHERE tenant_id = $1 AND code = 'JP.BUDGET'
        ORDER BY id`,
      [tenantId],
    ),
  );
  return found.rows;
}

describe("JP.BUDGET for a projects company without estimating", () => {
  it("does not gate the backfill on estimating, and a rerun does not duplicate the row", async () => {
    const sql = readFileSync(migration, "utf8");
    expect(sql).toMatch(/module_live\(t, 'projects'\)/);
    expect(sql).not.toMatch(/module_live\([^)]*'estimating'/);
    expect(sql).toMatch(/ON CONFLICT \(tenant_id, code\) DO NOTHING/);
    expect(sql).toMatch(/NOT EXISTS/);
    expect(
      SCHEMA_FILES.some((file) =>
        file.endsWith("061_project_budget_cost_code.sql"),
      ),
    ).toBe(true);
    expect(
      readFileSync(
        path.join(repoRoot, "db/054_project_budget_entry.sql"),
        "utf8",
      ),
    ).toMatch(/module_live\(t, 'estimating'\)/);

    const projectsOnly = await createTenant(h, {
      slug: "budget-projects-only",
      entitlements: [
        { module: "projects", state: "active" },
        { module: "estimating", state: "cancelled" },
      ],
    });
    const estimatingOnly = await createTenant(h, {
      slug: "budget-estimating-only",
      entitlements: [
        { module: "estimating", state: "active" },
        { module: "projects", state: "cancelled" },
      ],
    });

    await applyBudgetCodeMigration();
    const first = await budgetCodes(projectsOnly.id);
    expect(first).toHaveLength(1);
    expect(first[0]?.active).toBe(true);
    expect(await budgetCodes(estimatingOnly.id)).toHaveLength(0);

    await applyBudgetCodeMigration();
    const second = await budgetCodes(projectsOnly.id);
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
  });

  it("lets that company save a budget, creating JP.BUDGET once", async () => {
    // Activation needs both modules. The company then loses estimating, which
    // is the 054 skip, and the budget code is removed so the save has to
    // create it. Estimating is restored only so the Financials request is
    // allowed through; the save itself does not check that entitlement.
    const tenant = await createTenant(h, { slug: "budget-save-without-code" });
    const created = await h
      .as(tenant.staff.owner!.token)
      .post("/api/v1/projects/projects")
      .send(projectBody({ project_number: "BUDGET-NO-CODE" }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const projectId = created.body.data.id as string;

    await h.db.asOwner(async (db) => {
      await db.query(
        `UPDATE projects.entitlements SET state = 'cancelled'
          WHERE tenant_id = $1 AND module_key = 'estimating'`,
        [tenant.id],
      );
      await db.query(
        `DELETE FROM projects.cost_codes WHERE tenant_id = $1 AND code = 'JP.BUDGET'`,
        [tenant.id],
      );
    });
    expect(await budgetCodes(tenant.id)).toHaveLength(0);

    await applyBudgetCodeMigration();
    expect(await budgetCodes(tenant.id)).toHaveLength(1);

    await h.db.asOwner(async (db) => {
      await db.query(
        `DELETE FROM projects.cost_codes WHERE tenant_id = $1 AND code = 'JP.BUDGET'`,
        [tenant.id],
      );
      await db.query(
        `UPDATE projects.entitlements SET state = 'active'
          WHERE tenant_id = $1 AND module_key = 'estimating'`,
        [tenant.id],
      );
    });

    const entryPath = `/api/v1/projects/projects/${projectId}/budget/entry`;
    const owner = h.as(tenant.staff.owner!.token);
    const saved = await owner.put(entryPath).send(entry);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data).toMatchObject({
      contract_value: 100000,
      labor: 40000,
      labor_hours: 200,
      materials: 15000,
      subcontractor: 10000,
      other: 5000,
      total: 70000,
      summary_code: "JP.BUDGET",
    });
    const createdCodes = await budgetCodes(tenant.id);
    expect(createdCodes).toHaveLength(1);

    const again = await owner.put(entryPath).send(entry);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const afterSecond = await budgetCodes(tenant.id);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]?.id).toBe(createdCodes[0]?.id);
  });

  it("keeps the cost-code error only when the library itself has no JP.BUDGET", async () => {
    const tenant: TenantFixture = await createTenant(h, {
      slug: "budget-no-library",
    });
    const created = await h
      .as(tenant.staff.owner!.token)
      .post("/api/v1/projects/projects")
      .send(projectBody({ project_number: "BUDGET-NO-LIB" }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const projectId = created.body.data.id as string;

    await h.db.asOwner((db) =>
      db.query(
        `DELETE FROM projects.cost_code_library WHERE code = 'JP.BUDGET'`,
      ),
    );
    try {
      await h.db.withTenant(tenant.id, (db) =>
        db.query(`DELETE FROM projects.cost_codes WHERE code = 'JP.BUDGET'`),
      );
      await expect(
        h.db.withTenant(tenant.id, (db) =>
          saveBudgetEntry(db, {
            tenantId: tenant.id,
            projectId,
            contractValue: 1000,
            laborHours: null,
            labor: 100,
            materials: null,
            subcontractor: null,
            other: null,
          }),
        ),
      ).rejects.toMatchObject({
        message: "The project budget cost code is not on this company yet.",
      });
    } finally {
      await h.db.asOwner((db) =>
        db.query(
          `INSERT INTO projects.cost_code_library
             (code, division_code, division_name, description, default_cost_type, ledger_account, sort_order)
           VALUES
             ('JP.BUDGET', '000', 'Project budget', 'Project budget', 'O'::projects.cost_type,
              '50400 COGS — Other Job Costs', 5)
           ON CONFLICT (code) DO NOTHING`,
        ),
      );
    }
  });
});
