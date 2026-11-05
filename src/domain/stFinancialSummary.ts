/**
 * Turn ServiceTitan estimate and invoice reads into the project summary.
 * A field ServiceTitan did not send stays null. Zero is kept when the read
 * actually returned zero. Sold estimates only. Nothing is written back.
 */

import { roundMoney } from "./projectFinancials.js";

export interface EstimateItemRead {
  skuType: string | null;
  qty: number | null;
  total: number | null;
  totalCost: number | null;
  soldHours: number | null;
}

export interface EstimateRead {
  id: string;
  status: string;
  /** Null when the payload has no change-order flag. */
  isChangeOrder: boolean | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  /** Null when the estimate payload did not include items. */
  items: EstimateItemRead[] | null;
}

export interface InvoiceHeaderRead {
  id: string;
  total: number | null;
  balance: number | null;
  /** Null when this invoice payload has no retainage amount. */
  retainage: number | null;
  active: boolean;
}

export interface ServiceTitanSummaryNumbers {
  estimatesRead: boolean;
  contractValue: number | null;
  totalBudgetedExpense: number | null;
  changeOrders: number | null;
  costAdjustments: number | null;
  budgetedLaborExpense: number | null;
  budgetedLaborHours: number | null;
  budgetedMaterials: number | null;
  invoicesRead: boolean;
  billed: number | null;
  openInvoices: number | null;
  retainage: number | null;
}

const EMPTY: ServiceTitanSummaryNumbers = {
  estimatesRead: false,
  contractValue: null,
  totalBudgetedExpense: null,
  changeOrders: null,
  costAdjustments: null,
  budgetedLaborExpense: null,
  budgetedLaborHours: null,
  budgetedMaterials: null,
  invoicesRead: false,
  billed: null,
  openInvoices: null,
  retainage: null,
};

function sold(estimate: EstimateRead): boolean {
  return estimate.status.trim().toLowerCase() === "sold";
}

/** Price and tax. A missing tax is treated as zero only when a subtotal was sent. */
export function estimatePrice(estimate: EstimateRead): number | null {
  if (estimate.total != null && Number.isFinite(estimate.total)) return roundMoney(estimate.total);
  if (estimate.subtotal != null && Number.isFinite(estimate.subtotal)) {
    const tax = estimate.tax != null && Number.isFinite(estimate.tax) ? estimate.tax : 0;
    return roundMoney(estimate.subtotal + tax);
  }
  return null;
}

function isLabor(item: EstimateItemRead): boolean {
  return (item.skuType ?? "").trim().toLowerCase() === "service";
}

function isMaterial(item: EstimateItemRead): boolean {
  const type = (item.skuType ?? "").trim().toLowerCase();
  return type === "material" || type === "equipment";
}

function sum(values: number[]): number {
  return roundMoney(values.reduce((total, value) => total + value, 0));
}

export function summarizeServiceTitanReads(input: {
  estimates: readonly EstimateRead[] | null;
  invoices: readonly InvoiceHeaderRead[] | null;
  projectRetainage?: number | null;
}): ServiceTitanSummaryNumbers {
  const result: ServiceTitanSummaryNumbers = { ...EMPTY };
  if (input.estimates) {
    result.estimatesRead = true;
    const seen = new Set<string>();
    const soldEstimates = input.estimates.filter((estimate) => {
      if (!sold(estimate) || seen.has(estimate.id)) return false;
      seen.add(estimate.id);
      return true;
    });
    const prices = soldEstimates.map(estimatePrice);
    result.contractValue = prices.some((price) => price == null) ? null : sum(prices as number[]);

    const flags = soldEstimates.map((estimate) => estimate.isChangeOrder);
    const changeOrderPrices = soldEstimates
      .filter((estimate) => estimate.isChangeOrder === true)
      .map(estimatePrice);
    if (flags.some((flag) => flag == null) || changeOrderPrices.some((price) => price == null)) {
      result.changeOrders = null;
    } else {
      result.changeOrders = sum(changeOrderPrices as number[]);
    }

    if (soldEstimates.some((estimate) => estimate.items == null)) {
      result.totalBudgetedExpense = null;
      result.costAdjustments = null;
      result.budgetedLaborExpense = null;
      result.budgetedLaborHours = null;
      result.budgetedMaterials = null;
    } else {
      const items = soldEstimates.flatMap((estimate) => estimate.items ?? []);
      const costs = items.map((item) => item.totalCost);
      result.totalBudgetedExpense = costs.some((cost) => cost == null) ? null : sum(costs as number[]);

      const costOnly = soldEstimates.filter((estimate) => {
        const lines = estimate.items ?? [];
        if (!lines.length) return false;
        const priced = lines.some((item) => item.total != null && item.total !== 0);
        const hasCost = lines.some((item) => item.totalCost != null);
        return !priced && hasCost;
      });
      const adjustmentCosts = costOnly.flatMap((estimate) =>
        (estimate.items ?? []).map((item) => item.totalCost),
      );
      result.costAdjustments = adjustmentCosts.some((cost) => cost == null)
        ? null
        : sum(adjustmentCosts as number[]);

      if (items.some((item) => item.skuType == null)) {
        result.budgetedLaborExpense = null;
        result.budgetedLaborHours = null;
        result.budgetedMaterials = null;
      } else {
        const labor = items.filter(isLabor);
        const materials = items.filter(isMaterial);
        const laborCosts = labor.map((item) => item.totalCost);
        const materialCosts = materials.map((item) => item.totalCost);
        result.budgetedLaborExpense = laborCosts.some((cost) => cost == null)
          ? null
          : sum(laborCosts as number[]);
        result.budgetedMaterials = materialCosts.some((cost) => cost == null)
          ? null
          : sum(materialCosts as number[]);
        const hours = labor.map((item) => {
          if (item.soldHours == null) return null;
          const qty = item.qty == null ? 1 : item.qty;
          return item.soldHours * qty;
        });
        result.budgetedLaborHours = hours.some((hour) => hour == null) ? null : sum(hours as number[]);
      }
    }
  }

  if (input.invoices) {
    result.invoicesRead = true;
    const seen = new Set<string>();
    const active = input.invoices.filter((invoice) => {
      if (!invoice.active || seen.has(invoice.id)) return false;
      seen.add(invoice.id);
      return true;
    });
    const totals = active.map((invoice) => invoice.total);
    const balances = active.map((invoice) => invoice.balance);
    result.billed = totals.some((total) => total == null) ? null : sum(totals as number[]);
    result.openInvoices = balances.some((balance) => balance == null)
      ? null
      : sum((balances as number[]).filter((balance) => balance > 0));
    const retainageValues = active.map((invoice) => invoice.retainage);
    const invoiceRetainage = retainageValues.some((value) => value == null)
      ? null
      : sum(retainageValues as number[]);
    if (input.projectRetainage != null && Number.isFinite(input.projectRetainage)) {
      result.retainage = roundMoney(input.projectRetainage);
    } else {
      result.retainage = invoiceRetainage;
    }
  } else if (input.projectRetainage != null && Number.isFinite(input.projectRetainage)) {
    result.retainage = roundMoney(input.projectRetainage);
  }
  return result;
}
