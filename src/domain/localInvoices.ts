import type { SqlClient } from '../db/database.js';
import { ApiError } from '../http/errors.js';

export const LOCAL_INVOICE_REFUSAL =
  'Customer invoices are issued in ServiceTitan. Journeyman will not create a local invoice while ServiceTitan is the revenue system.';

/** True when an active ServiceTitan connection is the revenue system of record. */
export async function serviceTitanOwnsRevenue(db: SqlClient): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT id FROM projects.external_systems
      WHERE active AND adapter_key = 'servicetitan' AND is_revenue_system_of_record
      LIMIT 1`,
  );
  return rows.length > 0;
}

/**
 * Local project_invoices rows are only for a tenant whose revenue system is
 * not ServiceTitan. This does not call ServiceTitan or QuickBooks.
 */
export async function assertLocalCustomerInvoicesAllowed(db: SqlClient): Promise<void> {
  if (await serviceTitanOwnsRevenue(db)) {
    throw new ApiError('conflict', LOCAL_INVOICE_REFUSAL);
  }
}
