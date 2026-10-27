/**
 * Segreto project seed. Every figure for this project is on
 * SEGRETO_DASHBOARD_FIXTURE. Null is a dash. Nothing here is estimated,
 * and free-text budget notes from job summaries are not used.
 *
 * Read-only ServiceTitan GETs on Oct 27, 2026 for project 321586598.
 * Purchase-order cost and payroll both returned 403. There is no sold estimate.
 */

import type { DashboardActuals, DashboardServiceTitan } from "../domain/financialsDashboard.js";
import { roundMoney, SEGRETO_LINKED_JOB, SEGRETO_PROJECT_ID } from "../domain/projectFinancials.js";

export interface SegretoDashboardFixture {
  identity: {
    number: string;
    name: string;
    customer: string;
    /** No street address is on file. This is the ServiceTitan project id, not a jobsite. */
    address: string;
    /** Demo business unit. Not a confirmed jobsite city. */
    city: string;
    externalProjectId: string;
    linkedJobId: string;
    startedOn: string;
    targetFinishOn: string;
    jobCount: number;
  };
  actuals: {
    billedLabor: number;
    billedMaterialLines: readonly { sku: string; total: number }[];
    /** Lines that are neither labor nor material. Folded into billed. */
    billedOther: number;
    /** Project Financials labor burden. Payroll returned 403, so hours are unknown. */
    laborBurden: number;
    /** Null when purchase-order cost was not returned. */
    materialsExpense: number | null;
    /** Unknown. A number here is timesheet hours, not a guess. */
    hours: number | null;
  };
  invoices: {
    headerTotal: number;
    tax: number;
    count: number;
    datedCount: number;
    undatedDraftCount: number;
    open: readonly { number: string; balance: number; invoicedOn: string }[];
  };
  /** Returned by ServiceTitan. Not a dashboard tile. */
  payments: {
    total: number;
    applied: number;
    unapplied: number;
  };
  /**
   * Sold-estimate figures. Null is a dash.
   * Set estimatesRead true only when this side was actually returned.
   * Retainage stays null when invoices have no retainage field. That is not $0.
   */
  serviceTitan: {
    estimatesRead: boolean;
    contractValue: number | null;
    totalBudgetedExpense: number | null;
    changeOrders: number | null;
    costAdjustments: number | null;
    budgetedLaborExpense: number | null;
    budgetedLaborHours: number | null;
    budgetedMaterials: number | null;
    retainage: number | null;
  };
  /**
   * Local projects.contract_value. The column must be greater than zero.
   * The dashboard does not read this. It is not a ServiceTitan contract.
   */
  journeymanContract: number;
  targetMargin: number;
}

export const SEGRETO_DASHBOARD_FIXTURE: SegretoDashboardFixture = {
  identity: {
    number: "DMO-2026-1448",
    name: "Segreto - Rear Deck Build Project",
    customer: "Segreto",
    address: `ServiceTitan project ${SEGRETO_PROJECT_ID}`,
    city: "Richmond",
    externalProjectId: SEGRETO_PROJECT_ID,
    linkedJobId: SEGRETO_LINKED_JOB,
    startedOn: "2026-10-19",
    targetFinishOn: "2026-11-06",
    jobCount: 33,
  },
  actuals: {
    billedLabor: 18104.4,
    billedMaterialLines: [
      { sku: "MH.PO.700.003", total: 9162.99 },
      { sku: "MH.VS.700.002", total: 1022.53 },
    ],
    billedOther: 0,
    laborBurden: 2440.43,
    materialsExpense: null,
    hours: null,
  },
  invoices: {
    headerTotal: 28289.92,
    tax: 0,
    count: 33,
    datedCount: 15,
    undatedDraftCount: 18,
    open: [
      { number: "145423", balance: 2369.92, invoicedOn: "2026-10-27" },
      { number: "145421", balance: 1560.4, invoicedOn: "2026-10-27" },
    ],
  },
  payments: {
    total: 30000,
    applied: 24359.6,
    unapplied: 5640.4,
  },
  serviceTitan: {
    estimatesRead: false,
    contractValue: null,
    totalBudgetedExpense: null,
    changeOrders: null,
    costAdjustments: null,
    budgetedLaborExpense: null,
    budgetedLaborHours: null,
    budgetedMaterials: null,
    retainage: null,
  },
  journeymanContract: 1,
  targetMargin: 0,
};

export function segretoBilledMaterials(fixture: SegretoDashboardFixture = SEGRETO_DASHBOARD_FIXTURE): number {
  return roundMoney(fixture.actuals.billedMaterialLines.reduce((sum, line) => sum + line.total, 0));
}

export function segretoOpenInvoices(fixture: SegretoDashboardFixture = SEGRETO_DASHBOARD_FIXTURE): number {
  return roundMoney(fixture.invoices.open.reduce((sum, invoice) => sum + invoice.balance, 0));
}

export function segretoInvoiceLines(fixture: SegretoDashboardFixture = SEGRETO_DASHBOARD_FIXTURE) {
  return [
    { lineKey: "labor", sku: "MHM.25PLFE", kind: "labor" as const, total: fixture.actuals.billedLabor },
    ...fixture.actuals.billedMaterialLines.map((line, index) => ({
      lineKey: `material-${index + 1}`,
      sku: line.sku,
      kind: "material" as const,
      total: line.total,
    })),
    { lineKey: "other", sku: "OTHER", kind: "other" as const, total: fixture.actuals.billedOther },
  ].filter((line) => line.total !== 0);
}

export function segretoReadNotes(fixture: SegretoDashboardFixture = SEGRETO_DASHBOARD_FIXTURE): string | null {
  const notes: string[] = [];
  if (fixture.actuals.materialsExpense == null) {
    notes.push("Purchase orders: ServiceTitan did not return materials expense. Nothing is estimated.");
  }
  if (fixture.actuals.hours == null) {
    notes.push("Payroll returned 403. Labor burden is the Project Financials figure. Hours were not returned.");
  }
  return notes.length > 0 ? notes.join("; ") : null;
}

export function segretoDashboardInput(fixture: SegretoDashboardFixture = SEGRETO_DASHBOARD_FIXTURE): {
  actuals: DashboardActuals;
  serviceTitan: DashboardServiceTitan;
} {
  const billedMaterials = segretoBilledMaterials(fixture);
  const billed = roundMoney(fixture.actuals.billedLabor + billedMaterials + fixture.actuals.billedOther);
  const materials = fixture.actuals.materialsExpense;
  const expenses = materials == null ? null : roundMoney(fixture.actuals.laborBurden + materials);
  const st = fixture.serviceTitan;
  return {
    actuals: {
      observed: true,
      billed,
      laborBurden: fixture.actuals.laborBurden,
      materialsExpense: materials,
      expenses,
    },
    serviceTitan: {
      estimatesRead: st.estimatesRead,
      contractValue: st.contractValue,
      totalBudgetedExpense: st.totalBudgetedExpense,
      changeOrders: st.changeOrders,
      costAdjustments: st.costAdjustments,
      budgetedLaborExpense: st.budgetedLaborExpense,
      budgetedLaborHours: st.budgetedLaborHours,
      budgetedMaterials: st.budgetedMaterials,
      invoicesRead: true,
      billed: fixture.invoices.headerTotal,
      openInvoices: segretoOpenInvoices(fixture),
      retainage: st.retainage,
    },
  };
}
