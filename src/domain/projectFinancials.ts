/**
 * ServiceTitan project financials and the job list those dollars come from.
 * Pure functions. No ServiceTitan writes and no clock-time hours.
 */

export const SEGRETO_PROJECT_ID = "321586598";
export const SEGRETO_JOB_COUNT = 33;
export const SEGRETO_LINKED_JOB = "144898";
export const FRANCISCO_JOB_ID = "145416";

export const OTHER_PROJECT_ID = "321293715";
export const OTHER_JOB_COUNT = 12;
export const OTHER_MISSING_JOB = "145583";

export const JOB_LIST_STATUSES = [
  "Scheduled",
  "Dispatched",
  "InProgress",
  "Hold",
  "Completed",
  "Canceled",
] as const;

/** Acceptance totals from ServiceTitan Project Financials for Segreto. */
export const SEGRETO_FINANCIALS = {
  billedLabor: 15096.4,
  billedMaterials: 9263.2,
  billed: 24359.6,
  laborBurden: 2440.43,
  materialsExpense: 5239.21,
  expenses: 7679.64,
  margin: 16679.96,
  marginPercent: 68.47,
} as const;

/**
 * Acceptance totals from ServiceTitan Project Financials for Dalton
 * (ST project 290588725). Live invoice lines: labor revenue 67,305.00,
 * material revenue 25,101.79, and 25,000.00 that is neither
 * (one 20,000 Sub Contractor Revenue line and two 2,500 Misc Income lines).
 * Billed is the invoice header total, 117,406.79.
 * Labor expense 21,883.04 is the published ServiceTitan figure. Paid hours
 * times the burden rate can equal it. Gross-pay amounts might be that
 * figure instead. Production payroll is required to tell them apart.
 */
export const DALTON_PROJECT_ID = "290588725";
export const DALTON_FINANCIALS = {
  billedLabor: 67305,
  billedMaterials: 25101.79,
  billed: 117406.79,
  laborBurden: 21883.04,
  materialsExpense: 31748.12,
  expenses: 53631.16,
  margin: 63775.63,
  marginPercent: 54.32,
} as const;

export interface ListedJob {
  id: string;
  jobNumber: string;
  jobStatus: string;
  createdOn?: string | null;
  completedOn?: string | null;
}

export interface InvoiceLineInput {
  total: number;
  kind: "labor" | "material" | "other";
  technicianId?: string | null;
}

export interface BurdenSlice {
  technicianId: string;
  hours: number;
  burdenRate: number | null;
}

export interface PurchaseOrderInput {
  total: number;
  canceled?: boolean;
}

export interface ProjectMoney {
  billedLabor: number;
  billedMaterials: number;
  billed: number;
  laborBurden: number;
  materialsExpense: number;
  expenses: number;
  margin: number;
  marginPercent: number;
}

export type ReconciliationLaborStatus = "estimated" | "missing";

export interface ReconciliationLine {
  key: keyof ProjectMoney;
  label: string;
  jp: number;
  st: number;
  delta: number;
  /**
   * Set on the labor line. `estimated` is the 25% commission plus timesheet
   * burden, shown next to ServiceTitan's labor expense as a known difference.
   * `missing` means a recent project had no payroll rows and was not estimated.
   */
  status?: ReconciliationLaborStatus;
  commission?: number;
  burden?: number;
  billed_labor?: number;
  billed_labor_plfe?: number;
}

/** Published Project Financials Expense > Labor, where ServiceTitan's figure is known. */
export function publishedServiceTitanLabor(stProjectId: string | null | undefined): number | null {
  if (stProjectId === DALTON_PROJECT_ID) return DALTON_FINANCIALS.laborBurden;
  if (stProjectId === SEGRETO_PROJECT_ID) return SEGRETO_FINANCIALS.laborBurden;
  return null;
}

const MONEY_LABELS: Record<keyof ProjectMoney, string> = {
  billedLabor: "Billed labor",
  billedMaterials: "Billed materials",
  billed: "Billed",
  laborBurden: "Labor burden",
  materialsExpense: "Materials expense",
  expenses: "Expenses",
  margin: "Margin",
  marginPercent: "Margin percent",
};

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Every job returned for the project, plus any id the project object still
 * lists. A job ServiceTitan returns only from jobs?projectId= is kept.
 * Canceled jobs stay in the set so labor and invoices still include them.
 */
