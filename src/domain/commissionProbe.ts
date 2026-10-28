/**
 * Read-only commission diagnostic.
 * Every request is a GET. Nothing is written to ServiceTitan or Journeyman.
 */
import {
  DEFAULT_PROBE_TECHNICIAN_IDS,
  type PayrollRead,
} from "./commissionLabor.js";

export const DERIVED_COMMISSION_DISCLAIMER =
  "Derived from gross-pay-items commission amounts divided by invoice totals found on those items. This is not a ServiceTitan commission setting.";

const RATE_KEY = /commission|percent|percentage|rate|split|burden/i;
const SKIP_RATE_KEY = /^(id|.*Id|page|pageSize|totalCount|hasMore|status|statusCode)$/i;

const PAY_AMOUNT_KEYS = ["amount", "paidAmount", "grossPay", "commissionAmount", "payAmount"];
const INVOICE_TOTAL_KEYS = [
  "invoiceTotal",
  "invoiceSubtotal",
  "invoiceAmount",
  "subtotal",
  "totalAmount",
  "jobTotal",
  "soldTotal",
];

export interface ProbeGet {
  family: "payroll" | "settings";
  resource: string;
  query?: Record<string, string>;
}

export interface RatePath {
  path: string;
  value: number;
}

export interface ProbeEndpointReport {
  method: "GET";
  path: string;
  status: number | null;
  error: string | null;
  /** Rate, percent, commission, split, and burden numbers. Ids are omitted. */
  ratePaths: RatePath[];
  note: string | null;
}

export interface DerivedCommissionSummary {
  technicianId: string;
  label: "derived";
  disclaimer: string;
  itemCount: number;
  commissionItemCount: number;
  commissionPay: number | null;
  invoiceTotal: number | null;
  effectivePercent: number | null;
  note: string;
}

export interface CommissionProbeReport {
  readOnly: true;
  technicianIds: string[];
  endpoints: ProbeEndpointReport[];
  derived: DerivedCommissionSummary[];
}

export interface CommissionProbeClient {
  tenantId: string;
  readAllowlistedGet(
    family: "payroll" | "settings",
    resource: string,
    query?: Record<string, string>,
  ): Promise<PayrollRead>;
}

export function allowlistedGet(family: "payroll" | "settings", resource: string): boolean {
  if (family === "settings") return /^technicians\/\d+$/.test(resource) || resource === "technicians";
  return (
    /^technicians\/\d+\/payroll-settings$/.test(resource) ||
    /^employees\/\d+\/payroll-settings$/.test(resource) ||
    resource === "payroll-settings" ||
    resource === "export/payroll-settings" ||
    resource === "gross-pay-items" ||
    resource === "jobs/splits" ||
    /^jobs\/\d+\/splits$/.test(resource)
  );
}

export function collectRatePaths(value: unknown, path = "", out: RatePath[] = []): RatePath[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectRatePaths(item, `${path}[${index}]`, out));
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key;
    if (child && typeof child === "object") {
      collectRatePaths(child, next, out);
      continue;
    }
    if (typeof child !== "number" || !Number.isFinite(child)) continue;
    if (!RATE_KEY.test(key) || SKIP_RATE_KEY.test(key)) continue;
    out.push({ path: next, value: child });
  }
  return out;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function rowsOf(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  }
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: unknown[] }).data.filter(
      (row): row is Record<string, unknown> => !!row && typeof row === "object",
    );
  }
  return [];
}

function looksLikeCommission(row: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "string") continue;
    if (!/type|activity|name|code|description|category/i.test(key)) continue;
    if (/commission/i.test(value)) return true;
  }
  return false;
}

function pickNumber(row: Record<string, unknown>, keys: string[]): number | null {
  const lowered = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = lowered.get(key.toLowerCase());
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const invoice = row.invoice;
  if (invoice && typeof invoice === "object") {
    const nested = pickNumber(invoice as Record<string, unknown>, ["total", "subtotal", "totalAmount", "amount"]);
    if (nested != null && keys === INVOICE_TOTAL_KEYS) return nested;
  }
  return null;
}

/**
 * Commission pay versus invoice totals on gross-pay items.
 * The percent is computed here. It is not a rate ServiceTitan returned.
 */
export function summarizeGrossPayCommission(
  technicianId: string,
  body: unknown,
): DerivedCommissionSummary {
  const rows = rowsOf(body);
  const commissionRows = rows.filter(looksLikeCommission);
  let commissionPay = 0;
  let commissionHits = 0;
  for (const row of commissionRows) {
    const amount = pickNumber(row, PAY_AMOUNT_KEYS);
    if (amount == null) continue;
    commissionPay += amount;
    commissionHits += 1;
  }
  let invoiceTotal = 0;
  let invoiceHits = 0;
  for (const row of rows) {
    const total = pickNumber(row, INVOICE_TOTAL_KEYS);
    if (total == null) continue;
    invoiceTotal += total;
    invoiceHits += 1;
  }
  const pay = commissionHits ? roundMoney(commissionPay) : null;
  const invoices = invoiceHits ? roundMoney(invoiceTotal) : null;
  const effectivePercent =
    pay != null && invoices != null && invoices !== 0 ? roundMoney((pay / invoices) * 100) : null;
  let note = "No commission gross-pay items were found in this response.";
  if (pay != null && invoices == null) {
    note = "Commission pay was found. Invoice totals were not on these gross-pay items, so no effective percent was computed.";
  } else if (pay != null && invoices != null) {
    note = "Invoice totals are summed once per gross-pay item that carries one. A repeated invoice is counted each time it appears.";
  }
  return {
    technicianId,
    label: "derived",
    disclaimer: DERIVED_COMMISSION_DISCLAIMER,
    itemCount: rows.length,
    commissionItemCount: commissionRows.length,
    commissionPay: pay,
    invoiceTotal: invoices,
    effectivePercent,
    note,
  };
}

