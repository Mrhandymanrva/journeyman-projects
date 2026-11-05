import type { SqlClient } from "../db/database.js";

/**
 * Match ServiceTitan invoice observations to draws, and sold estimates to
 * local change orders. The match is trim and ignore-case. A blank draw number
 * is never filled. Dollars on a sold estimate stay out of the budget until
 * someone uses Approve.
 */

export interface ObservedInvoice {
  externalInvoiceId: string;
  invoiceNumber: string;
  externalJobId: string | null;
  total: number;
  balance: number;
  invoicedOn: string | null;
  paidOn: string | null;
}

export interface ObservedPayment {
  externalPaymentId: string;
  externalInvoiceId: string;
  amount: number;
  paidOn: string | null;
}

export interface ObservedEstimate {
  externalEstimateId: string;
  name: string | null;
  externalJobId: string | null;
  status: string;
  soldOn: string | null;
  customerAmount: number;
}

export interface ArRead {
  forbidden: boolean;
  invoices: ObservedInvoice[];
  payments: ObservedPayment[];
  estimates: ObservedEstimate[];
}

export interface InvoiceView {
  external_invoice_id: string;
  invoice_number: string;
  external_job_id: string | null;
  total: number;
  balance: number;
  paid_on: string | null;
  invoiced_on: string | null;
}

export interface DrawMatch {
  state: "matched" | "suggested" | "none";
  invoice_number: string | null;
  total: number | null;
  balance: number | null;
  paid_on: string | null;
  verified_at: string | null;
}

export function invoiceKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

export function annotateDrawList<T extends Record<string, unknown>>(
  draws: T[],
  invoices: InvoiceView[],
): { draws: Array<T & { match: DrawMatch; suggestion: InvoiceView | null }>; unmatched_invoices: InvoiceView[] } {
  const used = new Set(
    draws
      .map((draw) => invoiceKey(draw.external_invoice_number as string | null))
      .filter((key): key is string => key !== null),
  );
  const unmatched = invoices.filter((invoice) => !used.has(invoiceKey(invoice.invoice_number) ?? ""));
  const suggestion = unmatched.length === 1 ? unmatched[0]! : null;
  return {
    unmatched_invoices: unmatched,
    draws: draws.map((draw) => {
      const key = invoiceKey(draw.external_invoice_number as string | null);
      const hit = key
        ? invoices.find((invoice) => invoiceKey(invoice.invoice_number) === key) ?? null
        : null;
      if (hit) {
        return {
          ...draw,
          suggestion: null,
          match: {
            state: "matched" as const,
            invoice_number: hit.invoice_number,
            total: hit.total,
            balance: hit.balance,
            paid_on: hit.paid_on,
            verified_at: dateOut(draw.external_invoice_verified_at),
          },
        };
      }
      if (!key && suggestion) {
        return {
          ...draw,
          suggestion,
          match: {
            state: "suggested" as const,
            invoice_number: suggestion.invoice_number,
            total: suggestion.total,
            balance: suggestion.balance,
            paid_on: suggestion.paid_on,
            verified_at: null,
          },
        };
      }
      return {
        ...draw,
        suggestion: null,
        match: {
          state: "none" as const,
          invoice_number: null,
          total: null,
          balance: null,
          paid_on: null,
          verified_at: null,
        },
      };
    }),
  };
}

function dateOut(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  return null;
}

