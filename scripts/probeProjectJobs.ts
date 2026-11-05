/**
 * Read-only census of every ServiceTitan job on a project.
 * GET only. No application database and no ServiceTitan writes.
 * The token request is the same client-credentials POST the other probes use.
 *
 * Configure ST_ENV, ST_TENANT_ID, ST_CLIENT_ID, ST_CLIENT_SECRET, and ST_APP_KEY
 * in the environment. Never put secrets on the command line.
 *
 *   pnpm exec tsx scripts/probeProjectJobs.ts 321586598 321293715
 *
 * Prints job number, status, appointments, timesheet hours, MHM.25PLFE billed
 * labor, and burden. Customer addresses and invoice narratives are omitted.
 */
import {
  ServiceTitanReadAdapter,
  type ServiceTitanConfig,
} from "../src/adapters/serviceTitan.js";
import { resolveTechCommission } from "../src/domain/commissionLabor.js";

const JOB_STATUSES = ["Scheduled", "Dispatched", "InProgress", "Hold", "Completed", "Canceled"] as const;
const LABOR_CODE = "mhm.25plfe";

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};

type Row = Record<string, unknown>;

type Getter = (family: string, resource: string, params?: URLSearchParams) => Promise<unknown>;

function getter(client: ServiceTitanReadAdapter): Getter {
  const get = (client as unknown as { get: Getter }).get;
  return get.bind(client);
}

function rowsOf(body: unknown): Row[] {
  if (Array.isArray(body)) return body.filter((row): row is Row => !!row && typeof row === "object");
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: unknown[] }).data.filter((row): row is Row => !!row && typeof row === "object");
  }
  return [];
}

function hasMore(body: unknown): boolean {
  return !!body && typeof body === "object" && (body as { hasMore?: unknown }).hasMore === true;
}

