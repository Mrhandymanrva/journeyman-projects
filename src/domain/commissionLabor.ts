/**
 * Commission labor pricing.
 *
 * Pay rates are read from ServiceTitan and used in memory. They are not
 * written to Journeyman. The only stored rate is the company billable rate.
 *
 * Commission lookup order, in resolveTechCommission:
 *   (a) a payroll-settings payload (technician, bulk list, or export)
 *   (b) settings/v2 technicians.commissionRate when it is greater than 0
 *   (c) none
 * Step (a) is tolerant: a missing field, a zero, or a failed read falls through.
 */

export const DEFAULT_BILLABLE_RATE = 188;

export const PLACEHOLDER_TECHNICIAN_NAMES = [
  "office notes",
  "project requirements",
  "subcontractor",
] as const;

/**
 * Non-person technician records. The constant list is the exact ServiceTitan
 * labels. The pattern also matches those labels with a trailing note
 * ("Subcontractor - East", "Office Notes (old)") plus a few other bucket names.
 */
export const PLACEHOLDER_TECHNICIAN_PATTERN =
  /^(office notes|project requirements|subcontractor|placeholder|unassigned|do not use|non-?person)(\s.*)?$/i;

/** Same rule as PLACEHOLDER_TECHNICIAN_PATTERN, for SQL `~` on a lowercased name. */
export const PLACEHOLDER_TECHNICIAN_SQL =
  "^(office notes|project requirements|subcontractor|placeholder|unassigned|do not use|non-?person)([[:space:]].*)?$";

/** The two technicians the commission probe reads when no ids are passed. */
export const DEFAULT_PROBE_TECHNICIAN_IDS = ["322339504", "227070567"] as const;

export type PayBasis = "commission" | "hourly" | "missing";

export type CommissionSource = "payroll-settings" | "technician.commissionRate";

export interface ResolvedCommission {
  /** Fraction from 0 to 1. Null when no usable commission was found. */
  fraction: number | null;
  source: CommissionSource | null;
  /** JSON path of the payroll field, when source is payroll-settings. */
  path: string | null;
}

export interface CommissionLookup {
  /** One technician payroll-settings object, or null when that read failed. */
  payrollSettings?: unknown;
  /** settings/v2 technicians.commissionRate. Zero is not a commission. */
  technicianCommissionRate?: number | null;
}

export interface TechPaySource {
  id: string;
  name: string;
  active: boolean;
  hourlyRate: number | null;
  burdenRate: number | null;
  commissionRate?: number | null;
  /**
   * ServiceTitan managed-tech flag. False is an office or non-field record.
   * Omitted means the directory did not say, and the name filter still applies.
   */
  isManagedTech?: boolean | null;
}

export interface ResolvedTechPay extends TechPaySource {
  excluded: boolean;
  /** Active managed technician. Office records and placeholders are false. */
  isFieldTech: boolean;
  payBasis: PayBasis | null;
  commissionFraction: number | null;
  commissionSource: CommissionSource | null;
  /** Positive hourly rate used for pricing. Not stored. */
  appliedHourlyRate: number | null;
  /** Positive burden rate used for pricing. Not stored. */
  appliedBurdenRate: number | null;
  burdenUnset: boolean;
}

export interface PricedHours {
  excluded: boolean;
  payBasis: PayBasis | null;
  laborAmount: number | null;
  burdenAmount: number | null;
  burdenUnset: boolean;
  /** Errors. A zero hourly rate is never one of these for a commission tech. */
  errors: string[];
  /** Informational. Burden of 0 or null is "burden not set", not an error. */
  notices: string[];
}

export interface PayrollRead {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface PayrollReader {
  readTechnicianPayrollSettings?(id: string): Promise<PayrollRead>;
  readPayrollSettingsPage?(page: number): Promise<PayrollRead>;
  readPayrollSettingsExport?(from: string | null): Promise<PayrollRead>;
}

const PAYROLL_PAGE_CAP = 10;

const COMMISSION_KEY =
  /commission|percent|percentage/i;
const SKIP_COMMISSION_KEY = /hourly|burden|overtime|sold[\s_-]*by|split/i;

/** Preferred payroll keys, first match with a positive value wins. */
const COMMISSION_KEY_RANK = [
  "commissionrate",
  "commissionpercent",
  "commissionpercentage",
  "commission",
];

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function isPlaceholderTechnician(name: string | null | undefined): boolean {
  const key = name?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
  if (!key) return false;
  if ((PLACEHOLDER_TECHNICIAN_NAMES as readonly string[]).includes(key)) return true;
  return PLACEHOLDER_TECHNICIAN_PATTERN.test(key);
}

/**
 * Technician ids are compared as digit strings.
 * ServiceTitan sends the id as a JSON number. Timesheet rows store it as text.
 * `11000041` and `"11000041"` are the same technician.
 */
export function technicianIdKey(id: unknown): string {
  if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) return String(id);
  if (typeof id === "string") return id.trim();
  return "";
}

