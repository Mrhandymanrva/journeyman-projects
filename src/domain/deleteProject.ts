import type { SqlClient } from '../db/database.js';
import { ApiError, notFound } from '../http/errors.js';

/** Called inside the tenant transaction. Never sends external deletions. */
export async function deleteLocalProject(db: SqlClient, id: string) {
  const locked = await db.query('SELECT id FROM projects.projects WHERE id=$1 FOR UPDATE', [id]);
  if (!locked.rows.length) throw notFound('Project not found');
  // Accounting submissions lock the bill before adding a queue entry.
  await db.query(`SELECT b.id FROM projects.vendor_bills b JOIN projects.purchase_orders po ON po.id=b.po_id WHERE po.project_id=$1 FOR UPDATE OF b`, [id]);
  const protectedRows = await db.query(`
    SELECT 1 FROM projects.record_publications WHERE project_id=$1
    UNION ALL SELECT 1 FROM projects.document_links WHERE project_id=$1
    UNION ALL SELECT 1 FROM projects.dispatch_changes WHERE project_id=$1
    UNION ALL SELECT 1 FROM projects.external_invoices WHERE project_id=$1
    UNION ALL SELECT 1 FROM projects.vendor_bills b JOIN projects.purchase_orders po ON po.id=b.po_id
      WHERE po.project_id=$1 AND (b.qbo_id IS NOT NULL OR EXISTS(
        SELECT 1 FROM projects.accounting_queue q WHERE q.kind='bill' AND q.record_id=b.id))
    UNION ALL SELECT 1 FROM projects.bid_requests b JOIN projects.bid_recipients r ON r.request_id=b.id
      WHERE b.project_id=$1 AND r.delivery_status <> 'draft'
    LIMIT 1`, [id]);
  if (protectedRows.rows.length) throw new ApiError('conflict', 'This project has accounting sync, external publication, dispatch or sent bid history. Keep it for the audit trail; it cannot be deleted.');
  await db.query('DELETE FROM projects.bid_recipients WHERE request_id IN (SELECT id FROM projects.bid_requests WHERE project_id=$1)', [id]);
  await db.query('DELETE FROM projects.bid_requests WHERE project_id=$1', [id]);
  // Invoice lines restrict deleting their draw/change-order references.
  await db.query('DELETE FROM projects.project_invoices WHERE project_id=$1', [id]);
  await db.query('DELETE FROM projects.projects WHERE id=$1', [id]);
}