export async function storeProjectAr(
  db: SqlClient,
  input: {
    tenantId: string;
    projectId: string;
    externalSystemId: string;
    jobIds: string[];
    read: ArRead;
    observedAt?: Date;
  },
): Promise<void> {
  if (input.read.forbidden) return;
  const jobs = new Set(input.jobIds);
  const invoices = input.read.invoices.filter(
    (row) => row.externalJobId && jobs.has(row.externalJobId) && invoiceKey(row.invoiceNumber),
  );
  const invoiceIds = invoices.map((row) => row.externalInvoiceId);
  const observedAt = input.observedAt ?? new Date();

  const original = await db.query<{ source_key: string; payload: unknown }>(
    `SELECT e.source_key, e.payload
       FROM projects.projects p
       JOIN projects.estimate_imports e ON e.id = p.estimate_import_id
      WHERE p.id = $1`,
    [input.projectId],
  );
  const originalKeys = new Set<string>();
  for (const row of original.rows) {
    const key = invoiceKey(row.source_key);
    if (key) originalKeys.add(key);
    if (row.payload && typeof row.payload === "object") {
      const payload = row.payload as Record<string, unknown>;
      for (const field of ["id", "external_id", "estimate_id"]) {
        const extra = invoiceKey(payload[field]);
        if (extra) originalKeys.add(extra);
      }
    }
  }

  await db.query(
    `DELETE FROM projects.st_payment_applications
      WHERE tenant_id = $1
        AND external_invoice_id IN (
          SELECT external_invoice_id FROM projects.st_invoice_observations WHERE project_id = $2
          UNION
          SELECT unnest($3::text[])
        )`,
    [input.tenantId, input.projectId, invoiceIds],
  );
  await db.query(`DELETE FROM projects.st_invoice_observations WHERE project_id = $1`, [input.projectId]);
  await db.query(`DELETE FROM projects.st_estimate_observations WHERE project_id = $1`, [input.projectId]);

  for (const invoice of invoices) {
    await db.query(
      `INSERT INTO projects.st_invoice_observations
         (tenant_id, project_id, external_system_id, external_invoice_id, invoice_number,
          external_job_id, total, balance, invoiced_on, paid_on, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id, external_system_id, external_invoice_id) DO UPDATE
         SET project_id = EXCLUDED.project_id,
             invoice_number = EXCLUDED.invoice_number,
             external_job_id = EXCLUDED.external_job_id,
             total = EXCLUDED.total,
             balance = EXCLUDED.balance,
             invoiced_on = EXCLUDED.invoiced_on,
             paid_on = EXCLUDED.paid_on,
             observed_at = EXCLUDED.observed_at`,
      [
        input.tenantId,
        input.projectId,
        input.externalSystemId,
        invoice.externalInvoiceId,
        invoice.invoiceNumber.trim(),
        invoice.externalJobId,
        round2(invoice.total),
        round2(invoice.balance),
        day(invoice.invoicedOn),
        day(invoice.paidOn),
        observedAt,
      ],
    );
  }

  const kept = new Set(invoiceIds);
  for (const payment of input.read.payments) {
    if (!kept.has(payment.externalInvoiceId)) continue;
    await db.query(
      `INSERT INTO projects.st_payment_applications
         (tenant_id, external_system_id, external_payment_id, external_invoice_id, amount, paid_on, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, external_payment_id, external_invoice_id) DO UPDATE
         SET amount = EXCLUDED.amount, paid_on = EXCLUDED.paid_on, observed_at = EXCLUDED.observed_at`,
      [
        input.tenantId,
        input.externalSystemId,
        payment.externalPaymentId,
        payment.externalInvoiceId,
        round2(payment.amount),
        day(payment.paidOn),
        observedAt,
      ],
    );
  }

  for (const estimate of input.read.estimates) {
    if (!estimate.externalJobId || !jobs.has(estimate.externalJobId)) continue;
    const idKey = invoiceKey(estimate.externalEstimateId);
    const nameKey = invoiceKey(estimate.name);
    const classification =
      (idKey && originalKeys.has(idKey)) || (nameKey && originalKeys.has(nameKey))
        ? "original"
        : estimate.status.trim().toLowerCase() === "sold"
          ? "change_order"
          : "unknown";
    await db.query(
      `INSERT INTO projects.st_estimate_observations
         (tenant_id, project_id, external_system_id, external_estimate_id, name, external_job_id,
          status, sold_on, customer_amount, classification, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id, external_estimate_id) DO UPDATE
         SET project_id = EXCLUDED.project_id,
             external_system_id = EXCLUDED.external_system_id,
             name = EXCLUDED.name,
             external_job_id = EXCLUDED.external_job_id,
             status = EXCLUDED.status,
             sold_on = EXCLUDED.sold_on,
             customer_amount = EXCLUDED.customer_amount,
             classification = EXCLUDED.classification,
             observed_at = EXCLUDED.observed_at`,
      [
        input.tenantId,
        input.projectId,
        input.externalSystemId,
        estimate.externalEstimateId,
        estimate.name,
        estimate.externalJobId,
        estimate.status,
        day(estimate.soldOn),
        round2(estimate.customerAmount),
        classification,
        observedAt,
      ],
    );
  }

  await db.query(
    `UPDATE projects.st_estimate_observations e
        SET change_order_id = (
          SELECT co.id FROM projects.change_orders co
           WHERE co.project_id = e.project_id
             AND (
               lower(btrim(co.st_estimate_number)) IN (lower(btrim(e.external_estimate_id)), lower(btrim(COALESCE(e.name, ''))))
               OR lower(btrim(co.external_estimate_ref)) IN (lower(btrim(e.external_estimate_id)), lower(btrim(COALESCE(e.name, ''))))
             )
           ORDER BY (co.status = 'approved') DESC, co.co_number
           LIMIT 1
        )
      WHERE e.project_id = $1`,
    [input.projectId],
  );

  await db.query(
    `UPDATE projects.draws d
        SET external_invoice_verified_at = NULL
      WHERE d.project_id = $1
        AND d.external_invoice_verified_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM projects.st_invoice_observations i
           WHERE i.project_id = d.project_id
             AND lower(btrim(i.invoice_number)) = lower(btrim(d.external_invoice_number))
        )`,
    [input.projectId],
  );

  await db.query(
    `UPDATE projects.draws d
        SET external_invoice_verified_at = $2,
            status = CASE
              WHEN d.status = 'invoiced' AND i.balance = 0 THEN 'paid'::projects.draw_status
              WHEN d.status = 'paid' AND i.balance > 0 THEN 'invoiced'::projects.draw_status
              ELSE d.status
            END,
            paid_on = CASE
              WHEN d.status = 'invoiced' AND i.balance = 0 THEN COALESCE(i.paid_on, i.invoiced_on, CURRENT_DATE)
              WHEN d.status = 'paid' AND i.balance > 0 THEN NULL
              WHEN d.status = 'paid' AND i.balance = 0 THEN COALESCE(d.paid_on, i.paid_on, i.invoiced_on)
              ELSE d.paid_on
            END
       FROM projects.st_invoice_observations i
      WHERE d.project_id = $1
        AND i.project_id = d.project_id
        AND NULLIF(btrim(d.external_invoice_number), '') IS NOT NULL
        AND lower(btrim(i.invoice_number)) = lower(btrim(d.external_invoice_number))`,
    [input.projectId, observedAt],
  );
}

