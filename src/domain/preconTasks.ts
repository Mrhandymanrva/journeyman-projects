import type { SqlClient } from "../db/database.js";

/** Calendar the schedule board already uses for appointment dates. */
export const NEW_YORK = "America/New_York";

export const PRECON_TASK_TYPES = [
  "permit",
  "site_visit",
  "selection",
  "plans",
  "material_order",
  "other",
] as const;

export const PRECON_STATUSES = [
  "not_started",
  "in_progress",
  "done",
  "waived",
] as const;

export const INSPECTION_RESULTS = [
  "pending",
  "passed",
  "failed",
  "cancelled",
] as const;

export type PreconTaskType = (typeof PRECON_TASK_TYPES)[number];
export type PreconStatus = (typeof PRECON_STATUSES)[number];
export type InspectionResult = (typeof INSPECTION_RESULTS)[number];

export const PRECON_NOTES_MAX = 2000;

/**
 * Overdue is a display fact, not a stored column.
 * due_on before today in America/New_York, and still open.
 * waived and done are never overdue. A due date of today is not overdue.
 */
export function preconOverdueSql(alias = "t"): string {
  return `(${alias}.status IN ('not_started','in_progress') AND ${alias}.due_on IS NOT NULL AND ${alias}.due_on < (now() AT TIME ZONE '${NEW_YORK}')::date)`;
}

export interface PreconInspectionView {
  id: string;
  scheduled_on: string | null;
  occurred_on: string | null;
  result: InspectionResult;
  notes: string | null;
}

export interface PreconOfficeView {
  name: string;
  office_name: string | null;
  main_phone: string | null;
  website_url: string | null;
  portal_url: string | null;
  inspection_method: string | null;
  inspection_phone: string | null;
  inspection_url: string | null;
  typical_review_days: number | null;
  last_verified: string | null;
  work_requiring_permit: string | null;
  required_documents: string | null;
  plan_requirements: string | null;
  fee_notes: string | null;
}

export interface PreconTaskView {
  id: string;
  type: PreconTaskType;
  title: string;
  owner_role: string;
  due_on: string | null;
  status: PreconStatus;
  overdue: boolean;
  notes: string | null;
  sort_order: number;
  jurisdiction_id: string | null;
  permit_id: string | null;
  purchase_order_id: string | null;
  jurisdiction_name: string | null;
  portal_url: string | null;
  permit_number: string | null;
  material_order_number: string | null;
  material_order_amount: number | null;
  card_charge_state: "awaiting_card_charge" | "matched" | null;
  office: PreconOfficeView | null;
  inspections: PreconInspectionView[];
}

interface TaskRow {
  id: string;
  task_type: PreconTaskType;
  title: string;
  owner_role: string;
  due_on: string | null;
  status: PreconStatus;
  notes: string | null;
  sort_order: number;
  jurisdiction_id: string | null;
  permit_id: string | null;
  purchase_order_id: string | null;
  overdue: boolean;
  jurisdiction_name: string | null;
  office_name: string | null;
  portal_url: string | null;
  website_url: string | null;
  contact_phone: string | null;
  inspection_method: string | null;
  inspection_phone: string | null;
  inspection_url: string | null;
  typical_review_days: number | null;
  last_verified: string | null;
  work_requiring_permit: string | null;
  required_documents: string | null;
  plan_requirements: string | null;
  fee_notes: string | null;
  permit_number: string | null;
  po_number: string | null;
  po_amount: string | null;
  card_charge_state: "awaiting_card_charge" | "matched" | null;
}

/**
 * Copies the tenant template onto a project. Due dates are the logged start
 * plus each row's offset. An empty template inserts nothing.
 * The caller decides whether the project is allowed to receive a copy.
 */
