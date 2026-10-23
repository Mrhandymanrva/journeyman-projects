import type { SqlClient } from '../db/database.js';
import { ApiError } from '../http/errors.js';

export type ComplianceStage = 'award' | 'issue' | 'bill_approval' | 'payment';

/**
 * COI and W-9 checks for a subcontract vendor.
 *
 * Award, issue, and bill approval use the same document rule as scheduling:
 * every requirement that blocks scheduling must be valid or expiring. Bill
 * approval also requires that document to have been unexpired on the invoice
 * date. Payment (the QuickBooks push, at queue time and again in the worker)
 * adds the reviewed W-9: vendor qbo id, attached W-9, and tax review.
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
}

/** Lines, a signed agreement, and compliance. Material purchases skip this. */
export async function assertReadyToIssue(db: SqlClient, check: IssueCheck): Promise<void> {
  if (check.kind !== 'subcontract') return;
  if (check.vendorId) await assertVendorCompliant(db, check.vendorId, 'issue');
  if (check.lineCount < 1) {
    throw new ApiError('conflict', 'Add at least one line before issuing this subcontract.');
  }
  if (!check.agreementDocumentId || !check.agreementSignedAt) {
    throw new ApiError(
      'conflict',
      'A subcontract needs a signed agreement before it can be issued. Attach a master agreement or other vendor document and the date it was signed.',
    );
  }
  const doc = await db.query<{ id: string; vendor_id: string; kind: string }>(
    `SELECT id, vendor_id, kind::text AS kind FROM projects.vendor_documents WHERE id = $1`,
    [check.agreementDocumentId],
  );
  const row = doc.rows[0];
  if (!row || (row.kind !== 'master_agreement' && row.kind !== 'other')) {
    throw new ApiError(
      'conflict',
      'The agreement must be a master agreement or other document on the vendor.',
    );
  }
  if (check.vendorId && row.vendor_id !== check.vendorId) {
    throw new ApiError('conflict', 'That agreement belongs to a different vendor.');
  }
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