function sinceDays(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function jobIdsFrom(rows: readonly Record<string, unknown>[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.jobId === "number" || (typeof row.jobId === "string" && /^\d+$/.test(row.jobId))) {
      ids.add(String(row.jobId));
    }
    const job = row.job;
    if (job && typeof job === "object" && "id" in job) {
      const nested = String((job as { id: unknown }).id ?? "");
      if (/^\d+$/.test(nested)) ids.add(nested);
    }
  }
  return [...ids];
}

async function readOne(
  client: CommissionProbeClient,
  family: "payroll" | "settings",
  resource: string,
  query?: Record<string, string>,
): Promise<{ status: number; body: unknown; error: string | null }> {
  if (!allowlistedGet(family, resource)) {
    return { status: 0, body: null, error: "Path is not on the GET allowlist." };
  }
  try {
    const result = await client.readAllowlistedGet(family, resource, query);
    return { status: result.status, body: result.body, error: result.ok ? null : `HTTP ${result.status}` };
  } catch (err) {
    return {
      status: 0,
      body: null,
      error: err instanceof Error ? err.message : "ServiceTitan read failed.",
    };
  }
}

function endpoint(
  tenantId: string,
  family: "payroll" | "settings",
  resource: string,
  status: number | null,
  body: unknown,
  error: string | null,
  note: string | null,
): ProbeEndpointReport {
  return {
    method: "GET",
    path: `/${family}/v2/tenant/${tenantId}/${resource}`,
    status,
    error,
    ratePaths: body == null ? [] : collectRatePaths(body).slice(0, 200),
    note,
  };
}

async function readPages(
  client: CommissionProbeClient,
  resource: string,
  query: Record<string, string>,
): Promise<{ status: number; bodies: unknown[]; error: string | null }> {
  const bodies: unknown[] = [];
  let status = 0;
  let error: string | null = null;
  for (let page = 1; page <= 10; page += 1) {
    const result = await readOne(client, "payroll", resource, { ...query, page: String(page), pageSize: "200" });
    status = result.status;
    error = result.error;
    if (result.body == null) break;
    bodies.push(result.body);
    const hasMore = Boolean(
      result.body && typeof result.body === "object" && (result.body as { hasMore?: boolean }).hasMore,
    );
    if (!result.error && !hasMore) break;
    if (result.error) break;
  }
  return { status, bodies, error };
}

/**
 * GET payroll settings, gross pay, and job splits for the given technicians.
 * Defaults to the legacy commissionRate pair when no ids are passed.
 */