export async function seedPreconTasks(
  db: SqlClient,
  tenantId: string,
  projectId: string,
  scheduledStart: string | null,
): Promise<number> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO projects.precon_tasks
       (tenant_id, project_id, task_type, title, owner_role, due_on, status, notes, sort_order)
     SELECT t.tenant_id, $2, t.task_type, t.title, t.owner_role,
            CASE
              WHEN $3::date IS NULL OR t.due_offset_days IS NULL THEN NULL
              ELSE ($3::date + t.due_offset_days)
            END,
            'not_started', t.notes, t.sort_order
       FROM projects.precon_task_templates t
      WHERE t.tenant_id = $1
      ORDER BY t.sort_order, t.title
     RETURNING id`,
    [tenantId, projectId, scheduledStart],
  );
  return inserted.rows.length;
}

export async function countPreconTasks(
  db: SqlClient,
  projectId: string,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM projects.precon_tasks WHERE project_id = $1`,
    [projectId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function preconCounts(
  db: SqlClient,
  projectId: string,
): Promise<{ open: number; overdue: number }> {
  const { rows } = await db.query<{ open: string; overdue: string }>(
    `SELECT count(*) FILTER (WHERE status IN ('not_started','in_progress'))::text AS open,
            count(*) FILTER (WHERE ${preconOverdueSql("precon_tasks")})::text AS overdue
       FROM projects.precon_tasks
      WHERE project_id = $1`,
    [projectId],
  );
  return {
    open: Number(rows[0]?.open ?? 0),
    overdue: Number(rows[0]?.overdue ?? 0),
  };
}

export async function listPreconTasks(
  db: SqlClient,
  projectId: string,
): Promise<PreconTaskView[]> {
  const { rows } = await db.query<TaskRow>(
    `SELECT t.id, t.task_type, t.title, t.owner_role::text AS owner_role,
            t.due_on::text AS due_on, t.status, t.notes, t.sort_order,
            t.jurisdiction_id, t.permit_id, t.purchase_order_id,
            ${preconOverdueSql("t")} AS overdue,
            j.name AS jurisdiction_name,
            j.office_name,
            j.portal_url,
            j.website_url,
            j.contact_phone,
            j.inspection_method,
            j.inspection_phone,
            j.inspection_url,
            j.typical_review_days,
            j.last_verified::text AS last_verified,
            j.work_requiring_permit,
            j.required_documents,
            j.plan_requirements,
            j.fee_notes,
            pr.permit_number,
            po.po_number,
            po.amount::text AS po_amount,
            (
              SELECT CASE
                       WHEN b.status = 'received' AND b.qbo_id IS NULL THEN 'awaiting_card_charge'
                       WHEN b.qbo_id IS NOT NULL THEN 'matched'
                       ELSE NULL
                     END
                FROM projects.vendor_bills b
               WHERE b.po_id = po.id
                 AND po.kind = 'material'
               ORDER BY b.received_at DESC
               LIMIT 1
            ) AS card_charge_state
       FROM projects.precon_tasks t
       LEFT JOIN projects.jurisdictions j ON j.id = t.jurisdiction_id
       LEFT JOIN projects.permits pr ON pr.id = t.permit_id
       LEFT JOIN projects.purchase_orders po ON po.id = t.purchase_order_id
      WHERE t.project_id = $1
      ORDER BY t.sort_order, t.created_at, t.id`,
    [projectId],
  );
  if (rows.length === 0) return [];

  const inspections = await db.query<{
    id: string;
    task_id: string;
    scheduled_on: string | null;
    occurred_on: string | null;
    result: InspectionResult;
    notes: string | null;
  }>(
    `SELECT id, task_id, scheduled_on::text AS scheduled_on, occurred_on::text AS occurred_on,
            result, notes
       FROM projects.precon_inspections
      WHERE task_id = ANY($1::uuid[])
      ORDER BY scheduled_on NULLS LAST, created_at, id`,
    [rows.map((row) => row.id)],
  );
  const byTask = new Map<string, PreconInspectionView[]>();
  for (const inspection of inspections.rows) {
    const list = byTask.get(inspection.task_id) ?? [];
    list.push({
      id: inspection.id,
      scheduled_on: inspection.scheduled_on,
      occurred_on: inspection.occurred_on,
      result: inspection.result,
      notes: inspection.notes,
    });
    byTask.set(inspection.task_id, list);
  }

  return rows.map((row) => presentTask(row, byTask.get(row.id) ?? []));
}

function presentTask(
  row: TaskRow,
  inspections: PreconInspectionView[],
): PreconTaskView {
  const office = row.jurisdiction_id
    ? {
        name: row.jurisdiction_name ?? "",
        office_name: row.office_name,
        main_phone: row.contact_phone,
        website_url: row.website_url,
        portal_url: row.portal_url,
        inspection_method: row.inspection_method,
        inspection_phone: row.inspection_phone,
        inspection_url: row.inspection_url,
        typical_review_days: row.typical_review_days,
        last_verified: row.last_verified,
        work_requiring_permit: row.work_requiring_permit,
        required_documents: row.required_documents,
        plan_requirements: row.plan_requirements,
        fee_notes: row.fee_notes,
      }
    : null;
  return {
    id: row.id,
    type: row.task_type,
    title: row.title,
    owner_role: row.owner_role,
    due_on: row.due_on,
    status: row.status,
    overdue: Boolean(row.overdue),
    notes: row.notes,
    sort_order: row.sort_order,
    jurisdiction_id: row.jurisdiction_id,
    permit_id: row.permit_id,
    purchase_order_id: row.purchase_order_id,
    jurisdiction_name: row.jurisdiction_name,
    portal_url: row.portal_url,
    permit_number: row.permit_number,
    material_order_number: row.po_number,
    material_order_amount:
      row.po_amount === null || row.po_amount === undefined
        ? null
        : Number(row.po_amount),
    card_charge_state: row.card_charge_state,
    office,
    inspections,
  };
}
