import { loadCostTypeAccounts } from './accountMapping.js';
import type { SqlClient } from '../db/database.js';
import { ApiError } from '../http/errors.js';

export type ComplianceStage = 'award' | 'issue' | 'bill_approval' | 'payment';

/**
 * COI and W-9 checks for a subcontract vendor.
 *
 * Award, issue, and bill approval use the same document rule as scheduling:
 * every requirement that blocks scheduling must be valid or expiring. Bill
 * approval also requires that document to have been unexpired on the invoice
 * date, even when the certificate is valid today. Payment (the QuickBooks
 * push, at queue time and again in the worker) adds the reviewed W-9: vendor
 * qbo id, attached W-9, and tax review.
 *
 * qbo_tax_reviewed_at is not required at award or issue. Nothing can set it
 * until a QuickBooks connector has synced the vendor, and a company without
 * that connector would otherwise be unable to issue a subcontract.
 *
 * Material POs never call this. Lien waivers are phase 4 and are not queried.
 */
export async function assertVendorCompliant(
  db: SqlClient,
  vendorId: string,
  stage: ComplianceStage,
  invoiceDate?: string | null,
): Promise<void> {
  const { rows } = await db.query<{
    legal_name: string;
    schedulable: boolean;
    expired_count: string;
    missing_count: string;
  }>(
    `SELECT legal_name, schedulable, expired_count::text AS expired_count,
            missing_count::text AS missing_count
       FROM projects.v_vendor_eligibility WHERE vendor_id = $1`,
    [vendorId],
  );
  const row = rows[0];
  if (!row || row.schedulable !== true) {
    const documents = await blockingDocuments(db, vendorId);
    throw new ApiError(
      'compliance_blocked',
      row
        ? `${row.legal_name} is blocked at ${stageLabel(stage)}: ` +
          `${row.missing_count} required document(s) missing, ${row.expired_count} expired.`
        : `This vendor has no compliance record and is blocked at ${stageLabel(stage)}.`,
      { vendor_id: vendorId, stage, documents: documents.map((d) => d.kind), states: documents },
    );
  }

  if (stage === 'bill_approval' && invoiceDate) {
    const stale = await db.query<{ kind: string; expires_on: string }>(
      `SELECT r.kind::text AS kind, d.expires_on::text AS expires_on
         FROM projects.compliance_requirements r
         LEFT JOIN LATERAL (
           SELECT vd.expires_on FROM projects.vendor_documents vd
            WHERE vd.vendor_id = $1
              AND (vd.kind = r.kind OR r.kind = ANY(vd.coverage_kinds))
            ORDER BY vd.expires_on DESC NULLS LAST LIMIT 1
         ) d ON true
        WHERE r.required AND r.blocks_scheduling
          AND d.expires_on IS NOT NULL
          AND d.expires_on < $2::date`,
      [vendorId, invoiceDate.slice(0, 10)],
    );
    if (stale.rows.length) {
      throw new ApiError(
        'compliance_blocked',
        `${row.legal_name} was not compliant on the invoice date ${invoiceDate.slice(0, 10)}: ` +
          stale.rows.map((d) => d.kind).join(', ') +
          ' expired before that date.',
        { vendor_id: vendorId, stage, documents: stale.rows.map((d) => d.kind), states: stale.rows },
      );
    }
  }

  if (stage === 'payment') {
    const vendor = await db.query<{
      qbo_id: string | null;
      qbo_w9_id: string | null;
      qbo_tax_reviewed_at: string | null;
      archived: boolean;
    }>(
      `SELECT qbo_id, qbo_w9_id, qbo_tax_reviewed_at, archived FROM projects.vendors WHERE id = $1`,
      [vendorId],
    );
    const v = vendor.rows[0];
    if (!v || v.archived || !v.qbo_id || !v.qbo_w9_id || !v.qbo_tax_reviewed_at) {
      throw new ApiError(
        'conflict',
        'Complete vendor setup first: sync the reviewed W-9 and contact details, then confirm the vendor tax information in QuickBooks.',
        { vendor_id: vendorId, stage, missing_w9: true },
      );
    }
  }
}

