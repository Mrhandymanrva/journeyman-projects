import type { SqlClient } from "../db/database.js";
import {
  buildFinancialsDashboard,
  type DashboardActuals,
  type DashboardServiceTitan,
  type FinancialsDashboard,
} from "./financialsDashboard.js";
import { loadBudget } from "./projectBudget.js";
import {
  countQualifyingBills,
  readBillCostByKind,
  readUnlinkedServiceTitanMaterials,
} from "./projectBillCost.js";
import { roundMoney, type ProjectMoney } from "./projectFinancials.js";
import { readStoredProjectMoney, readStoredReconciliation } from "./projectSync.js";
import { readCommittedLabor } from "./committedLaborStore.js";
import type { ServiceTitanSummaryNumbers } from "./stFinancialSummary.js";

function num(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function writeProjectSummary(
  db: SqlClient,
  input: {
    tenantId: string;
    projectId: string;
    observedAt: Date;
    summary: ServiceTitanSummaryNumbers;
  },
): Promise<void> {
  const current = await db.query<{
    estimates_read: boolean;
    invoices_read: boolean;
    contract_value: string | null;
    total_budgeted_expense: string | null;
    change_orders: string | null;
    cost_adjustments: string | null;
    budgeted_labor_expense: string | null;
    budgeted_labor_hours: string | null;
    budgeted_materials: string | null;
    invoice_billed: string | null;
    open_invoices: string | null;
    retainage: string | null;
  }>(
    `SELECT estimates_read, invoices_read,
            contract_value::text, total_budgeted_expense::text, change_orders::text,
            cost_adjustments::text, budgeted_labor_expense::text, budgeted_labor_hours::text,
            budgeted_materials::text, invoice_billed::text, open_invoices::text, retainage::text
       FROM projects.st_project_summary
      WHERE project_id = $1`,
    [input.projectId],
  );
  const previous = current.rows[0];
  const summary = input.summary;
  const estimatesRead = summary.estimatesRead || previous?.estimates_read === true;
  const invoicesRead = summary.invoicesRead || previous?.invoices_read === true;
  const keep = (fresh: boolean, value: number | null, stored: string | null | undefined) =>
    fresh ? value : num(stored);

  await db.query(
    `INSERT INTO projects.st_project_summary
       (tenant_id, project_id, contract_value, total_budgeted_expense, change_orders,
        cost_adjustments, budgeted_labor_expense, budgeted_labor_hours, budgeted_materials,
        invoice_billed, open_invoices, retainage, estimates_read, invoices_read, observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (tenant_id, project_id) DO UPDATE
       SET contract_value = EXCLUDED.contract_value,
           total_budgeted_expense = EXCLUDED.total_budgeted_expense,
           change_orders = EXCLUDED.change_orders,
           cost_adjustments = EXCLUDED.cost_adjustments,
           budgeted_labor_expense = EXCLUDED.budgeted_labor_expense,
           budgeted_labor_hours = EXCLUDED.budgeted_labor_hours,
           budgeted_materials = EXCLUDED.budgeted_materials,
           invoice_billed = EXCLUDED.invoice_billed,
           open_invoices = EXCLUDED.open_invoices,
           retainage = EXCLUDED.retainage,
           estimates_read = EXCLUDED.estimates_read,
           invoices_read = EXCLUDED.invoices_read,
           observed_at = EXCLUDED.observed_at`,
    [
      input.tenantId,
      input.projectId,
      keep(summary.estimatesRead, summary.contractValue, previous?.contract_value),
      keep(summary.estimatesRead, summary.totalBudgetedExpense, previous?.total_budgeted_expense),
      keep(summary.estimatesRead, summary.changeOrders, previous?.change_orders),
      keep(summary.estimatesRead, summary.costAdjustments, previous?.cost_adjustments),
      keep(summary.estimatesRead, summary.budgetedLaborExpense, previous?.budgeted_labor_expense),
      keep(summary.estimatesRead, summary.budgetedLaborHours, previous?.budgeted_labor_hours),
      keep(summary.estimatesRead, summary.budgetedMaterials, previous?.budgeted_materials),
      keep(summary.invoicesRead, summary.billed, previous?.invoice_billed),
      keep(summary.invoicesRead, summary.openInvoices, previous?.open_invoices),
      summary.retainage != null
        ? summary.retainage
        : summary.invoicesRead
          ? null
          : num(previous?.retainage),
      estimatesRead,
      invoicesRead,
      input.observedAt,
    ],
  );
}

interface StoredSummary extends DashboardServiceTitan {
  laborBurden: number | null;
  materialsExpenseRead: boolean;
}

async function loadFinancialFacts(
  db: SqlClient,
  projectId: string,
): Promise<{
  money: ProjectMoney;
  observed: boolean;
  actuals: DashboardActuals;
  serviceTitan: DashboardServiceTitan | null;
  materialsExpenseRead: boolean;
}> {
  const money = await readStoredProjectMoney(db, projectId);
  const reconciliation = await readStoredReconciliation(db, projectId);
  const counts = await db.query<{ lines: string; orders: string; labor: string }>(
    `SELECT
       (SELECT count(*) FROM projects.st_invoice_lines WHERE project_id = $1)::text AS lines,
       (SELECT count(*) FROM projects.st_material_expenses WHERE project_id = $1)::text AS orders,
       (SELECT count(*) FROM projects.labor_actuals WHERE project_id = $1)::text AS labor`,
    [projectId],
  );
  const row = counts.rows[0];
  const qualifyingBills = await countQualifyingBills(db, projectId);
  const observed =
    reconciliation != null ||
    Number(row?.lines ?? 0) > 0 ||
    Number(row?.orders ?? 0) > 0 ||
    Number(row?.labor ?? 0) > 0 ||
    qualifyingBills > 0;
  const stored = await db.query<{
    estimates_read: boolean;
    invoices_read: boolean;
    materials_expense_read: boolean;
    contract_value: string | null;
    total_budgeted_expense: string | null;
    change_orders: string | null;
    cost_adjustments: string | null;
    budgeted_labor_expense: string | null;
    budgeted_labor_hours: string | null;
    budgeted_materials: string | null;
    invoice_billed: string | null;
    open_invoices: string | null;
    retainage: string | null;
    labor_burden: string | null;
  }>(
    `SELECT estimates_read, invoices_read, materials_expense_read,
            contract_value::text, total_budgeted_expense::text, change_orders::text,
            cost_adjustments::text, budgeted_labor_expense::text, budgeted_labor_hours::text,
            budgeted_materials::text, invoice_billed::text, open_invoices::text, retainage::text,
            labor_burden::text
       FROM projects.st_project_summary
      WHERE project_id = $1`,
    [projectId],
  );
  const summary = stored.rows[0];
  const serviceTitan: StoredSummary | null = summary
    ? {
        estimatesRead: summary.estimates_read,
        contractValue: num(summary.contract_value),
        totalBudgetedExpense: num(summary.total_budgeted_expense),
        changeOrders: num(summary.change_orders),
        costAdjustments: num(summary.cost_adjustments),
        budgetedLaborExpense: num(summary.budgeted_labor_expense),
        budgetedLaborHours: num(summary.budgeted_labor_hours),
        budgetedMaterials: num(summary.budgeted_materials),
        invoicesRead: summary.invoices_read,
        billed: num(summary.invoice_billed),
        openInvoices: num(summary.open_invoices),
        retainage: num(summary.retainage),
        laborBurden: num(summary.labor_burden),
        materialsExpenseRead: summary.materials_expense_read,
      }
    : null;
  const materialsExpenseRead =
    serviceTitan?.materialsExpenseRead !== false || Number(row?.orders ?? 0) > 0;
  const laborBurden = serviceTitan?.laborBurden ?? money.laborBurden;
  // Bill cost is added here, not inside readStoredProjectMoney's raw
  // purchase-order sum. Linked ServiceTitan totals are omitted so a bill
  // and the purchase order it created are not both actuals. See projectBillCost.ts.
  const bills = await readBillCostByKind(db, projectId);
  const unlinkedServiceTitan = materialsExpenseRead
    ? await readUnlinkedServiceTitanMaterials(db, projectId)
    : null;
  const materialsExpense =
    unlinkedServiceTitan == null
      ? bills.material > 0
        ? bills.material
        : null
      : roundMoney(unlinkedServiceTitan + bills.material);
  const subcontractorExpense = observed || bills.subcontract > 0 ? bills.subcontract : null;
  const expenses =
    materialsExpense == null
      ? null
      : roundMoney(laborBurden + materialsExpense + (subcontractorExpense ?? 0));
  return {
    money,
    observed,
    materialsExpenseRead,
    serviceTitan,
    actuals: {
      observed,
      billed: money.billed,
      laborBurden,
      materialsExpense,
      subcontractorExpense,
      expenses,
    },
  };
}

export async function readFinancialsDashboard(
  db: SqlClient,
  projectId: string,
): Promise<FinancialsDashboard> {
  const facts = await loadFinancialFacts(db, projectId);
  const budget = await loadBudget(db, projectId);
  const dashboard = buildFinancialsDashboard({
    actuals: facts.actuals,
    serviceTitan: facts.serviceTitan,
    budget,
  });
  dashboard.committedLabor = await readCommittedLabor(db, projectId);
  return dashboard;
}

/** Detail card under the dashboard. A missing materials read stays null, not zero. */
export async function readFinancialsDetail(
  db: SqlClient,
  projectId: string,
): Promise<
  Omit<ProjectMoney, "materialsExpense" | "expenses" | "margin" | "marginPercent"> & {
    materialsExpense: number | null;
    expenses: number | null;
    margin: number | null;
    marginPercent: number | null;
    materials_expense_read: boolean;
    observed_at: string | null;
    error: string | null;
  }
> {
  const facts = await loadFinancialFacts(db, projectId);
  const stored = await readStoredReconciliation(db, projectId);
  const expenses = facts.actuals.expenses;
  const margin = expenses == null ? null : roundMoney(facts.money.billed - expenses);
  return {
    ...facts.money,
    laborBurden: facts.actuals.laborBurden,
    materialsExpense: facts.actuals.materialsExpense,
    expenses,
    margin,
    marginPercent:
      margin == null || !(facts.money.billed > 0)
        ? margin == null
          ? null
          : 0
        : roundMoney((margin / facts.money.billed) * 100),
    materials_expense_read: facts.materialsExpenseRead,
    observed_at: stored?.observed_at ?? null,
    error: stored?.error ?? null,
  };
}
