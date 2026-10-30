/**
 * Read-only ServiceTitan lists for the purchase-order preview.
 * Every call is a GET. Nothing here creates or updates a purchase order.
 * Results are cached per source for ten minutes so a preview does not
 * re-read the same directory on every dropdown.
 */

import {
  buildStPurchaseOrderPlan,
  INVENTORY_SKU_SOURCE,
  type StPoPlan,
  type StPoPreviewRecord,
  type StPoSyncSettings,
} from "./stPurchaseOrderSync.js";

export const ST_PO_LOOKUP_TTL_MS = 10 * 60 * 1000;

/** Inventory create requires skuId, quantity, and cost on every item. There is no generic line. */
export const ST_PO_SKU_REQUIRED = true;

export const ST_PO_SKU_NOTE =
  "ServiceTitan requires a SKU id on every purchase order item (skuId, quantity, and cost). The Inventory API has no generic item and no line that omits the SKU. A pricebook material marked non-inventory still has a SKU id and is listed here as Non-inventory.";

export interface StNamedOption {
  id: string;
  name: string;
}

export interface StSkuOption {
  id: string;
  name: string;
  code: string | null;
  nonInventory: boolean;
}

export interface StPoJobFact {
  id: string;
  jobNumber: string | null;
  summary: string | null;
  businessUnitId: string | null;
}

export interface StPoCatalogClient {
  listPoVendors(): Promise<StNamedOption[]>;
  listPoTypes(): Promise<StNamedOption[]>;
  listBusinessUnits(): Promise<StNamedOption[]>;
  listInventoryLocations(): Promise<StNamedOption[]>;
  listPoSkus(): Promise<StSkuOption[]>;
  readPoJob(jobId: string): Promise<StPoJobFact | null>;
}

export interface LookupList<T> {
  options: T;
  error: string | null;
}

export interface StPoCatalog {
  vendors: LookupList<StNamedOption[]>;
  types: LookupList<StNamedOption[]>;
  businessUnits: LookupList<StNamedOption[]>;
  locations: LookupList<StNamedOption[]>;
  skus: LookupList<StSkuOption[]>;
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();

export function clearStPoLookupCache(): void {
  cache.clear();
}

export async function cachedStLookup<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value as T;
  const value = await load();
  cache.set(key, { expires: now + ttlMs, value });
  return value;
}

const NOT_CONNECTED = "ServiceTitan is not connected. No lookup was sent.";

function emptyCatalog(error: string): StPoCatalog {
  return {
    vendors: { options: [], error },
    types: { options: [], error },
    businessUnits: { options: [], error },
    locations: { options: [], error },
    skus: { options: [], error },
  };
}

async function oneLookup<T>(
  scope: string,
  name: string,
  load: () => Promise<T>,
  empty: T,
): Promise<LookupList<T>> {
  try {
    return { options: await cachedStLookup(`${scope}:${name}`, ST_PO_LOOKUP_TTL_MS, load), error: null };
  } catch (err) {
    return { options: empty, error: err instanceof Error ? err.message : String(err) };
  }
}

/** GETs only. A missing client returns empty lists and does not throw. */
export async function loadStPoCatalog(scope: string, client: StPoCatalogClient | null): Promise<StPoCatalog> {
  if (!client) return emptyCatalog(NOT_CONNECTED);
  const [vendors, types, businessUnits, locations, skus] = await Promise.all([
    oneLookup(scope, "vendors", () => client.listPoVendors(), []),
    oneLookup(scope, "types", () => client.listPoTypes(), []),
    oneLookup(scope, "business-units", () => client.listBusinessUnits(), []),
    oneLookup(scope, "locations", () => client.listInventoryLocations(), []),
    oneLookup(scope, "skus", () => client.listPoSkus(), []),
  ]);
  return { vendors, types, businessUnits, locations, skus };
}

