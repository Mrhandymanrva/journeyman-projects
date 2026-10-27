import type { SqlClient } from "../db/database.js";
import {
  buildFinancialsDashboard,
  type DashboardServiceTitan,
  type FinancialsDashboard,
} from "./financialsDashboard.js";
import { readStoredProjectMoney, readStoredReconciliation } from "./projectSync.js";
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

export async function readFinancialsDashboard(
  db: SqlClient,
  projectId: string,
): Promise<FinancialsDashboard> {
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
  const observed =
    reconciliation != null ||
    Number(row?.lines ?? 0) > 0 ||
    Number(row?.orders ?? 0) > 0 ||
    Number(row?.labor ?? 0) > 0;
  const stored = await db.query<{
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
    [projectId],
  );
  const summary = stored.rows[0];
  const serviceTitan: DashboardServiceTitan | null = summary
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
      }
    : null;
  return buildFinancialsDashboard({
    actuals: {
      observed,
      billed: money.billed,
      laborBurden: money.laborBurden,
      materialsExpense: money.materialsExpense,
      expenses: money.expenses,
    },
    serviceTitan,
  });
}
