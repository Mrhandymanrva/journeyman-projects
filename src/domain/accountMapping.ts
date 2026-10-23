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

/**
 * Job-cost words for the cost types this app actually stores: L, M, S, O.
 * There is no equipment cost type, so equipment rental is not a mapping target.
 * Phrases are matched as whole words and tolerate a trailing plural.
 */
const KEYWORDS: Record<CostType, readonly string[]> = {
  L: ['job labor', 'field labor', 'labor', 'labour', 'wages', 'payroll'],
  M: ['job materials', 'materials', 'supplies'],
  S: ['subcontractors', 'subcontractor', 'subcontract', 'sub contract', 'subs'],
  O: ['other job costs', 'other costs of goods sold', 'miscellaneous job costs'],
};

const NOT_AN_EXPENSE =
  /income|asset|liabilit|equity|\bbank\b|receivable|payable|credit card|undeposited|opening balance/i;

/** Vehicle, office, and marketing accounts are not job-cost matches for L/M/S/O. */
const EXCLUDED_TOKENS = new Set([
  'vehicle',
  'van',
  'auto',
  'automobile',
  'fuel',
  'truck',
  'office',
  'admin',
  'administrative',
  'marketing',
  'advertising',
  'advertisement',
  'directory',
]);

export function emptyAccountMapping(): AccountMapping {
  return { L: null, M: null, S: null, O: null };
}

function accountType(account: CatalogAccount): string {
  return String(
    account.accountType ?? account.account_type ?? account.AccountType ?? account.classification ?? '',
  ).toLowerCase();
}

function plausibleExpense(account: CatalogAccount): boolean {
  const type = accountType(account);
  if (type) return type === 'expense' || type === 'cost of goods sold' || type === 'cogs';
  return !NOT_AN_EXPENSE.test(account.name);
}

function normalizeToken(word: string): string {
  const lower = word.toLowerCase();
  if (lower.endsWith('ies') && lower.length > 4) return lower.slice(0, -3) + 'y';
  if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 3) return lower.slice(0, -1);
  return lower;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(normalizeToken);
}

function phraseIn(text: string, phrase: string): boolean {
  const haystack = tokens(text);
  const needle = tokens(phrase);
  if (!needle.length || haystack.length < needle.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    if (needle.every((part, offset) => haystack[i + offset] === part)) return true;
  }
  return false;
}

function excludedAccount(name: string): boolean {
  return tokens(name).some((token) => EXCLUDED_TOKENS.has(token));
}

function isCogs(account: CatalogAccount): boolean {
  const type = accountType(account);
  if (type === 'cost of goods sold' || type === 'cogs') return true;
  const parents = account.name
    .split(':')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, -1);
  return parents.some((part) => /^(cost of goods sold|cogs)$/i.test(part));
}

/** A keyword hit is required. Cost of Goods Sold parentage only ranks a real hit. */
function scoreAccount(account: CatalogAccount, type: CostType): number {
  const parts = account.name
    .split(':')
    .map((part) => part.trim())
    .filter(Boolean);
  const leaf = parts[parts.length - 1] ?? account.name;
  const parents = parts.slice(0, -1).join(' ');
  let best = 0;
  for (const keyword of KEYWORDS[type]) {
    if (phraseIn(leaf, keyword)) best = Math.max(best, 100 + keyword.length);
    else if (parents && phraseIn(parents, keyword)) best = Math.max(best, 40 + keyword.length);
  }
  if (best === 0) return 0;
  if (isCogs(account)) best += 200;
  return best;
}

/**
 * Propose a cost-type mapping from chart-of-account names already stored on
 * the tenant. This does not call QuickBooks and does not write anything.
 * An account is offered only to the cost type it scores highest for, COGS
 * accounts rank ahead of other expenses, and a weak name returns no suggestion.
 * The owner confirms before a mapping is saved.
 */
export function suggestAccountMapping(accounts: CatalogAccount[]): AccountMapping {
  const candidates: Array<{ id: string; type: CostType; score: number }> = [];
  for (const account of accounts) {
    if (!plausibleExpense(account) || excludedAccount(account.name)) continue;
    const scores = COST_TYPES.map((type) => ({ type, score: scoreAccount(account, type) })).filter(
      (row) => row.score > 0,
    );
    const best = scores.reduce((max, row) => Math.max(max, row.score), 0);
    if (best === 0) continue;
    for (const row of scores) {
      if (row.score !== best) continue;
      candidates.push({ id: String(account.id), type: row.type, score: row.score });
    }
  }
  const typeRank: Record<CostType, number> = { L: 0, M: 1, S: 2, O: 3 };
  candidates.sort((a, b) => b.score - a.score || typeRank[a.type] - typeRank[b.type]);
  const used = new Set<string>();
  const suggested = emptyAccountMapping();
  for (const row of candidates) {
    if (suggested[row.type] || used.has(row.id)) continue;
    suggested[row.type] = row.id;
    used.add(row.id);
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