export function unionProjectJobs(
  projectJobIds: readonly string[],
  listed: readonly ListedJob[],
): ListedJob[] {
  const byId = new Map<string, ListedJob>();
  for (const job of listed) {
    const id = job.id.trim();
    if (!id) continue;
    byId.set(id, { ...job, id });
  }
  for (const raw of projectJobIds) {
    const id = raw.trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, { id, jobNumber: id, jobStatus: "Unknown" });
  }
  return [...byId.values()].sort((a, b) => a.jobNumber.localeCompare(b.jobNumber) || a.id.localeCompare(b.id));
}

/**
 * Payroll timesheet hours. Dispatch, arrive, and done timestamps are not hours.
 * A positive paid duration under 1000 hours is the only accepted value.
 */
export function payrollHours(row: {
  canceledOn?: string | null;
  paidDurationHours?: number | null;
  paidHours?: number | null;
  hours?: number | null;
}): number | null {
  if (row.canceledOn) return null;
  for (const value of [row.paidDurationHours, row.paidHours, row.hours]) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (value <= 0 || value >= 1000) continue;
    return roundMoney(value);
  }
  return null;
}

/** Mason: these codes are never labor revenue, whatever the account label says. */
export function neverLaborCode(sku: string | null | undefined): "MHM 250.Labor" | "MHM.25LFCO" | null {
  const key = sku?.trim().toLowerCase() ?? "";
  if (key === "mhm 250.labor") return "MHM 250.Labor";
  if (key === "mhm.25lfco") return "MHM.25LFCO";
  return null;
}

/** One warning per line, naming the code and the invoice. The amount stays in billed as other. */
export function neverLaborRevenueWarnings(
  lines: readonly { sku: string; invoiceId: string }[],
): string[] {
  const warnings: string[] = [];
  for (const line of lines) {
    const code = neverLaborCode(line.sku);
    if (!code) continue;
    warnings.push(`${code} on invoice ${line.invoiceId} is not labor revenue.`);
  }
  return warnings;
}

/**
 * Billed labor and billed materials follow the invoice item's general ledger
 * account, which is how ServiceTitan Project Financials groups the lines.
 * No endpoint sends a project label. "Labor Revenue…" is labor. "Material
 * Revenue…" is materials, including the Van Stock price modifier. When the
 * account is missing, Service is labor and Material or PriceModifier is
 * materials. MHM 250.Labor and MHM.25LFCO are never labor revenue. Their
 * amount stays in the billed total as other. MHM.25PLFE stays the cost code
 * for labor expense and is not used here.
 */
export function classifyInvoiceItem(item: {
  sku?: string | null;
  type?: string | null;
  accountName?: string | null;
}): "labor" | "material" | "other" {
  if (neverLaborCode(item.sku)) return "other";
  const account = item.accountName?.trim().toLowerCase() ?? "";
  if (account) {
    if (account.startsWith("labor revenue")) return "labor";
    if (account.startsWith("material revenue")) return "material";
    return "other";
  }
  const type = item.type?.trim().toLowerCase() ?? "";
  if (type === "service") return "labor";
  if (type === "material" || type === "pricemodifier") return "material";
  return "other";
}

export function financialsFromReads(input: {
  invoiceLines: readonly InvoiceLineInput[];
  timesheets: readonly BurdenSlice[];
  purchaseOrders: readonly PurchaseOrderInput[];
}): ProjectMoney {
  const billedLabor = roundMoney(
    input.invoiceLines.filter((line) => line.kind === "labor").reduce((sum, line) => sum + line.total, 0),
  );
  const billedMaterials = roundMoney(
    input.invoiceLines.filter((line) => line.kind === "material").reduce((sum, line) => sum + line.total, 0),
  );
  const billedOther = roundMoney(
    input.invoiceLines.filter((line) => line.kind === "other").reduce((sum, line) => sum + line.total, 0),
  );
  // Actual billed is the invoice total. Subcontractor revenue and miscellaneous
  // income are not labor or material labels, and they are still billed.
  const billed = roundMoney(billedLabor + billedMaterials + billedOther);
  // Journeyman labor burden is worked hours times the technician burden rate
  // when payroll gross pay has paid hours. An older project with no matching
  // payroll rows stores 25% of billed labor plus arrived-to-done burden instead.
  // ServiceTitan Project Financials > Expense > Labor is not on the project
  // payload. The refresh stores a separate breakdown: burden, plus non-PTO
  // gross pay on the project's jobs, plus payroll adjustments.
  const laborBurden = roundMoney(
    input.timesheets.reduce((sum, row) => {
      if (row.burdenRate == null || !(row.burdenRate > 0) || !(row.hours > 0)) return sum;
      return sum + roundMoney(row.hours * row.burdenRate);
    }, 0),
  );
  const materialsExpense = roundMoney(
    input.purchaseOrders
      .filter((row) => !row.canceled)
      .reduce((sum, row) => sum + row.total, 0),
  );
  const expenses = roundMoney(laborBurden + materialsExpense);
  const margin = roundMoney(billed - expenses);
  return {
    billedLabor,
    billedMaterials,
    billed,
    laborBurden,
    materialsExpense,
    expenses,
    margin,
    marginPercent: billed > 0 ? Math.round((margin / billed) * 10000) / 100 : 0,
  };
}