function text(value: unknown): string {
  return value == null ? "" : String(value);
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function hoursBetween(start: unknown, end: unknown): number | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const hours = Math.round(((to - from) / 3_600_000) * 100) / 100;
  if (hours <= 0 || hours >= 1000) return null;
  return hours;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function addHours(map: Map<string, number>, id: string | null, hours: number | null) {
  if (!id || hours == null) return;
  map.set(id, round2((map.get(id) ?? 0) + hours));
}

const SEGRETO = {
  projectId: "321586598",
  billedLabor: 15096.4,
  burden: 2440.43,
  materialsExpense: 5239.21,
  billed: 24359.6,
};

function burdenProduct(
  hours: Map<string, number>,
  technicians: Array<{ id: string; name: string | null; burdenRate: number | null }>,
) {
  const byId = new Map(technicians.map((tech) => [tech.id, tech]));
  const lines = [...hours.entries()].map(([id, techHours]) => {
    const tech = byId.get(id);
    const rate = tech?.burdenRate ?? null;
    return {
      id,
      name: tech?.name ?? null,
      hours: techHours,
      burdenRate: rate,
      burden: rate == null ? null : round2(techHours * rate),
    };
  });
  const complete = lines.length > 0 && lines.every((line) => line.burden != null);
  return {
    total: complete ? round2(lines.reduce((sum, line) => sum + (line.burden ?? 0), 0)) : null,
    lines,
  };
}

async function paged(
  get: Getter,
  family: string,
  resource: string,
  query: Record<string, string>,
): Promise<{ ok: boolean; rows: Row[]; error: string | null }> {
  const rows: Row[] = [];
  const seen = new Set<string>();
  try {
    for (let page = 1; page <= 100; page++) {
      const body = await get(family, resource, new URLSearchParams({ ...query, page: String(page), pageSize: query.pageSize ?? "200" }));
      const batch = rowsOf(body);
      const fresh = batch.filter((row) => {
        const id = text(row.id);
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      rows.push(...fresh);
      const full = batch.length >= Number(query.pageSize ?? "200");
      if (!hasMore(body) && !full) break;
      if (fresh.length === 0) break;
    }
    return { ok: true, rows, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "read failed";
    return { ok: false, rows, error: message };
  }
}

function laborItems(invoice: Row): Array<{ sku: string; quantity: number; price: number; total: number; technicianId: string | null }> {
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const found = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Row;
    const sku = text(row.skuName || row.code || row.displayName || row.description);
    if (!sku.toLowerCase().includes(LABOR_CODE)) continue;
    found.push({
      sku,
      quantity: num(row.quantity) ?? 0,
      price: num(row.price) ?? num(row.unitRate) ?? 0,
      total: num(row.total) ?? 0,
      technicianId: text(row.technicianId || row.soldById) || null,
    });
  }
  return found;
}

async function main() {
  const environment = required("ST_ENV");
  if (environment !== "integration" && environment !== "production") throw new Error("Invalid ST_ENV");
  const projectIds = process.argv.slice(2).filter((arg) => /^\d+$/.test(arg));
  if (!projectIds.length) throw new Error("Pass numeric ServiceTitan project ids.");
  const config: ServiceTitanConfig = {
    environment,
    tenantId: required("ST_TENANT_ID"),
    clientId: required("ST_CLIENT_ID"),
    clientSecret: required("ST_CLIENT_SECRET"),
    appKey: required("ST_APP_KEY"),
  };
  const client = new ServiceTitanReadAdapter(config);
  const get = getter(client);
  const projects = [];
  for (const projectId of projectIds) {
    const project = await client.readProject(projectId);
    const byStatus: Record<string, { count: number; error: string | null }> = {};
    const jobs = new Map<string, Row>();
    for (const status of ["", ...JOB_STATUSES]) {
      const query: Record<string, string> = { projectId };
      if (status) query.jobStatus = status;
      const page = await paged(get, "jpm", "jobs", query);
      byStatus[status || "(no status filter)"] = { count: page.rows.length, error: page.error };
      for (const row of page.rows) {
        const id = text(row.id);
        if (!id) continue;
        const prior = jobs.get(id);
        const seenIn = new Set<string>(Array.isArray(prior?.seenIn) ? (prior.seenIn as string[]) : []);
        seenIn.add(status || "unfiltered");
        jobs.set(id, { ...prior, ...row, seenIn: [...seenIn] });
      }
    }
    const onProject = new Set(project.project.jobIds);
    const techIds = new Set<string>();
    const timesheetHoursByTech = new Map<string, number>();
    const appointmentHoursByTech = new Map<string, number>();
    const billedByTech = new Map<string, number>();
    let unattributedBilled = 0;
    const detailed = [];
    let billedLabor = 0;
    for (const job of jobs.values()) {
      const id = text(job.id);
      let readError: string | null = null;
      let appointments: Array<Record<string, unknown>> = [];
      let timesheetHours = 0;
      let appointmentHours = 0;
      let timesheetForbidden = false;
      let timesheetCount = 0;
      let jobBilled = 0;
      try {
        const read = await client.readJob(id);
        const sheets = await client.readJobTimesheets(id);
        timesheetForbidden = sheets.forbidden;
        timesheetCount = sheets.timesheets.length;
        for (const row of sheets.timesheets) {
          if (row.canceledOn) continue;
          const hours = hoursBetween(row.arrivedOn || row.dispatchedOn, row.doneOn);
          timesheetHours += hours ?? 0;
          addHours(timesheetHoursByTech, row.technicianId, hours);
        }
        timesheetHours = round2(timesheetHours);
        for (const row of read.appointments) {
          if (!row.active || /cancel/i.test(row.status)) continue;
          const hours = hoursBetween(row.start, row.end);
          appointmentHours += hours ?? 0;
          for (const assignment of read.assignments) {
            if (assignment.appointmentId !== row.id || !assignment.active) continue;
            addHours(appointmentHoursByTech, assignment.technicianId, hours);
          }
        }
        appointmentHours = round2(appointmentHours);
        for (const assignment of read.assignments) techIds.add(assignment.technicianId);
        for (const sheet of sheets.timesheets) if (sheet.technicianId) techIds.add(sheet.technicianId);
        appointments = read.appointments.map((row) => ({
          id: row.id,
          start: row.start,
          end: row.end,
          status: row.status,
          active: row.active,
          techs: read.assignments
            .filter((assignment) => assignment.appointmentId === row.id)
            .map((assignment) => ({ id: assignment.technicianId, name: assignment.technicianName, active: assignment.active, status: assignment.status })),
        }));
      } catch (err) {
        readError = err instanceof Error ? err.message : "job read failed";
      }
      const invoices = await paged(get, "accounting", "invoices", { jobId: id });
      const items = invoices.rows.flatMap(laborItems);
      jobBilled = round2(items.reduce((sum, item) => sum + item.total, 0));
      billedLabor = round2(billedLabor + jobBilled);
      for (const item of items) {
        if (!item.technicianId) {
          unattributedBilled = round2(unattributedBilled + item.total);
          continue;
        }
        techIds.add(item.technicianId);
        billedByTech.set(item.technicianId, round2((billedByTech.get(item.technicianId) ?? 0) + item.total));
      }
      detailed.push({
        jobNumber: text(job.jobNumber),
        jobId: id,
        status: text(job.jobStatus),
        onProjectJobIds: onProject.has(id),
        createdOn: text(job.createdOn) || null,
        completedOn: text(job.completedOn) || null,
        modifiedOn: text(job.modifiedOn) || null,
        appointments,
        timesheetHours,
        appointmentHours,
        timesheetForbidden,
        timesheetCount,
        billedLabor: jobBilled,
        laborItems: items,
        invoiceError: invoices.error,
        readError,
      });
    }
    const technicians = [];
    for (const id of techIds) {
      let profile: unknown = null;
      let payroll: unknown = null;
      let profileError: string | null = null;
      let payrollError: string | null = null;
      try {
        profile = await get("settings", `technicians/${id}`);
      } catch (err) {
        profileError = err instanceof Error ? err.message : "profile read failed";
      }
      try {
        payroll = await get("payroll", `technicians/${id}/payroll-settings`);
      } catch (err) {
        payrollError = err instanceof Error ? err.message : "payroll read failed";
      }
      const profileRow = profile && typeof profile === "object" ? (profile as Row) : {};
      const commission = resolveTechCommission({
        payrollSettings: payroll,
        technicianCommissionRate: num(profileRow.commissionRate),
      });
      technicians.push({
        id,
        name: text(profileRow.name) || null,
        active: profileRow.active ?? null,
        burdenRate: num(profileRow.burdenRate),
        commissionFraction: commission.fraction,
        commissionSource: commission.source,
        commissionPath: commission.path,
        profileError,
        payrollError,
      });
    }
    const timesheetTotal = round2([...timesheetHoursByTech.values()].reduce((sum, hours) => sum + hours, 0));
    const timesheetBurden = burdenProduct(timesheetHoursByTech, technicians);
    const appointmentBurden = burdenProduct(appointmentHoursByTech, technicians);
    const commission = technicians.map((tech) => {
      const direct = billedByTech.get(tech.id) ?? 0;
      const hours = timesheetHoursByTech.get(tech.id) ?? 0;
      const lump = timesheetTotal > 0 ? unattributedBilled * (hours / timesheetTotal) : 0;
      const share = round2(direct + lump);
      return {
        id: tech.id,
        name: tech.name,
        commissionFraction: tech.commissionFraction,
        commissionSource: tech.commissionSource,
        commissionPath: tech.commissionPath,
        timesheetHours: hours,
        burdenRate: tech.burdenRate,
        billedLaborShare: share,
        commission: tech.commissionFraction == null ? null : round2(share * tech.commissionFraction),
      };
    });
    const canceled = detailed.filter((job) => /cancel/i.test(job.status));
    const open = detailed.filter((job) => !/cancel/i.test(job.status));
    const target = projectId === SEGRETO.projectId
      ? {
          ...SEGRETO,
          billedLaborRead: billedLabor,
          billedLaborDelta: round2(billedLabor - SEGRETO.billedLabor),
          timesheetBurden: timesheetBurden.total,
          timesheetBurdenDelta: timesheetBurden.total == null ? null : round2(timesheetBurden.total - SEGRETO.burden),
          appointmentWindowBurden: appointmentBurden.total,
          appointmentWindowBurdenDelta: appointmentBurden.total == null ? null : round2(appointmentBurden.total - SEGRETO.burden),
          materialsExpenseNote: "Not computed. ServiceTitan material expense is material item cost + equipment item cost + purchase orders.",
          unallocatedBilledLabor: timesheetTotal > 0 ? 0 : unattributedBilled,
        }
      : null;
    projects.push({
      projectId,
      projectNumber: project.project.number,
      projectJobIdCount: project.project.jobIds.length,
      jobsReturnedByProjectFilter: jobs.size,
      missingFromProjectJobIds: detailed.filter((job) => !job.onProjectJobIds).map((job) => job.jobId),
      countsByStatusQuery: byStatus,
      billedLabor,
      unattributedBilledLabor: unattributedBilled,
      timesheetHours: timesheetTotal,
      timesheetBurden,
      appointmentWindowBurden: appointmentBurden,
      commission,
      financialsComparison: target,
      technicians,
      jobs: open,
      canceledJobs: canceled,
    });
  }
  console.log(JSON.stringify({ readOnly: true, projects }, null, 2));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "Read failed";
  console.error(message.startsWith("Missing ") || message.startsWith("Pass ") || message.startsWith("Invalid ")
    ? message
    : "Read-only project job census failed. No records were written.");
  process.exitCode = 1;
});