/** Blank timesheet names that no technician or employee record can fill. */
export function formerTechnicianLabel(id: string): string {
  return `Former tech #${id}`;
}

export function technicianDisplayName(name: string | null | undefined, id?: string | null): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  return id ? formerTechnicianLabel(id) : "Technician";
}

/**
 * A positive number up to 1 is a fraction (0.28 = 28%).
 * A number above 1 and up to 100 is a percent (28 = 28%).
 * Zero, negative, and above 100 are not a commission.
 */
export function commissionFraction(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0 || value > 100) return null;
  const fraction = value <= 1 ? value : value / 100;
  if (fraction <= 0 || fraction > 1) return null;
  return fraction;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isCommissionKey(key: string): boolean {
  return COMMISSION_KEY.test(key) && !SKIP_COMMISSION_KEY.test(key);
}

interface FoundCommission {
  path: string;
  key: string;
  value: number;
}

function consider(found: FoundCommission[], path: string, key: string, value: unknown): void {
  if (!isCommissionKey(key)) return;
  const numeric = coerceNumber(value);
  if (numeric === null) return;
  found.push({ path, key, value: numeric });
}

function walkCommission(value: unknown, path: string, found: FoundCommission[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkCommission(item, `${path}[${index}]`, found));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key;
    if (key === "customFields" && Array.isArray(child)) {
      child.forEach((field, index) => {
        if (!field || typeof field !== "object") return;
        const record = field as Record<string, unknown>;
        const name = String(record.name ?? record.typeName ?? record.key ?? "");
        consider(found, `${next}[${index}].value`, name, record.value);
      });
      continue;
    }
    if (child && typeof child === "object") {
      if (isCommissionKey(key) && !Array.isArray(child)) {
        const record = child as Record<string, unknown>;
        for (const nested of ["rate", "percent", "percentage", "value"]) {
          if (nested in record) consider(found, `${next}.${nested}`, key, record[nested]);
        }
      }
      walkCommission(child, next, found);
      continue;
    }
    consider(found, next, key, child);
  }
}

function commissionRank(key: string): number {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  const exact = COMMISSION_KEY_RANK.indexOf(normalized);
  if (exact >= 0) return exact;
  if (/commission/i.test(key)) return COMMISSION_KEY_RANK.length;
  return COMMISSION_KEY_RANK.length + 1;
}

/**
 * (a) any positive commission or percentage field on the payroll-settings
 * payload, (b) technicians.commissionRate when > 0, (c) none.
 */
export function resolveTechCommission(input: CommissionLookup): ResolvedCommission {
  const found: FoundCommission[] = [];
  if (input.payrollSettings != null) walkCommission(input.payrollSettings, "", found);
  found.sort((a, b) => commissionRank(a.key) - commissionRank(b.key) || a.path.length - b.path.length);
  for (const candidate of found) {
    const fraction = commissionFraction(candidate.value);
    if (fraction === null) continue;
    return { fraction, source: "payroll-settings", path: candidate.path };
  }
  const legacy = coerceNumber(input.technicianCommissionRate);
  const fromTechnician = legacy === null ? null : commissionFraction(legacy);
  if (fromTechnician !== null) {
    return {
      fraction: fromTechnician,
      source: "technician.commissionRate",
      path: "commissionRate",
    };
  }
  return { fraction: null, source: null, path: null };
}

function explicitTechId(record: Record<string, unknown>): string | null {
  if (record.employeeId != null && record.employeeId !== "") return String(record.employeeId);
  if (record.technicianId != null && record.technicianId !== "") return String(record.technicianId);
  return null;
}

function rowMatches(row: unknown, technicianId: string): boolean {
  if (!row || typeof row !== "object") return false;
  const record = row as Record<string, unknown>;
  const explicit = explicitTechId(record);
  if (explicit != null) return explicit === technicianId;
  return record.id != null && String(record.id) === technicianId;
}

/**
 * Pull one technician out of a payroll-settings list or export page.
 * A single object from technicians/{id}/payroll-settings is returned as-is
 * unless it names a different employee.
 */
export function payrollRecordForTechnician(body: unknown, technicianId: string): unknown | null {
  if (!body || typeof body !== "object") return null;
  if (Array.isArray(body)) {
    return body.find((row) => rowMatches(row, technicianId)) ?? null;
  }
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.data)) {
    return record.data.find((row) => rowMatches(row, technicianId)) ?? null;
  }
  const explicit = explicitTechId(record);
  if (explicit != null && explicit !== technicianId) return null;
  return record;
}

function pageRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: unknown[] }).data;
  }
  return [];
}

function pageHasMore(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && (body as { hasMore?: boolean }).hasMore);
}

function continueFrom(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const token = (body as { continueFrom?: unknown }).continueFrom;
  return typeof token === "string" && token.trim() ? token : null;
}

function positiveNamed(body: unknown, key: "hourlyRate" | "burdenRate"): number | null {
  if (!body || typeof body !== "object") return null;
  const stacks = [body, ...(Array.isArray((body as { data?: unknown }).data) ? [] : [])];
  const record = stacks[0] as Record<string, unknown>;
  for (const [name, value] of Object.entries(record)) {
    if (name.toLowerCase() !== key.toLowerCase()) continue;
    const numeric = coerceNumber(value);
    if (numeric != null && numeric > 0) return numeric;
  }
  return null;
}

async function safeRead(read: () => Promise<PayrollRead>): Promise<PayrollRead> {
  try {
    return await read();
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

interface PayrollCache {
  bulk: Map<string, unknown> | null;
  exported: Map<string, unknown> | null;
}

async function loadIdMap(
  readPage: (cursor: number | string | null) => Promise<PayrollRead>,
  mode: "page" | "export",
): Promise<Map<string, unknown>> {
  const map = new Map<string, unknown>();
  let cursor: number | string | null = mode === "page" ? 1 : null;
  for (let page = 0; page < PAYROLL_PAGE_CAP; page += 1) {
    const result = await safeRead(() => readPage(cursor));
    if (!result.ok) break;
    for (const row of pageRows(result.body)) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const id = explicitTechId(record) ?? (record.id != null ? String(record.id) : null);
      if (id) map.set(id, row);
    }
    if (mode === "export") {
      const next = continueFrom(result.body);
      if (!next || next === cursor) break;
      cursor = next;
      continue;
    }
    if (!pageHasMore(result.body)) break;
    cursor = (cursor as number) + 1;
  }
  return map;
}

/**
 * Payroll settings for one technician.
 * Individual GET, then the bulk list, then the export feed.
 * A failed call or a payload with no commission field does not throw.
 */
export async function loadPayrollSettings(
  technicianId: string,
  reader: PayrollReader | undefined,
  cache: PayrollCache,
): Promise<unknown | null> {
  if (!reader) return null;
  const candidates: unknown[] = [];
  if (reader.readTechnicianPayrollSettings) {
    const individual = await safeRead(() => reader.readTechnicianPayrollSettings!(technicianId));
    if (individual.ok) {
      const record = payrollRecordForTechnician(individual.body, technicianId);
      if (record) candidates.push(record);
    }
  }
  const haveCommission = (body: unknown) =>
    resolveTechCommission({ payrollSettings: body, technicianCommissionRate: null }).fraction != null;
  if (candidates.some(haveCommission)) {
    return candidates.find(haveCommission) ?? null;
  }
  if (reader.readPayrollSettingsPage) {
    if (!cache.bulk) {
      cache.bulk = await loadIdMap(
        (page) => reader.readPayrollSettingsPage!(page as number),
        "page",
      );
    }
    const fromBulk = cache.bulk.get(technicianId);
    if (fromBulk) candidates.push(fromBulk);
    if (candidates.some(haveCommission)) return candidates.find(haveCommission) ?? null;
  }
  if (reader.readPayrollSettingsExport) {
    if (!cache.exported) {
      cache.exported = await loadIdMap(
        (token) => reader.readPayrollSettingsExport!(typeof token === "string" ? token : null),
        "export",
      );
    }
    const fromExport = cache.exported.get(technicianId);
    if (fromExport) candidates.push(fromExport);
  }
  return candidates.find(haveCommission) ?? candidates[0] ?? null;
}

export function classifyTechnician(tech: TechPaySource, payrollSettings: unknown): ResolvedTechPay {
  const name = technicianDisplayName(tech.name, tech.id);
  const isFieldTech = tech.isManagedTech !== false && !isPlaceholderTechnician(tech.name);
  if (!isFieldTech) {
    return {
      ...tech,
      name,
      excluded: true,
      isFieldTech: false,
      payBasis: null,
      commissionFraction: null,
      commissionSource: null,
      appliedHourlyRate: null,
      appliedBurdenRate: null,
      burdenUnset: false,
    };
  }
  const commission = resolveTechCommission({
    payrollSettings,
    technicianCommissionRate: tech.commissionRate ?? null,
  });
  const hourlyFromPayroll = positiveNamed(payrollSettings, "hourlyRate");
  const burdenFromPayroll = positiveNamed(payrollSettings, "burdenRate");
  const appliedHourlyRate =
    hourlyFromPayroll ??
    (tech.hourlyRate != null && tech.hourlyRate > 0 ? tech.hourlyRate : null);
  const appliedBurdenRate =
    burdenFromPayroll ??
    (tech.burdenRate != null && tech.burdenRate > 0 ? tech.burdenRate : null);
  let payBasis: PayBasis;
  if (commission.fraction != null) payBasis = "commission";
  else if (appliedHourlyRate != null) payBasis = "hourly";
  else payBasis = "missing";
  return {
    ...tech,
    name,
    excluded: false,
    isFieldTech: true,
    payBasis,
    commissionFraction: commission.fraction,
    commissionSource: commission.source,
    appliedHourlyRate,
    appliedBurdenRate,
    burdenUnset: appliedBurdenRate == null,
  };
}

export function priceHours(hours: number, tech: ResolvedTechPay, billableRate: number): PricedHours {
  const notices = tech.burdenUnset && !tech.excluded ? [`burden not set for ${tech.name}`] : [];
  if (tech.excluded || tech.payBasis == null) {
    return {
      excluded: true,
      payBasis: null,
      laborAmount: null,
      burdenAmount: null,
      burdenUnset: false,
      errors: [],
      notices: [],
    };
  }
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 0;
  const rate = Number.isFinite(billableRate) && billableRate >= 0 ? billableRate : DEFAULT_BILLABLE_RATE;
  let laborAmount: number | null = null;
  const errors: string[] = [];
  if (tech.payBasis === "commission" && tech.commissionFraction != null) {
    laborAmount = roundMoney(safeHours * rate * tech.commissionFraction);
  } else if (tech.payBasis === "hourly" && tech.appliedHourlyRate != null) {
    laborAmount = roundMoney(safeHours * tech.appliedHourlyRate);
  } else {
    errors.push(`No ServiceTitan commission percent or hourly rate for ${tech.name}`);
  }
  const burdenAmount =
    tech.appliedBurdenRate != null ? roundMoney(safeHours * tech.appliedBurdenRate) : null;
  return {
    excluded: false,
    payBasis: tech.payBasis,
    laborAmount,
    burdenAmount,
    burdenUnset: tech.burdenUnset,
    errors,
    notices,
  };
}

/** What one technician's hours cost at a company billable rate. */
export function priceTechnicianHours(
  tech: TechPaySource,
  hours: number,
  billableRate: number,
  payrollSettings?: unknown,
): PricedHours {
  return priceHours(hours, classifyTechnician(tech, payrollSettings ?? null), billableRate);
}

/**
 * Commission labor was priced at `pricedAt`. A new company billable rate
 * scales that labor. Hourly labor is not passed here.
 */
export function rescaleCommissionLabor(amount: number, pricedAt: number, nextRate: number): number {
  if (!Number.isFinite(amount) || !Number.isFinite(pricedAt) || pricedAt <= 0) return roundMoney(amount);
  if (!Number.isFinite(nextRate) || nextRate < 0) return roundMoney(amount);
  return roundMoney((amount * nextRate) / pricedAt);
}

export async function resolvePayForTechnicians(
  technicians: TechPaySource[],
  reader?: PayrollReader,
): Promise<ResolvedTechPay[]> {
  const cache: PayrollCache = { bulk: null, exported: null };
  const resolved: ResolvedTechPay[] = [];
  for (let offset = 0; offset < technicians.length; offset += 4) {
    const batch = technicians.slice(offset, offset + 4);
    const part = await Promise.all(
      batch.map(async (tech) => {
        const payrollSettings = tech.id
          ? await loadPayrollSettings(tech.id, reader, cache)
          : null;
        return classifyTechnician(tech, payrollSettings);
      }),
    );
    resolved.push(...part);
  }
  return resolved;
}

export function payrollReaderFrom(client: {
  readAllowlistedGet?(
    family: "payroll" | "settings",
    resource: string,
    query?: Record<string, string>,
  ): Promise<PayrollRead>;
} | null | undefined): PayrollReader | undefined {
  if (!client?.readAllowlistedGet) return undefined;
  const get = client.readAllowlistedGet.bind(client);
  return {
    readTechnicianPayrollSettings: (id) => {
      if (!/^\d+$/.test(id)) return Promise.resolve({ ok: false, status: 0, body: null });
      return get("payroll", `technicians/${id}/payroll-settings`);
    },
    readPayrollSettingsPage: (page) =>
      get("payroll", "payroll-settings", { page: String(page), pageSize: "200" }),
    readPayrollSettingsExport: (from) =>
      get(
        "payroll",
        "export/payroll-settings",
        from ? { from, pageSize: "200" } : { pageSize: "200" },
      ),
  };
}

export const MISSING_PAY_MESSAGE = "No ServiceTitan commission percent or hourly rate";
export const BURDEN_NOT_SET_MESSAGE = "burden not set";
