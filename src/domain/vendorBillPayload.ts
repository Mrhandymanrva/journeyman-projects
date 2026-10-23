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
 * Expense account for a cost type.
 *
 * Whether L/M/S/O each post to their own QuickBooks account is still open.
 * Until that mapping exists, every cost type uses the account chosen on the
 * bill. Lines are still split by cost type so a future mapping only changes
 * this function. One cost type stays one QuickBooks line.
 */
export function expenseAccountForCostType(_costType: string, defaultAccountId: string): string {
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

/** The QuickBooks bill is the full Journeyman amount, split by cost type when that split still adds up. */
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
}): { DocNumber: string; TxnDate: string; DueDate: string; PrivateNote: string; Line: QbLine[] } {
  const positive = input.groups.filter((group) => group.amount > 0);
  const groupedTotal = roundMoney(positive.reduce((sum, group) => sum + group.amount, 0));
  const source =
    positive.length > 0 && Math.abs(groupedTotal - input.amount) <= 0.001
      ? positive
      : [{ costType: '', amount: input.amount }];
  const lines: QbLine[] = source.map((group) => ({
    Amount: roundMoney(group.amount),
    Description: (
      input.description ||
      `Project ${input.projectNumber} / PO ${input.poNumber}${group.costType ? ` / ${group.costType}` : ''}`
    ).slice(0, 4000),
    DetailType: 'AccountBasedExpenseLineDetail',
    AccountBasedExpenseLineDetail: detail(expenseAccountForCostType(group.costType, input.accountId), input.customerId),
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
