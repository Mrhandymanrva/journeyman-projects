import type { SqlClient } from "../db/database.js";
import type { ListedJob } from "./projectFinancials.js";
import { financialsFromReads, type ProjectMoney } from "./projectFinancials.js";

export async function replaceProjectJobs(
  db: SqlClient,
  input: {
    tenantId: string;
    projectId: string;
    externalSystemId: string;
    jobs: readonly ListedJob[];
  },
): Promise<void> {
  await db.query(
    `UPDATE projects.project_job_links
        SET source_active = false
      WHERE project_id = $1 AND external_system_id = $2`,
    [input.projectId, input.externalSystemId],
  );
  for (const job of input.jobs) {
    const linked = await db.query(
      `INSERT INTO projects.project_job_links
         (tenant_id, project_id, external_system_id, external_job_id, title,
          source_managed, source_active, source_job_number, source_job_status)
       VALUES ($1,$2,$3,$4,$5,true,true,$6,$7)
       ON CONFLICT (tenant_id, external_system_id, external_job_id) DO UPDATE
         SET title = EXCLUDED.title,
             source_managed = true,
             source_active = true,
             source_job_number = EXCLUDED.source_job_number,
             source_job_status = EXCLUDED.source_job_status
       WHERE project_job_links.project_id = EXCLUDED.project_id
       RETURNING id`,
      [
        input.tenantId,
        input.projectId,
        input.externalSystemId,
        job.id,
        "Job " + job.jobNumber,
        job.jobNumber,
        job.jobStatus,
      ],
    );
    if (!linked.rows.length) {
      throw new Error("An ST job is already linked to another project.");
    }
  }
}

export interface StoredAppointment {
  externalJobId: string;
  externalAppointmentId: string;
  jobNumber: string;
  appointmentNumber: string;
  jobStatus: string;
  startsAt: string;
  endsAt: string;
  status: string;
  active: boolean;
  technicians: Array<{ id: string; name: string }>;
}

export async function replacePlanAppointments(
  db: SqlClient,
  input: { tenantId: string; projectId: string; appointments: readonly StoredAppointment[]; observedAt: Date },
): Promise<void> {
  await db.query(
    `DELETE FROM projects.st_plan_appointments WHERE tenant_id = $1 AND project_id = $2`,
    [input.tenantId, input.projectId],
  );
  for (const row of input.appointments) {
    await db.query(
      `INSERT INTO projects.st_plan_appointments
         (tenant_id, project_id, external_job_id, external_appointment_id,
          job_number, appointment_number, job_status, starts_at, ends_at,
          status, active, technicians, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
      [
        input.tenantId,
        input.projectId,
        row.externalJobId,
        row.externalAppointmentId,
        row.jobNumber,
        row.appointmentNumber,
        row.jobStatus,
        row.startsAt,
        row.endsAt,
        row.status,
        row.active,
        JSON.stringify(row.technicians),
        input.observedAt,
      ],
    );
  }
}

export interface StoredInvoiceLine {
  invoiceId: string;
  externalJobId: string;
  lineKey: string;
  sku: string;
  kind: "labor" | "material" | "other";
  quantity: number | null;
  total: number;
  technicianId: string | null;
}

export async function replaceInvoiceLines(
  db: SqlClient,
  input: { tenantId: string; projectId: string; lines: readonly StoredInvoiceLine[]; observedAt: Date },
): Promise<void> {
  await db.query(
    `DELETE FROM projects.st_invoice_lines WHERE tenant_id = $1 AND project_id = $2`,
    [input.tenantId, input.projectId],
  );
  for (const line of input.lines) {
    await db.query(
      `INSERT INTO projects.st_invoice_lines
         (tenant_id, project_id, external_invoice_id, external_job_id, line_key,
          sku, kind, quantity, total, technician_id, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.tenantId,
        input.projectId,
        line.invoiceId,
        line.externalJobId,
        line.lineKey,
        line.sku,
        line.kind,
        line.quantity,
        line.total,
        line.technicianId,
        input.observedAt,
      ],
    );
  }
}

export async function replaceMaterialExpenses(
  db: SqlClient,
  input: {
    tenantId: string;
    projectId: string;
    orders: ReadonlyArray<{ id: string; externalJobId: string; total: number }>;
    observedAt: Date;
  },
): Promise<void> {
  await db.query(
    `DELETE FROM projects.st_material_expenses WHERE tenant_id = $1 AND project_id = $2`,
    [input.tenantId, input.projectId],
  );
  for (const order of input.orders) {
    await db.query(
      `INSERT INTO projects.st_material_expenses
         (tenant_id, project_id, external_job_id, external_po_id, total, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.tenantId, input.projectId, order.externalJobId, order.id, order.total, input.observedAt],
    );
  }
}

export async function readStoredProjectMoney(db: SqlClient, projectId: string): Promise<ProjectMoney> {
  const lines = await db.query<{ kind: "labor" | "material" | "other"; total: string }>(
    `SELECT kind, total::text AS total FROM projects.st_invoice_lines WHERE project_id = $1`,
    [projectId],
  );
  const burden = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(burden_amount), 0)::text AS total
       FROM projects.labor_actuals WHERE project_id = $1`,
    [projectId],
  );
  const orders = await db.query<{ total: string }>(
    `SELECT total::text AS total FROM projects.st_material_expenses WHERE project_id = $1`,
    [projectId],
  );
  const fromLines = financialsFromReads({
    invoiceLines: lines.rows.map((row) => ({ kind: row.kind, total: Number(row.total) })),
    timesheets: [],
    purchaseOrders: orders.rows.map((row) => ({ total: Number(row.total) })),
  });
  const laborBurden = Math.round(Number(burden.rows[0]?.total ?? 0) * 100) / 100;
  const expenses = Math.round((laborBurden + fromLines.materialsExpense) * 100) / 100;
  const margin = Math.round((fromLines.billed - expenses) * 100) / 100;
  return {
    ...fromLines,
    laborBurden,
    expenses,
    margin,
    marginPercent: fromLines.billed > 0 ? Math.round((margin / fromLines.billed) * 10000) / 100 : 0,
  };
}
