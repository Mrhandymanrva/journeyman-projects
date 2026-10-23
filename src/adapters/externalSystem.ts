import type { SqlClient } from '../db/database.js';

/**
 * The revenue system of record, behind an interface that only checks an
 * invoice that already exists.
 *
 * Customer invoices are created in ServiceTitan only, and ServiceTitan
 * exports them to QuickBooks. Journeyman reads ServiceTitan invoices to
 * track draws and billing status, and it never creates or writes customer
 * invoices to ServiceTitan or QuickBooks. This interface has verifyInvoice
 * and nothing that creates an invoice.
 *
 * Vendor bills still go from Journeyman to QuickBooks through the
 * purchase_orders /api/pm-accounting bridge. That write is not on this
 * interface. ServiceTitan writes that already exist — project notes, file
 * attachments, appointment reschedule, and technician assignment — live on
 * the ServiceTitan client and are not invoice writes.
 *
 * No field service platform is named in the data model. A tenant registers
 * whichever system holds their customers and revenue, and this module stores
 * opaque ids. The manual adapter is built first, so a tenant with no
 * connector still records an invoice number without claiming it was verified.
 */

export interface InvoiceVerification {
  verified: boolean;
  checks: {
    invoice_found: boolean;
    job_matches: boolean;
    amount_matches: boolean;
  };
  external_amount: number | null;
  draw_amount: number;
}

export interface ExternalSystemAdapter {
  readonly key: string;
  readonly displayName: string;
  /** Whether a recorded invoice number can be checked against the source. */
  readonly verifyInvoices: boolean;
  verifyInvoice(input: {
    invoiceNumber: string;
    externalJobId: string | null;
    drawAmount: number;
  }): Promise<InvoiceVerification>;
}

/**
 * A tenant with adapter_key = manual gets the full module. Draws still carry
 * an invoice number, the exception report still surfaces draws that have not
 * been invoiced, and the control still works — it is simply asserted rather
 * than verified.
 */
export class ManualAdapter implements ExternalSystemAdapter {
  readonly key = 'manual';
  readonly verifyInvoices = false;

  constructor(readonly displayName = 'Manual entry') {}

  async verifyInvoice(input: {
    invoiceNumber: string;
    externalJobId: string | null;
    drawAmount: number;
  }): Promise<InvoiceVerification> {
    // Never claims verified. A manual tenant's client is told
    // verification_available: false and hides the action, so reaching here at
    // all means someone called it anyway — answer honestly rather than
    // optimistically.
    return {
      verified: false,
      checks: { invoice_found: false, job_matches: false, amount_matches: false },
      external_amount: null,
      draw_amount: input.drawAmount,
    };
  }
}

export async function resolveAdapter(
  db: SqlClient,
  externalSystemId: string | null,
): Promise<ExternalSystemAdapter> {
  if (!externalSystemId) return new ManualAdapter();

  const { rows } = await db.query<{
    adapter_key: string;
    display_name: string;
    verify_invoices: boolean;
  }>(
    `SELECT adapter_key, display_name, verify_invoices
       FROM projects.external_systems WHERE id = $1 AND active`,
    [externalSystemId],
  );
  const row = rows[0];
  if (!row) return new ManualAdapter();

  // Only the manual adapter exists. A tenant configured for a platform we have
  // not built yet degrades to asserted-not-verified rather than erroring —
  // which is exactly what the manual adapter already is.
  if (row.adapter_key === 'manual' || !row.verify_invoices) {
    return new ManualAdapter(row.display_name);
  }
  return new ManualAdapter(row.display_name);
}
