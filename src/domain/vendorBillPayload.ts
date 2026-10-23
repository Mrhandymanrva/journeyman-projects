import type { AccountMapping } from './accountMapping.js';
import { roundMoney } from './poMath.js';

export interface BillCostGroup {
  costType: string;
  amount: number;
}

export interface QbLine {
  Amount: number;
  Description: string;
  DetailType: 'AccountBasedExpenseLineDetail';
  AccountBasedExpenseLineDetail: {
    AccountRef: { value: string };
    CustomerRef?: { value: string };
    BillableStatus?: 'NotBillable';
  };
}

/**
 * Expense account for a cost type. A saved per-tenant mapping wins. An
 * unmapped cost type uses the account chosen on the bill.
 */
export function expenseAccountForCostType(
  costType: string,
  defaultAccountId: string,
  mapping?: Partial<AccountMapping> | null,
): string {
  const mapped = mapping?.[costType as keyof AccountMapping];
  if (mapped && /^[0-9]+$/.test(mapped)) return mapped;
  return defaultAccountId;
}

export function sumLineAmounts(lines: Array<{ Amount: number }>): number {
  return roundMoney(lines.reduce((sum, line) => sum + Number(line.Amount), 0));
}

export function explainBridgeLineRejection(lineCount: number, bridgeMessage: string): string | null {
  if (lineCount <= 1) return null;
  if (!/line|schema|invalid|unrecognized|expected|positive|length/i.test(bridgeMessage)) return null;
  return (
    `The QuickBooks bridge rejected a bill with ${lineCount} lines. ` +
    `Nothing was confirmed in QuickBooks. ${bridgeMessage}`
  );
}

function detail(accountId: string, customerId: string | null): QbLine['AccountBasedExpenseLineDetail'] {
  return {
    AccountRef: { value: accountId },
    ...(customerId ? { CustomerRef: { value: customerId }, BillableStatus: 'NotBillable' as const } : {}),
  };
}

/**
 * The QuickBooks bill is the full Journeyman amount. Positive cost-type
 * groups that add up to that amount are posted to their mapped expense
 * accounts, and groups that resolve to the same account are combined.
 * Anything unmapped uses the account chosen on the bill.
 */
export function buildVendorBillPayload(input: {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  projectNumber: string;
  projectName: string;
  poNumber: string;
  amount: number;
  description: string;
  accountId: string;
  customerId: string | null;
  groups: BillCostGroup[];
  accounts?: Partial<AccountMapping> | null;
}): { DocNumber: string; TxnDate: string; DueDate: string; PrivateNote: string; Line: QbLine[] } {
  const positive = input.groups.filter((group) => group.amount > 0);
  const groupedTotal = roundMoney(positive.reduce((sum, group) => sum + group.amount, 0));
  const source =
    positive.length > 0 && Math.abs(groupedTotal - input.amount) <= 0.001
      ? positive
      : [{ costType: '', amount: input.amount }];
  const buckets: Array<{ accountId: string; amount: number; costTypes: string[] }> = [];
  for (const group of source) {
    const accountId = expenseAccountForCostType(group.costType, input.accountId, input.accounts);
    const existing = buckets.find((bucket) => bucket.accountId === accountId);
    if (existing) {
      existing.amount = roundMoney(existing.amount + group.amount);
      if (group.costType) existing.costTypes.push(group.costType);
    } else {
      buckets.push({
        accountId,
        amount: roundMoney(group.amount),
        costTypes: group.costType ? [group.costType] : [],
      });
    }
  }
  const lines: QbLine[] = buckets.map((bucket) => ({
    Amount: bucket.amount,
    Description: (
      input.description ||
      `Project ${input.projectNumber} / PO ${input.poNumber}${
        bucket.costTypes.length ? ` / ${bucket.costTypes.join(',')}` : ''
      }`
    ).slice(0, 4000),
    DetailType: 'AccountBasedExpenseLineDetail',
    AccountBasedExpenseLineDetail: detail(bucket.accountId, input.customerId),
  }));
  const drift = roundMoney(input.amount - sumLineAmounts(lines));
  if (lines.length && drift !== 0) {
    lines[lines.length - 1]!.Amount = roundMoney(lines[lines.length - 1]!.Amount + drift);
  }
  return {
    DocNumber: input.invoiceNumber,
    TxnDate: input.invoiceDate.slice(0, 10),
    DueDate: input.dueDate.slice(0, 10),
    PrivateNote: `Journeyman PM bill ${input.id} | Project ${input.projectNumber}: ${input.projectName} | PO ${input.poNumber}`,
    Line: lines,
  };
}