export async function runCommissionProbe(
  client: CommissionProbeClient,
  technicianIds: string[] = [...DEFAULT_PROBE_TECHNICIAN_IDS],
  now = new Date(),
): Promise<CommissionProbeReport> {
  const ids = technicianIds.length ? technicianIds : [...DEFAULT_PROBE_TECHNICIAN_IDS];
  for (const id of ids) {
    if (!/^\d+$/.test(id)) throw new Error("Technician ids must be numeric.");
  }
  const endpoints: ProbeEndpointReport[] = [];
  const derived: DerivedCommissionSummary[] = [];
  const grossByTech = new Map<string, Record<string, unknown>[]>();

  for (const id of ids) {
    const technician = await readOne(client, "settings", `technicians/${id}`);
    endpoints.push(
      endpoint(
        client.tenantId,
        "settings",
        `technicians/${id}`,
        technician.status,
        technician.body,
        technician.error,
        "settings/v2 technician record. commissionRate on this record is 0.0 for technicians created after 2025-03-31.",
      ),
    );
    const payroll = await readOne(client, "payroll", `technicians/${id}/payroll-settings`);
    endpoints.push(
      endpoint(
        client.tenantId,
        "payroll",
        `technicians/${id}/payroll-settings`,
        payroll.status,
        payroll.body,
        payroll.error,
        null,
      ),
    );
    const employee = await readOne(client, "payroll", `employees/${id}/payroll-settings`);
    endpoints.push(
      endpoint(
        client.tenantId,
        "payroll",
        `employees/${id}/payroll-settings`,
        employee.status,
        employee.body,
        employee.error,
        "Employee payroll settings for the same id, when ServiceTitan keeps them apart from the technician.",
      ),
    );
  }

  const list = await readPages(client, "payroll-settings", {});
  const listBody = { data: list.bodies.flatMap((body) => rowsOf(body)) };
  const matchedList = {
    data: listBody.data.filter((row) => ids.includes(String(row.employeeId ?? row.technicianId ?? row.id ?? ""))),
  };
  endpoints.push(
    endpoint(
      client.tenantId,
      "payroll",
      "payroll-settings",
      list.status,
      matchedList.data.length ? matchedList : { matched: 0, scanned: listBody.data.length },
      list.error,
      matchedList.data.length
        ? "Rate paths are limited to the requested technician ids."
        : "No payroll-settings row matched these technician ids. Values from other people are not printed.",
    ),
  );

  const exportedBodies: unknown[] = [];
  let exportStatus = 0;
  let exportError: string | null = null;
  let token: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const result = await readOne(
      client,
      "payroll",
      "export/payroll-settings",
      token ? { from: token, pageSize: "200" } : { pageSize: "200" },
    );
    exportStatus = result.status;
    exportError = result.error;
    if (result.body != null) exportedBodies.push(result.body);
    if (result.error || result.body == null) break;
    const next =
      result.body && typeof result.body === "object"
        ? (result.body as { continueFrom?: unknown }).continueFrom
        : null;
    const hasMore = Boolean(
      result.body && typeof result.body === "object" && (result.body as { hasMore?: boolean }).hasMore,
    );
    if (!hasMore || typeof next !== "string" || !next || next === token) break;
    token = next;
  }
  const exportedRows = exportedBodies.flatMap((body) => rowsOf(body));
  const matchedExport = {
    data: exportedRows.filter((row) =>
      ids.includes(String(row.employeeId ?? row.technicianId ?? row.id ?? "")),
    ),
  };
  endpoints.push(
    endpoint(
      client.tenantId,
      "payroll",
      "export/payroll-settings",
      exportStatus,
      matchedExport.data.length ? matchedExport : { matched: 0, scanned: exportedRows.length },
      exportError,
      matchedExport.data.length
        ? "Rate paths are limited to the requested technician ids."
        : "No export/payroll-settings row matched these technician ids. Values from other people are not printed.",
    ),
  );

  const since = sinceDays(now, 60);
  for (const id of ids) {
    const gross = await readPages(client, "gross-pay-items", {
      employeeId: id,
      employeeType: "Technician",
      dateOnOrAfter: since,
    });
    const combined = { data: gross.bodies.flatMap((body) => rowsOf(body)) };
    grossByTech.set(id, combined.data);
    endpoints.push(
      endpoint(
        client.tenantId,
        "payroll",
        "gross-pay-items",
        gross.status,
        combined,
        gross.error,
        `Filtered to technician ${id} for the last 60 days (dateOnOrAfter ${since}).`,
      ),
    );
    derived.push(summarizeGrossPayCommission(id, combined));
  }

  const jobs = [
    ...new Set(ids.flatMap((id) => jobIdsFrom(grossByTech.get(id) ?? []))),
  ];
  const splitQuery: Record<string, string> = { pageSize: "50" };
  if (jobs.length) splitQuery.jobIds = jobs.slice(0, 50).join(",");
  const splits = await readOne(client, "payroll", "jobs/splits", splitQuery);
  endpoints.push(
    endpoint(
      client.tenantId,
      "payroll",
      "jobs/splits",
      splits.status,
      splits.body,
      splits.error,
      jobs.length
        ? "jobIds taken from gross-pay items for these technicians."
        : "No job ids were on the gross-pay items. The list was requested without a job filter.",
    ),
  );
  for (const jobId of jobs.slice(0, 10)) {
    const one = await readOne(client, "payroll", `jobs/${jobId}/splits`);
    endpoints.push(
      endpoint(client.tenantId, "payroll", `jobs/${jobId}/splits`, one.status, one.body, one.error, null),
    );
  }

  return { readOnly: true, technicianIds: ids, endpoints, derived };
}

export function formatCommissionProbe(report: CommissionProbeReport): string {
  const lines: string[] = [];
  lines.push("ServiceTitan commission probe (GET only). Nothing was written.");
  lines.push(`Technician ids: ${report.technicianIds.join(", ")}`);
  lines.push("");
  for (const row of report.endpoints) {
    lines.push(`GET ${row.path}`);
    lines.push(`status: ${row.status ?? "none"}${row.error ? ` (${row.error})` : ""}`);
    if (row.note) lines.push(row.note);
    if (!row.ratePaths.length) lines.push("rate-like paths: none");
    else {
      lines.push("rate-like paths:");
      for (const rate of row.ratePaths) lines.push(`  ${rate.path} = ${rate.value}`);
    }
    lines.push("");
  }
  lines.push("Derived commission (not a ServiceTitan setting)");
  for (const row of report.derived) {
    lines.push(`technician ${row.technicianId}`);
    lines.push(row.disclaimer);
    lines.push(
      `commission pay: ${row.commissionPay ?? "not found"} | invoice totals: ${row.invoiceTotal ?? "not found"} | effective percent: ${row.effectivePercent ?? "not computed"}`,
    );
    lines.push(row.note);
    lines.push("");
  }
  return lines.join("\n");
}