export async function lookupJobBusinessUnit(
  scope: string,
  client: StPoCatalogClient | null,
  jobId: string | null,
): Promise<string | null> {
  if (!client || !jobId || !/^\d+$/.test(jobId)) return null;
  try {
    const job = await cachedStLookup(`${scope}:job:${jobId}`, ST_PO_LOOKUP_TTL_MS, () => client.readPoJob(jobId));
    const id = job?.businessUnitId?.trim() ?? "";
    return /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function normalizePartyName(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** One exact name match is preselected. Two matches, or a partial match, are not. */
export function matchVendorName(
  vendorName: string | null,
  options: ReadonlyArray<StNamedOption>,
): string | null {
  const needle = normalizePartyName(vendorName);
  if (!needle) return null;
  const exact = options.filter((option) => normalizePartyName(option.name) === needle);
  return exact.length === 1 ? exact[0]!.id : null;
}

export function filterSkus(skus: ReadonlyArray<StSkuOption>, query: string): StSkuOption[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return skus.slice(0, 50);
  return skus
    .filter((sku) => {
      const hay = `${sku.name} ${sku.code ?? ""}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    })
    .slice(0, 50);
}

/**
 * Matches for the line, plus non-inventory pricebook SKUs so the PM can pick
 * one. Those are still SKU ids. A line with no SKU is not offered.
 */
export function skuChoices(skus: ReadonlyArray<StSkuOption>, query: string): StSkuOption[] {
  const matched = filterSkus(skus, query);
  const seen = new Set(matched.map((sku) => sku.id));
  const extras = skus.filter((sku) => sku.nonInventory && !seen.has(sku.id)).slice(0, 15);
  return [...matched, ...extras].slice(0, 50);
}

export function skuLabel(sku: StSkuOption): string {
  const name = sku.name.trim() || sku.code || sku.id;
  const code = sku.code && sku.code.trim() && sku.code.trim() !== name ? `${sku.code.trim()} · ` : "";
  return sku.nonInventory ? `Non-inventory · ${code}${name}` : `${code}${name}`;
}

export interface StPoDropdownField {
  key: "vendorId" | "typeId" | "businessUnitId" | "inventoryLocationId" | "jobId";
  label: string;
  selected: string | null;
  suggested: string | null;
  options: Array<{ id: string; label: string }>;
  lookup_error: string | null;
}

export interface StPoLineChoice {
  line_id: string | null;
  description: string;
  amount: number;
  code: string;
  sku_id: string | null;
  needs_sku: boolean;
  options: Array<{ id: string; label: string; non_inventory: boolean }>;
  lookup_error: string | null;
}

export interface StPoPreviewView {
  po_id: string;
  po_number: string;
  kind: string;
  status: string;
  st_po_id: string | null;
  st_po_sync_state: string | null;
  st_po_sync_error: string | null;
  writes_enabled: boolean;
  sku_required: true;
  generic_item: null;
  sku_note: string;
  plan: StPoPlan;
  fields: StPoDropdownField[];
  lines: StPoLineChoice[];
}

function numeric(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function namedOptions(rows: ReadonlyArray<StNamedOption>): Array<{ id: string; label: string }> {
  return rows.map((row) => ({ id: row.id, label: row.name }));
}

export function assembleStPoPreview(
  snapshot: StPoPreviewRecord,
  catalog: StPoCatalog,
  jobBusinessUnitId: string | null,
): StPoPreviewView {
  const storedVendor = numeric(snapshot.stored_vendor_id);
  const vendorSuggested = storedVendor ? null : matchVendorName(snapshot.vendor_name, catalog.vendors.options);
  const effectiveVendor = storedVendor ?? vendorSuggested;

  const storedType = snapshot.settings.purchaseOrderTypeId;
  const storedBu = snapshot.settings.businessUnitId;
  const buSuggested = storedBu ? null : numeric(jobBusinessUnitId);
  const effectiveBu = storedBu ?? buSuggested;
  const storedLocation = snapshot.settings.inventoryLocationId;

  const effectiveSettings: StPoSyncSettings = {
    enabled: snapshot.settings.enabled,
    purchaseOrderTypeId: storedType,
    businessUnitId: effectiveBu,
    inventoryLocationId: storedLocation,
  };

  const plan = buildStPurchaseOrderPlan({
    poId: snapshot.po_id,
    poNumber: snapshot.po_number,
    kind: snapshot.kind,
    scope: snapshot.scope,
    issuedOn: snapshot.issued_on,
    vendorName: snapshot.vendor_name,
    stVendorId: effectiveVendor,
    projectName: snapshot.project_name,
    street: snapshot.street,
    city: snapshot.city,
    region: snapshot.region,
    postalCode: snapshot.postal_code,
    jobId: snapshot.resolved_job_id,
    jobAmbiguous: snapshot.job_ambiguous,
    stProjectId: snapshot.st_project_id,
    lines: snapshot.lines.map((line) => ({
      lineId: line.line_id,
      description: line.description,
      amount: line.amount,
      code: line.code,
      externalSource: line.external_source,
      externalId: line.external_id,
      skuId: line.stored_sku_id,
    })),
    settings: effectiveSettings,
  });

  const fields: StPoDropdownField[] = [];
  if (!storedVendor) {
    fields.push({
      key: "vendorId",
      label: "Vendor",
      selected: null,
      suggested: vendorSuggested,
      options: namedOptions(catalog.vendors.options),
      lookup_error: catalog.vendors.error,
    });
  }
  if (!storedType) {
    fields.push({
      key: "typeId",
      label: "Purchase order type",
      selected: null,
      suggested: null,
      options: namedOptions(catalog.types.options),
      lookup_error: catalog.types.error,
    });
  }
  if (!storedBu) {
    fields.push({
      key: "businessUnitId",
      label: "Business unit",
      selected: null,
      suggested: buSuggested,
      options: namedOptions(catalog.businessUnits.options),
      lookup_error: catalog.businessUnits.error,
    });
  }
  if (!storedLocation) {
    fields.push({
      key: "inventoryLocationId",
      label: "Inventory location",
      selected: null,
      suggested: null,
      options: namedOptions(catalog.locations.options),
      lookup_error: catalog.locations.error,
    });
  }
  if (snapshot.job_ambiguous || !snapshot.resolved_job_id) {
    fields.push({
      key: "jobId",
      label: "Job",
      selected: null,
      suggested: null,
      options: snapshot.jobs.map((job) => ({
        id: job.id,
        label: job.summary ? `${job.number} — ${job.summary}` : job.number,
      })),
      lookup_error: null,
    });
  }

  const lines: StPoLineChoice[] = snapshot.lines.map((line) => {
    const mapped =
      line.external_source === INVENTORY_SKU_SOURCE ? numeric(line.external_id) : null;
    const skuId = numeric(line.stored_sku_id) ?? mapped;
    const query = line.description.trim() || snapshot.scope;
    const options = skuChoices(catalog.skus.options, query).map((sku) => ({
      id: sku.id,
      label: skuLabel(sku),
      non_inventory: sku.nonInventory,
    }));
    return {
      line_id: line.line_id,
      description: line.description.trim() || snapshot.scope,
      amount: line.amount,
      code: line.code,
      sku_id: skuId,
      needs_sku: !skuId,
      options: skuId ? [] : options,
      lookup_error: skuId ? null : catalog.skus.error,
    };
  });

  return {
    po_id: snapshot.po_id,
    po_number: snapshot.po_number,
    kind: snapshot.kind,
    status: snapshot.status,
    st_po_id: snapshot.st_po_id,
    st_po_sync_state: snapshot.st_po_sync_state,
    st_po_sync_error: snapshot.st_po_sync_error,
    writes_enabled: snapshot.settings.enabled,
    sku_required: ST_PO_SKU_REQUIRED,
    generic_item: null,
    sku_note: ST_PO_SKU_NOTE,
    plan,
    fields,
    lines,
  };
}