export async function loadProjectInvoices(db: SqlClient, projectId: string): Promise<InvoiceView[]> {
  const { rows } = await db.query<{
    external_invoice_id: string;
    invoice_number: string;
    external_job_id: string | null;
    total: string;
    balance: string;
    paid_on: string | null;
    invoiced_on: string | null;
  }>(
    `SELECT external_invoice_id, invoice_number, external_job_id, total::text, balance::text,
            paid_on::text, invoiced_on::text
       FROM projects.st_invoice_observations
      WHERE project_id = $1
      ORDER BY observed_at DESC, invoice_number`,
    [projectId],
  );
  return rows.map((row) => ({
    external_invoice_id: row.external_invoice_id,
    invoice_number: row.invoice_number,
    external_job_id: row.external_job_id,
    total: Number(row.total),
    balance: Number(row.balance),
    paid_on: row.paid_on,
    invoiced_on: row.invoiced_on,
  }));
}

export interface SoldEstimateView {
  id: string;
  name: string | null;
  sold_on: string | null;
  customer_amount: number;
  classification: string;
  change_order_id: string | null;
}

export async function loadProjectEstimates(db: SqlClient, projectId: string): Promise<SoldEstimateView[]> {
  const { rows } = await db.query<{
    external_estimate_id: string;
    name: string | null;
    sold_on: string | null;
    customer_amount: string;
    classification: string;
    change_order_id: string | null;
  }>(
    `SELECT external_estimate_id, name, sold_on::text, customer_amount::text, classification, change_order_id
       FROM projects.st_estimate_observations
      WHERE project_id = $1
      ORDER BY sold_on NULLS LAST, name`,
    [projectId],
  );
  return rows.map((row) => ({
    id: row.external_estimate_id,
    name: row.name,
    sold_on: row.sold_on,
    customer_amount: Number(row.customer_amount),
    classification: row.classification,
    change_order_id: row.change_order_id,
  }));
}