/**
 * Billed labor attributed to technicians.
 * A line with a technician id stays with that technician.
 * A line with no technician is split by payroll-timesheet hours.
 */
export function splitBilledLabor(
  lines: readonly InvoiceLineInput[],
  hoursByTech: ReadonlyMap<string, number>,
): Map<string, number> {
  const direct = new Map<string, number>();
  let lump = 0;
  for (const line of lines) {
    if (line.kind !== "labor") continue;
    const tech = line.technicianId?.trim();
    if (tech) direct.set(tech, roundMoney((direct.get(tech) ?? 0) + line.total));
    else lump = roundMoney(lump + line.total);
  }
  const hourTotal = roundMoney([...hoursByTech.values()].reduce((sum, hours) => sum + (hours > 0 ? hours : 0), 0));
  const shares = new Map<string, number>(direct);
  if (lump > 0 && hourTotal > 0) {
    for (const [id, hours] of hoursByTech) {
      if (!(hours > 0)) continue;
      const part = roundMoney(lump * (hours / hourTotal));
      shares.set(id, roundMoney((shares.get(id) ?? 0) + part));
    }
  }
  return shares;
}

export function commissionDollars(billedShare: number, fraction: number | null): number | null {
  if (fraction == null || !(fraction > 0) || !(billedShare > 0)) return billedShare > 0 && fraction === 0 ? 0 : null;
  return roundMoney(billedShare * fraction);
}

/** Replace billed with ServiceTitan's invoice header total and recompute margin. */
export function withBilled(money: ProjectMoney, billed: number): ProjectMoney {
  const next = roundMoney(billed);
  const margin = roundMoney(next - money.expenses);
  return {
    ...money,
    billed: next,
    margin,
    marginPercent: next > 0 ? Math.round((margin / next) * 10000) / 100 : 0,
  };
}

/** Replace labor burden and recompute expenses and margin. */
export function withLaborBurden(money: ProjectMoney, laborBurden: number): ProjectMoney {
  const burden = roundMoney(laborBurden);
  const expenses = roundMoney(burden + money.materialsExpense);
  const margin = roundMoney(money.billed - expenses);
  return {
    ...money,
    laborBurden: burden,
    expenses,
    margin,
    marginPercent: money.billed > 0 ? Math.round((margin / money.billed) * 10000) / 100 : 0,
  };
}

export function reconcileFinancials(jp: ProjectMoney, st: ProjectMoney): ReconciliationLine[] {
  return (Object.keys(MONEY_LABELS) as Array<keyof ProjectMoney>).map((key) => ({
    key,
    label: MONEY_LABELS[key],
    jp: jp[key],
    st: st[key],
    delta: roundMoney(jp[key] - st[key]),
  }));
}

/** Thirty-three Segreto jobs. 144898 is the one Journeyman used to keep. Francisco is 145416. */
export function segretoJobList(): ListedJob[] {
  const jobs: ListedJob[] = [];
  for (let n = 1; n <= SEGRETO_JOB_COUNT; n += 1) {
    const id = String(144000 + n);
    jobs.push({
      id: n === 1 ? SEGRETO_LINKED_JOB : n === 2 ? FRANCISCO_JOB_ID : id,
      jobNumber: String(144000 + n),
      jobStatus: n > 28 ? "Scheduled" : n === 2 ? "Completed" : "InProgress",
    });
  }
  return jobs;
}

/** Twelve jobs on 321293715. 145583 is the one the old jobIds list omitted. */
export function otherProjectJobList(knownIds: readonly string[]): ListedJob[] {
  const jobs: ListedJob[] = knownIds.map((id) => ({
    id,
    jobNumber: id,
    jobStatus: "Completed",
  }));
  if (!jobs.some((job) => job.id === OTHER_MISSING_JOB)) {
    jobs.push({ id: OTHER_MISSING_JOB, jobNumber: OTHER_MISSING_JOB, jobStatus: "Scheduled" });
  }
  while (jobs.length < OTHER_JOB_COUNT) {
    const id = String(145000 + jobs.length);
    jobs.push({ id, jobNumber: id, jobStatus: "Scheduled" });
  }
  return jobs.slice(0, OTHER_JOB_COUNT);
}
