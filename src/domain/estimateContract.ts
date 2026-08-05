import { z } from 'zod';
import type { SqlClient } from '../db/database.js';
import { ApiError, validationFailed } from '../http/errors.js';

/**
 * The module boundary, in code.
 *
 * Nothing in this file may query the estimating schema. If a field is missing,
 * the contract version changes and this file grows a v2 parser — the handler
 * does not reach across. Module Addendum §3.
 */

export const SUPPORTED_CONTRACT_VERSIONS = ['estimate.v1'] as const;
export type ContractVersion = (typeof SUPPORTED_CONTRACT_VERSIONS)[number];

export const costTypeSchema = z.enum(['L', 'M', 'S', 'O']);

export const estimateV1LineSchema = z.object({
  code: z.string().min(1),
  description: z.string().min(1),
  quantity: z.number().finite(),
  unit: z.string().min(1),
  cost_type: costTypeSchema,
  amount: z.number().finite(),
});

export const estimateV1PayloadSchema = z.object({
  sold_price: z.number().finite().positive(),
  currency: z.string().length(3).default('USD'),
  lines: z.array(estimateV1LineSchema).min(1),
});

export const estimateImportSchema = z.object({
  contract_version: z.string().min(1),
  source_kind: z.enum(['journeyman_estimate', 'external', 'manual']),
  source_key: z.string().min(1),
  payload: z.unknown(),
});

export type EstimateV1Payload = z.infer<typeof estimateV1PayloadSchema>;

export function parseEstimatePayload(contractVersion: string, payload: unknown): EstimateV1Payload {
  if (!(SUPPORTED_CONTRACT_VERSIONS as readonly string[]).includes(contractVersion)) {
    // 422, never a best-effort parse. A payload we half-understand becomes a
    // budget that silently disagrees with the sold price.
    throw new ApiError(
      'contract_version_unsupported',
      `Contract version ${contractVersion} is not supported.`,
      { supported: SUPPORTED_CONTRACT_VERSIONS },
    );
  }
  const result = estimateV1PayloadSchema.safeParse(payload);
  if (!result.success) {
    throw validationFailed(
      result.error.issues.map((i) => ({
        field: `payload.${i.path.join('.')}`,
        message: i.message,
      })),
      'Estimate payload does not match the contract.',
    );
  }
  return result.data;
}

export interface DerivedBudgetLine {
  costCodeId: string;
  costType: 'L' | 'M' | 'S' | 'O';
  amount: number;
  note: string;
}

/**
 * Estimate lines become budget lines by cost code.
 *
 * Two rules the contract is explicit about, both here rather than in the
 * caller so there is one place they can be true:
 *
 *  - An unrecognised code is a validation error, not a dropped line. A silent
 *    drop produces a budget that does not equal the sold price and nobody
 *    knows why, six weeks later, on a job that is already framed.
 *  - Lines that share a code and cost type are summed. budget_lines is unique
 *    on (project_id, cost_code_id, cost_type), so an estimate that itemises
 *    three tile lines has to arrive as one budget line, not three conflicting
 *    inserts.
 */
export async function deriveBudgetLines(
  db: SqlClient,
  payload: EstimateV1Payload,
): Promise<DerivedBudgetLine[]> {
  const codes = [...new Set(payload.lines.map((l) => l.code))];
  const { rows } = await db.query<{ id: string; code: string }>(
    `SELECT id, code FROM projects.cost_codes WHERE code = ANY($1::text[]) AND active`,
    [codes],
  );
  const byCode = new Map(rows.map((r) => [r.code, r.id]));

  const unknown = codes.filter((c) => !byCode.has(c));
  if (unknown.length > 0) {
    throw validationFailed(
      unknown.map((code) => ({
        field: 'payload.lines[].code',
        message: `Cost code ${code} does not exist in this account's cost code list`,
      })),
      'The estimate references cost codes this account does not have.',
    );
  }

  const grouped = new Map<string, DerivedBudgetLine>();
  for (const line of payload.lines) {
    const costCodeId = byCode.get(line.code)!;
    const key = `${costCodeId}:${line.cost_type}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.amount = round2(existing.amount + line.amount);
      existing.note = `${existing.note}; ${line.description}`;
    } else {
      grouped.set(key, {
        costCodeId,
        costType: line.cost_type,
        amount: round2(line.amount),
        note: line.description,
      });
    }
  }
  return [...grouped.values()];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
