import type { SqlClient } from "../db/database.js";
import type { ListedJob, ReconciliationLine } from "./projectFinancials.js";
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

export interface ReconciliationTechnician {
  technician_id: string;
  technician_name: string;
  hours: number;
  /** Human percent. 10 is 10%. Null when this technician is not on commission. */
  commission_percent: number | null;
  /** payroll-settings or technician.commissionRate. Null when there is no commission. */
  commission_source: string | null;
  commission_amount: number | null;
  burden: number | null;
}

export interface StoredReconciliation {
  observed_at: string;
  lines: ReconciliationLine[];
  technicians: ReconciliationTechnician[];
  error: string | null;
}

export interface LaborRefreshRunRecord {
  status: "started" | "finished";
  started_at: string;
  finished_at: string | null;
  due_at: string | null;
  ok: string[];
  failed: Array<{ project_id: string; project_number: string; error: string }>;
  error: string | null;
}

export interface LaborRefreshFeed {
  status: "started" | "finished" | null;
  started_at: string | null;
  finished_at: string | null;
  ok: number;
  failed: number;
  error: string | null;
}

export const EMPTY_LABOR_REFRESH_FEED: LaborRefreshFeed = {
  status: null,
  started_at: null,
  finished_at: null,
  ok: 0,
  failed: 0,
  error: null,
};

const NO_RECONCILIATION_NOTE =
  "No reconciliation has been stored. Refresh will write one.";

export function reconciliationNote(stored: StoredReconciliation | null): string | null {
  return stored ? null : NO_RECONCILIATION_NOTE;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string" && value.trim()) {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  if (typeof value === "string" && value.trim()) {
    try {
      return asArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function isoOf(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function presentLines(value: unknown): ReconciliationLine[] {
  return asArray(value).flatMap((row) => {
    const record = asRecord(row);
    if (!record || typeof record.key !== "string") return [];
    return [{
      key: record.key as ReconciliationLine["key"],
      label: typeof record.label === "string" ? record.label : record.key,
      jp: Number(record.jp ?? 0),
      st: Number(record.st ?? 0),
      delta: Number(record.delta ?? 0),
    }];
  });
}

function presentTechnicians(value: unknown): ReconciliationTechnician[] {
  return asArray(value).flatMap((row) => {
    const record = asRecord(row);
    if (!record || record.technician_id == null) return [];
    const percent = record.commission_percent;
    const amount = record.commission_amount;
    const burden = record.burden;
    return [{
      technician_id: String(record.technician_id),
      technician_name: typeof record.technician_name === "string" ? record.technician_name : String(record.technician_id),
      hours: Number(record.hours ?? 0),
      commission_percent: percent == null ? null : Number(percent),
      commission_source: typeof record.commission_source === "string" ? record.commission_source : null,
      commission_amount: amount == null ? null : Number(amount),
      burden: burden == null ? null : Number(burden),
    }];
  });
}

export function presentLaborRefresh(run: unknown, projectId: string): LaborRefreshFeed {
  const record = asRecord(run);
  if (!record) return { ...EMPTY_LABOR_REFRESH_FEED };
  const failed = asArray(record.failed).flatMap((row) => {
    const item = asRecord(row);
    if (!item) return [];
    return [{
      project_id: item.project_id == null ? "" : String(item.project_id),
      error: typeof item.error === "string" ? item.error : "",
    }];
  });
  const ok = asArray(record.ok);
  const mine = failed.find((item) => item.project_id === projectId);
  const runError = typeof record.error === "string" && record.error.trim() ? record.error : null;
  const status = record.status === "started" || record.status === "finished" ? record.status : null;
  return {
    status,
    started_at: isoOf(record.started_at),
    finished_at: isoOf(record.finished_at),
    ok: ok.length,
    failed: failed.length,
    error: mine?.error || runError,
  };
}

export async function writeFinancialReconciliation(
  db: SqlClient,
  input: {
    tenantId: string;
    projectId: string;
    observedAt: Date;
    lines: readonly ReconciliationLine[];
    technicians: readonly ReconciliationTechnician[];
    error: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO projects.st_financial_reconciliation
       (tenant_id, project_id, observed_at, lines, technicians, error)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
     ON CONFLICT (tenant_id, project_id) DO UPDATE
       SET observed_at = EXCLUDED.observed_at,
           lines = EXCLUDED.lines,
           technicians = EXCLUDED.technicians,
           error = EXCLUDED.error`,
    [
      input.tenantId,
      input.projectId,
      input.observedAt,
      JSON.stringify(input.lines),
      JSON.stringify(input.technicians),
      input.error,
    ],
  );
}

export async function readStoredReconciliation(
  db: SqlClient,
  projectId: string,
): Promise<StoredReconciliation | null> {
  const { rows } = await db.query<{
    observed_at: Date | string;
    lines: unknown;
    technicians: unknown;
    error: string | null;
  }>(
    `SELECT observed_at, lines, technicians, error
       FROM projects.st_financial_reconciliation
      WHERE project_id = $1`,
    [projectId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    observed_at: isoOf(row.observed_at) ?? new Date(0).toISOString(),
    lines: presentLines(row.lines),
    technicians: presentTechnicians(row.technicians),
    error: row.error,
  };
}

export async function readPortfolioFinancialFeed(db: SqlClient): Promise<{
  run: unknown;
  reconciliation: Map<string, StoredReconciliation>;
}> {
  const settings = await db.query<{ labor_refresh_run: unknown }>(
    `SELECT labor_refresh_run FROM projects.tenant_settings`,
  );
  const rows = await db.query<{
    project_id: string;
    observed_at: Date | string;
    lines: unknown;
    technicians: unknown;
    error: string | null;
  }>(
    `SELECT project_id::text AS project_id, observed_at, lines, technicians, error
       FROM projects.st_financial_reconciliation`,
  );
  const reconciliation = new Map<string, StoredReconciliation>();
  for (const row of rows.rows) {
    reconciliation.set(row.project_id, {
      observed_at: isoOf(row.observed_at) ?? new Date(0).toISOString(),
      lines: presentLines(row.lines),
      technicians: presentTechnicians(row.technicians),
      error: row.error,
    });
  }
  return { run: settings.rows[0]?.labor_refresh_run ?? null, reconciliation };
}
