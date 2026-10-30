/**
 * Read committed labor from rows ServiceTitan sync already stored.
 * Selects only. No ServiceTitan call and no new polling.
 */

import type { SqlClient } from "../db/database.js";
import { readBillableRate } from "./laborActuals.js";
import {
  buildCommittedLabor,
  type CommittedActualRow,
  type CommittedAppointment,
  type CommittedJobLink,
  type CommittedLabor,
  type CommittedMoneyLine,
  type CommittedTechRate,
  type CommittedTechnician,
} from "./committedLabor.js";

function text(value: unknown): string {
  return value == null ? "" : String(value);
}

function money(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableMoney(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function instant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return text(value);
}

function technicians(value: unknown): CommittedTechnician[] {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  const rows: CommittedTechnician[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as { id?: unknown; name?: unknown };
    rows.push({ id: record.id == null ? null : String(record.id), name: record.name == null ? null : String(record.name) });
  }
  return rows;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

export async function readCommittedLabor(db: SqlClient, projectId: string): Promise<CommittedLabor> {
  const project = await db.query<{ tenant_id: string }>(
    `SELECT tenant_id::text AS tenant_id FROM projects.projects WHERE id = $1`,
    [projectId],
  );
  const tenantId = project.rows[0]?.tenant_id ?? "";
  const billableRate = tenantId ? await readBillableRate(db, tenantId) : 188;

  const appointments = await db.query<{
    external_job_id: string;
    external_appointment_id: string;
    job_number: string;
    job_status: string;
    starts_at: Date | string;
    ends_at: Date | string;
    status: string;
    active: boolean;
    technicians: unknown;
  }>(
    `SELECT external_job_id, external_appointment_id, job_number, job_status,
            starts_at, ends_at, status, active, technicians
       FROM projects.st_plan_appointments
      WHERE project_id = $1`,
    [projectId],
  );
  const links = await db.query<{
    external_job_id: string;
    source_job_number: string | null;
    source_job_status: string | null;
    source_active: boolean;
  }>(
    `SELECT external_job_id, source_job_number, source_job_status, source_active
       FROM projects.project_job_links
      WHERE project_id = $1`,
    [projectId],
  );
  const invoiceLines = await db.query<{
    external_job_id: string;
    sku: string | null;
    kind: string;
    total: string;
  }>(
    `SELECT external_job_id, sku, kind, total::text AS total
       FROM projects.st_invoice_lines
      WHERE project_id = $1`,
    [projectId],
  );
  const observed = await db.query<{ external_job_id: string | null }>(
    `SELECT external_job_id
       FROM projects.st_invoice_observations
      WHERE project_id = $1 AND external_job_id IS NOT NULL`,
    [projectId],
  );
  const actuals = await db.query<{
    external_job_id: string;
    external_technician_id: string | null;
    hours: string;
    labor_amount: string | null;
    burden_amount: string | null;
    burden_unset: boolean;
  }>(
    `SELECT external_job_id, external_technician_id, hours::text AS hours,
            labor_amount::text AS labor_amount, burden_amount::text AS burden_amount,
            burden_unset
       FROM projects.labor_actuals
      WHERE project_id = $1`,
    [projectId],
  );
  const rates = await db.query<{ external_technician_id: string; burden_rate: string | null }>(
    `SELECT external_technician_id, burden_rate::text AS burden_rate
       FROM projects.technician_labor_rates
      WHERE burden_rate IS NOT NULL AND burden_rate > 0`,
  );

  const appointmentRows: CommittedAppointment[] = appointments.rows.map((row) => ({
    externalJobId: text(row.external_job_id),
    externalAppointmentId: text(row.external_appointment_id),
    jobNumber: text(row.job_number),
    jobStatus: text(row.job_status),
    startsAt: instant(row.starts_at),
    endsAt: instant(row.ends_at),
    status: text(row.status),
    active: row.active !== false,
    technicians: technicians(row.technicians),
  }));
  const linkRows: CommittedJobLink[] = links.rows.map((row) => ({
    externalJobId: text(row.external_job_id),
    jobNumber: row.source_job_number,
    jobStatus: row.source_job_status,
    active: row.source_active !== false,
  }));
  const lineRows: CommittedMoneyLine[] = invoiceLines.rows.map((row) => ({
    externalJobId: text(row.external_job_id),
    sku: row.sku,
    kind: row.kind,
    total: money(row.total),
  }));
  const actualRows: CommittedActualRow[] = actuals.rows.map((row) => ({
    externalJobId: text(row.external_job_id),
    technicianId: row.external_technician_id,
    hours: money(row.hours),
    laborAmount: nullableMoney(row.labor_amount),
    burdenAmount: nullableMoney(row.burden_amount),
    burdenUnset: row.burden_unset === true,
  }));
  const rateRows: CommittedTechRate[] = rates.rows.map((row) => ({
    technicianId: text(row.external_technician_id),
    burdenRate: nullableMoney(row.burden_rate),
  }));

  return buildCommittedLabor({
    appointments: appointmentRows,
    links: linkRows,
    invoiceLines: lineRows,
    invoicedJobIds: observed.rows.map((row) => text(row.external_job_id)).filter((id) => id.length > 0),
    actuals: actualRows,
    rates: rateRows,
    billableRate,
  });
}