export async function assertSubcontractCompliance(
  db: SqlClient,
  po: { kind: string; vendor_id: string | null },
  stage: ComplianceStage,
  invoiceDate?: string | null,
): Promise<void> {
  if (po.kind !== 'subcontract' || !po.vendor_id) return;
  await assertVendorCompliant(db, po.vendor_id, stage, invoiceDate);
}

export interface IssueCheck {
  kind: string;
  vendorId: string | null;
  agreementDocumentId: string | null;
  agreementSignedAt: string | null;
  lineCount: number;
  /** When the purchase order was created. Create-and-issue passes now, so a new order is inside the grace window. */
  createdAt?: string | Date | null;
}

export interface IssueWarning {
  message: string;
}

/**
 * Lines, compliance, and the agreement grace. Material purchases skip this.
 *
 * A signed vendor master agreement, or another vendor document used as a
 * per-PO subcontract, satisfies the gate with no warning. With neither, issue
 * is allowed during agreement_grace_days (default 14, from created_at) and
 * returns a warning. After that window, issue is blocked. COI and W-9 are
 * checked first and are not relaxed by the grace window.
 */
export async function assertReadyToIssue(db: SqlClient, check: IssueCheck): Promise<IssueWarning | null> {
  if (check.kind !== 'subcontract') return null;
  if (check.vendorId) await assertVendorCompliant(db, check.vendorId, 'issue');
  if (check.lineCount < 1) {
    throw new ApiError('conflict', 'Add at least one line before issuing this subcontract.');
  }
  if (check.agreementDocumentId && check.agreementSignedAt) {
    const doc = await db.query<{ id: string; vendor_id: string; kind: string }>(
      `SELECT id, vendor_id, kind::text AS kind FROM projects.vendor_documents WHERE id = $1`,
      [check.agreementDocumentId],
    );
    const row = doc.rows[0];
    if (!row || (row.kind !== 'master_agreement' && row.kind !== 'other')) {
      throw new ApiError(
        'conflict',
        'The agreement must be a master agreement or other document on the vendor. A per-PO subcontract is optional.',
      );
    }
    if (check.vendorId && row.vendor_id !== check.vendorId) {
      throw new ApiError('conflict', 'That agreement belongs to a different vendor.');
    }
    return null;
  }
  if (check.agreementDocumentId || check.agreementSignedAt) {
    throw new ApiError(
      'conflict',
      'Attach both the agreement and the date it was signed. A signed vendor master agreement is enough; a per-PO subcontract is optional.',
    );
  }
  const { graceDays } = await loadCostTypeAccounts(db);
  const created = check.createdAt ? new Date(check.createdAt) : new Date();
  const ageDays = Math.max(0, Math.floor((Date.now() - created.getTime()) / 86_400_000));
  if (graceDays > 0 && ageDays <= graceDays) {
    const left = graceDays - ageDays;
    return {
      message:
        `Issued without a signed agreement. This purchase order is ${ageDays} day(s) old and the agreement grace is ${graceDays} days, so issue is allowed with this warning (${left} day(s) left). ` +
        `After that, issue is blocked until a signed vendor master agreement is attached. A per-PO subcontract is optional.`,
    };
  }
  throw new ApiError(
    'conflict',
    graceDays === 0
      ? 'Issue is blocked: agreement grace is 0 days, so a subcontract cannot be issued without a signed vendor master agreement. A per-PO subcontract is optional and is not required.'
      : `Issue is blocked: this subcontract is ${ageDays} day(s) old and the ${graceDays}-day agreement grace has ended. Attach a signed vendor master agreement and the date it was signed. A per-PO subcontract is optional and is not required.`,
  );
}

async function blockingDocuments(db: SqlClient, vendorId: string) {
  const documents = await db.query<{ kind: string; state: string }>(
    `SELECT kind::text AS kind, state FROM projects.v_vendor_compliance
      WHERE vendor_id = $1 AND blocks_scheduling AND state NOT IN ('valid', 'expiring')`,
    [vendorId],
  );
  return documents.rows;
}

function stageLabel(stage: ComplianceStage): string {
  switch (stage) {
    case 'award':
      return 'award';
    case 'issue':
      return 'purchase order issue';
    case 'bill_approval':
      return 'bill approval';
    case 'payment':
      return 'QuickBooks push';
  }
}