export async function pendingEstimateRevision(db: SqlClient, projectId: string): Promise<number> {
  const { rows } = await db.query<{ amount: string }>(
    `SELECT COALESCE(SUM(e.customer_amount), 0)::text AS amount
       FROM projects.st_estimate_observations e
       LEFT JOIN projects.change_orders co ON co.id = e.change_order_id
      WHERE e.project_id = $1
        AND e.classification = 'change_order'
        AND (co.id IS NULL OR co.status <> 'approved')`,
    [projectId],
  );
  return round2(Number(rows[0]?.amount ?? 0));
}

export interface PortfolioAr {
  draws_matched: number;
  draws_suggested: number;
  unmatched_invoices: number;
  unpaid_amount: number;
  pending_estimate_revisions: number;
}

export function portfolioArColumns(alias = "p"): string {
  const unused = `(SELECT count(*) FROM projects.st_invoice_observations i
        WHERE i.project_id = ${alias}.id
          AND NOT EXISTS (
            SELECT 1 FROM projects.draws d
             WHERE d.project_id = i.project_id
               AND lower(btrim(d.external_invoice_number)) = lower(btrim(i.invoice_number))
          ))`;
  return `(SELECT count(*)::int FROM projects.draws d
            WHERE d.project_id = ${alias}.id
              AND EXISTS (
                SELECT 1 FROM projects.st_invoice_observations i
                 WHERE i.project_id = d.project_id
                   AND lower(btrim(i.invoice_number)) = lower(btrim(d.external_invoice_number))
              )) AS ar_draws_matched,
          (CASE WHEN ${unused} = 1 THEN (
             SELECT count(*)::int FROM projects.draws d
              WHERE d.project_id = ${alias}.id
                AND NULLIF(btrim(d.external_invoice_number), '') IS NULL
           ) ELSE 0 END) AS ar_draws_suggested,
          ${unused}::int AS ar_unmatched_invoices,
          (SELECT COALESCE(SUM(i.balance), 0) FROM projects.st_invoice_observations i
            WHERE i.project_id = ${alias}.id AND i.balance > 0)::text AS ar_unpaid_amount,
          (SELECT COALESCE(SUM(e.customer_amount), 0)
             FROM projects.st_estimate_observations e
             LEFT JOIN projects.change_orders co ON co.id = e.change_order_id
            WHERE e.project_id = ${alias}.id
              AND e.classification = 'change_order'
              AND (co.id IS NULL OR co.status <> 'approved'))::text AS ar_pending_revisions`;
}

export const PORTFOLIO_AR_KEYS = [
  "ar_draws_matched",
  "ar_draws_suggested",
  "ar_unmatched_invoices",
  "ar_unpaid_amount",
  "ar_pending_revisions",
] as const;

export function presentPortfolioAr(row: Record<string, unknown>): PortfolioAr {
  return {
    draws_matched: Number(row.ar_draws_matched ?? 0),
    draws_suggested: Number(row.ar_draws_suggested ?? 0),
    unmatched_invoices: Number(row.ar_unmatched_invoices ?? 0),
    unpaid_amount: round2(Number(row.ar_unpaid_amount ?? 0)),
    pending_estimate_revisions: round2(Number(row.ar_pending_revisions ?? 0)),
  };
}

export const AR_READ_REFUSED = "ServiceTitan did not allow this read. Existing invoices were left as they are.";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function day(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1]! : null;
}
