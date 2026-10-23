import type { SqlClient } from '../db/database.js';

export const COST_TYPES = ['L', 'M', 'S', 'O'] as const;
export type CostType = (typeof COST_TYPES)[number];

export interface AccountMapping {
  L: string | null;
  M: string | null;
  S: string | null;
  O: string | null;
}

export interface CatalogAccount {
  id: string;
  name: string;
  accountType?: string | null;
  account_type?: string | null;
  AccountType?: string | null;
  classification?: string | null;
}

const SUGGESTIONS: Record<CostType, RegExp> = {
  L: /labor|labour|wages|payroll|field labor/i,
  M: /material|supplies|\bpurchases\b/i,
  S: /subcontract|sub-contract|outside service|1099|contract labor|independent contractor/i,
  O: /\b(?:overhead|general expense|miscellaneous(?: expense)?|operating expense)\b/i,
};

const NOT_AN_EXPENSE =
  /income|asset|liabilit|equity|\bbank\b|receivable|payable|credit card|undeposited|opening balance|advertis|director/i;

export function emptyAccountMapping(): AccountMapping {
  return { L: null, M: null, S: null, O: null };
}

/**
 * Propose a cost-type mapping from chart-of-account names already stored on
 * the tenant. This does not call QuickBooks and does not write anything.
 * The first unused match wins, in L, M, S, O order, so one account is not
 * suggested for two cost types. The owner confirms before a mapping is saved.
 */
function accountType(account: CatalogAccount): string {
  return String(
    account.accountType ?? account.account_type ?? account.AccountType ?? account.classification ?? '',
  ).toLowerCase();
}

/** The leaf is what the cost type is. A parent of "Cost of Goods Sold" must not steal a subcontract child. */
function leafName(name: string): string {
  const parts = name.split(':');
  return (parts[parts.length - 1] ?? name).trim();
}

function plausibleExpense(account: CatalogAccount): boolean {
  const type = accountType(account);
  if (type) return type === 'expense' || type === 'cost of goods sold' || type === 'cogs';
  return !NOT_AN_EXPENSE.test(account.name);
}

/**
 * Propose a cost-type mapping from chart-of-account names already stored on
 * the tenant. This does not call QuickBooks and does not write anything.
 * The first unused plausible match wins, in L, M, S, O order. A name that is
 * income, an asset, advertising, or otherwise not an expense or COGS account
 * is not suggested. The owner confirms before a mapping is saved.
 */
export function suggestAccountMapping(accounts: CatalogAccount[]): AccountMapping {
  const used = new Set<string>();
  const suggested = emptyAccountMapping();
  for (const type of COST_TYPES) {
    const match = accounts.find((account) => {
      if (used.has(String(account.id)) || !plausibleExpense(account)) return false;
      const leaf = leafName(account.name);
      if (type === 'M' && /cost of goods sold|^cogs$/i.test(leaf)) return true;
      return SUGGESTIONS[type].test(leaf);
    });
    if (!match) continue;
    suggested[type] = String(match.id);
    used.add(String(match.id));
  }
  return suggested;
}

export async function loadCostTypeAccounts(
  db: SqlClient,
): Promise<{ graceDays: number; accounts: AccountMapping }> {
  const { rows } = await db.query<{
    agreement_grace_days: number | null;
    qbo_account_labor: string | null;
    qbo_account_material: string | null;
    qbo_account_subcontract: string | null;
    qbo_account_other: string | null;
  }>(
    `SELECT agreement_grace_days,
            qbo_account_labor, qbo_account_material,
            qbo_account_subcontract, qbo_account_other
       FROM projects.tenant_settings`,
  );
  const row = rows[0];
  return {
    graceDays: row?.agreement_grace_days ?? 14,
    accounts: {
      L: row?.qbo_account_labor ?? null,
      M: row?.qbo_account_material ?? null,
      S: row?.qbo_account_subcontract ?? null,
      O: row?.qbo_account_other ?? null,
    },
  };
}
