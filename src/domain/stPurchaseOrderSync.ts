/**
 * Two-way ServiceTitan inventory purchase orders.
 *
 * Outbound creates run only when PM_ST_PO_SYNC_ENABLED is exactly "true".
 * The default is off, so a deploy does not call ServiceTitan. Existing
 * purchase orders are not scanned on boot, provision, or the nightly read.
 * Mason sends one of those with the owner-only confirm action.
 *
 * Idempotency: the purchase order row is marked pending and the payload
 * is stored before the POST. The memo starts with jp-po:{id}. A retry
 * searches ServiceTitan for that memo before it POSTs again. st_po_id is
 * unique per tenant. An in-process guard plus a session advisory lock
 * stop two overlapping creates of the same purchase order.
 */

import type { Database, SqlClient } from "../db/database.js";
import { roundMoney } from "./projectFinancials.js";

export const ST_PO_SYNC_FLAG = "PM_ST_PO_SYNC_ENABLED";
export const INVENTORY_SKU_SOURCE = "servicetitan_inventory_sku";
export const PURCHASE_ORDERS_WRITE_SCOPE = "tn.inv.purchaseorders:w";

const inFlight = new Set<string>();

export interface StPoSyncSettings {
  enabled: boolean;
  purchaseOrderTypeId: string | null;
  inventoryLocationId: string | null;
  businessUnitId: string | null;
}

export function stPoSyncSettings(env: NodeJS.ProcessEnv = process.env): StPoSyncSettings {
  return {
    enabled: env[ST_PO_SYNC_FLAG] === "true",
    purchaseOrderTypeId: numericId(env.PM_ST_PO_TYPE_ID),
    inventoryLocationId: numericId(env.PM_ST_INVENTORY_LOCATION_ID),
    businessUnitId: numericId(env.PM_ST_BUSINESS_UNIT_ID),
  };
}

export function stPoMarker(poId: string): string {
  return `jp-po:${poId}`;
}

export interface StInventoryPurchaseOrderClient {
  createInventoryPurchaseOrder(body: Record<string, unknown>): Promise<{ id: string }>;
  findInventoryPurchaseOrderByMarker(jobId: string, marker: string): Promise<{ id: string } | null>;
}

export interface StPoLineInput {
  description: string;
  amount: number;
  code: string;
  externalSource: string | null;
  externalId: string | null;
}

export interface StPoPlanInput {
  poId: string;
  poNumber: string;
  kind: string;
  scope: string;
  issuedOn: string | null;
  vendorName: string | null;
  stVendorId: string | null;
  projectName: string;
  street: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  jobId: string | null;
  jobAmbiguous: boolean;
  stProjectId: string | null;
  lines: StPoLineInput[];
  settings: StPoSyncSettings;
}

export interface StPoPlan {
  marker: string;
  jobId: string | null;
  payload: Record<string, unknown>;
  missing: string[];
}

/** Fields ServiceTitan requires, filled only from a real Journeyman source or an explicit env id. */
export function buildStPurchaseOrderPlan(input: StPoPlanInput): StPoPlan {
  const marker = stPoMarker(input.poId);
  const missing: string[] = [];
  const vendorId = numericId(input.stVendorId);
  if (!vendorId) {
    missing.push(
      "vendorId: this vendor has no ServiceTitan vendor id (vendors.st_vendor_id). The QuickBooks vendor id is not used.",
    );
  }
  if (!input.settings.purchaseOrderTypeId) {
    missing.push(
      "typeId: Journeyman has no ServiceTitan purchase order type. Set PM_ST_PO_TYPE_ID. Nothing is guessed.",
    );
  }
  if (!input.settings.businessUnitId) {
    missing.push(
      "businessUnitId: a Journeyman business unit is not a ServiceTitan business unit id. Set PM_ST_BUSINESS_UNIT_ID.",
    );
  }
  if (!input.settings.inventoryLocationId) {
    missing.push(
      "inventoryLocationId: Journeyman does not store a ServiceTitan inventory location or ship-to warehouse. Set PM_ST_INVENTORY_LOCATION_ID.",
    );
  }
  if (input.jobAmbiguous) {
    missing.push(
      "jobId: this project has more than one ServiceTitan job. Set the purchase order's ServiceTitan job. One is not picked for you.",
    );
  } else if (!numericId(input.jobId)) {
    missing.push("jobId: this project has no ServiceTitan job, so no purchase order is created.");
  }
  const street = input.street?.trim() ?? "";
  const city = input.city?.trim() ?? "";
  const region = input.region?.trim() ?? "";
  const zip = input.postalCode?.trim() ?? "";
  if (!street || !city || !region || !zip) {
    missing.push(
      "shipTo: the project needs a street, city, state, and postal code. Country is not stored and is not sent.",
    );
  }
  if (!input.issuedOn) {
    missing.push("date: this purchase order has no issued date.");
  }
  const items = input.lines.map((line) => {
    const skuId = line.externalSource === INVENTORY_SKU_SOURCE ? numericId(line.externalId) : null;
    if (!skuId) {
      missing.push(
        `items.skuId: cost code ${line.code || "(none)"} is not a ServiceTitan inventory SKU. Set cost_codes.external_source to ${INVENTORY_SKU_SOURCE} and external_id to the SKU id. A cost code is not sent as an item.`,
      );
    }
    return {
      ...(skuId ? { skuId: Number(skuId) } : {}),
      description: line.description.trim() || input.scope,
      quantity: 1,
      cost: roundMoney(line.amount),
    };
  });
  if (items.length === 0) {
    missing.push("items: this purchase order has no lines to send.");
  }
  const payload: Record<string, unknown> = {
    ...(vendorId ? { vendorId: Number(vendorId) } : {}),
    ...(input.settings.purchaseOrderTypeId ? { typeId: Number(input.settings.purchaseOrderTypeId) } : {}),
    ...(input.settings.businessUnitId ? { businessUnitId: Number(input.settings.businessUnitId) } : {}),
    ...(input.settings.inventoryLocationId
      ? { inventoryLocationId: Number(input.settings.inventoryLocationId) }
      : {}),
    ...(numericId(input.jobId) && !input.jobAmbiguous ? { jobId: Number(input.jobId) } : {}),
    ...(numericId(input.stProjectId) ? { projectId: Number(input.stProjectId) } : {}),
    shipTo: {
      description: input.projectName,
      address: {
        street,
        city,
        state: region,
        ...(zip ? { zip } : {}),
      },
    },
    ...(input.issuedOn ? { date: input.issuedOn } : {}),
    memo: `${marker} ${input.poNumber}`.trim(),
    tax: 0,
    shipping: 0,
    items,
  };
  return {
    marker,
    jobId: input.jobAmbiguous ? null : numericId(input.jobId),
    payload,
    missing,
  };
}

export interface StPoSyncResult {
  state: "flag_off" | "in_progress" | "created" | "pending" | "failed" | "blocked" | "skipped" | "no_job";
  stPoId?: string | null;
  error?: string | null;
  missing?: string[];
  calls?: number;
}

export async function syncIssuedPurchaseOrder(input: {
  database: Database;
  tenantId: string;
  poId: string;
  settings: StPoSyncSettings;
  client: StInventoryPurchaseOrderClient | null;
  afterRemoteCreate?: (stPoId: string) => Promise<void>;
}): Promise<StPoSyncResult> {
  if (!input.settings.enabled) return { state: "flag_off" };
  if (inFlight.has(input.poId)) return { state: "in_progress" };
  inFlight.add(input.poId);
  const lock = await input.database.tryAdvisoryLock(`st-po-sync:${input.poId}`);
  if (!lock) {
    inFlight.delete(input.poId);
    return { state: "in_progress" };
  }
  try {
    return await syncLocked(input);
  } finally {
    inFlight.delete(input.poId);
    await lock.release();
  }
}

async function syncLocked(input: {
  database: Database;
  tenantId: string;
  poId: string;
  settings: StPoSyncSettings;
  client: StInventoryPurchaseOrderClient | null;
  afterRemoteCreate?: (stPoId: string) => Promise<void>;
}): Promise<StPoSyncResult> {
  const loaded = await input.database.withTenant(input.tenantId, (db) => loadPoSyncContext(db, input.poId));
  if (!loaded) return { state: "skipped", error: "Purchase order not found." };
  if (loaded.stPoId) return { state: "created", stPoId: loaded.stPoId };
  if (loaded.origin === "servicetitan") return { state: "skipped" };
  if (loaded.kind !== "material" && loaded.kind !== "subcontract") return { state: "skipped" };
  if (!["issued", "partially_billed", "closed"].includes(loaded.status)) return { state: "skipped" };
  const plan = buildStPurchaseOrderPlan({ ...loaded.plan, settings: input.settings });
  if (plan.missing.length > 0) {
    const noJob = plan.missing.some((line) => line.startsWith("jobId:"));
    await input.database.withTenant(input.tenantId, (db) =>
      recordSync(db, input.poId, {
        state: noJob ? "blocked" : "blocked",
        error: plan.missing.join(" "),
        payload: plan.payload,
      }),
    );
    return {
      state: noJob && plan.missing.length === 1 ? "no_job" : "blocked",
      error: plan.missing.join(" "),
      missing: plan.missing,
    };
  }
  if (!input.client) {
    return { state: "failed", error: "ServiceTitan is not configured. Nothing was sent." };
  }
  await input.database.withTenant(input.tenantId, (db) =>
    recordSync(db, input.poId, { state: "pending", error: null, payload: plan.payload }),
  );
  const existing = await input.client.findInventoryPurchaseOrderByMarker(plan.jobId!, plan.marker);
  if (existing?.id) {
    await input.database.withTenant(input.tenantId, (db) =>
      recordSync(db, input.poId, { state: "created", error: null, stPoId: existing.id, payload: plan.payload }),
    );
    return { state: "created", stPoId: existing.id };
  }
  let createdId: string;
  try {
    const created = await input.client.createInventoryPurchaseOrder(plan.payload);
    createdId = created.id;
  } catch (err) {
    const uncertain =
      err instanceof Error &&
      ((("uncertain" in err) && (err as { uncertain?: boolean }).uncertain === true) ||
        (("retryable" in err) && (err as { retryable?: boolean }).retryable === true));
    const message = err instanceof Error ? err.message : String(err);
    await input.database.withTenant(input.tenantId, (db) =>
      recordSync(db, input.poId, {
        state: uncertain ? "pending" : "failed",
        error: message,
        payload: plan.payload,
      }),
    );
    return { state: uncertain ? "pending" : "failed", error: message };
  }
  if (input.afterRemoteCreate) await input.afterRemoteCreate(createdId);
  await input.database.withTenant(input.tenantId, (db) =>
    recordSync(db, input.poId, { state: "created", error: null, stPoId: createdId, payload: plan.payload }),
  );
  return { state: "created", stPoId: createdId };
}

export async function previewStPurchaseOrder(
  db: SqlClient,
  poId: string,
  settings: StPoSyncSettings,
): Promise<{
  po_id: string;
  po_number: string;
  kind: string;
  status: string;
  st_po_id: string | null;
  st_po_sync_state: string | null;
  st_po_sync_error: string | null;
  writes_enabled: boolean;
  plan: StPoPlan;
} | null> {
  const loaded = await loadPoSyncContext(db, poId);
  if (!loaded) return null;
  return {
    po_id: loaded.poId,
    po_number: loaded.poNumber,
    kind: loaded.kind,
    status: loaded.status,
    st_po_id: loaded.stPoId,
    st_po_sync_state: loaded.syncState,
    st_po_sync_error: loaded.syncError,
    writes_enabled: settings.enabled,
    plan: buildStPurchaseOrderPlan({ ...loaded.plan, settings }),
  };
}

interface LoadedPo {
  poId: string;
  poNumber: string;
  kind: string;
  status: string;
  origin: string;
  stPoId: string | null;
  syncState: string | null;
  syncError: string | null;
  plan: Omit<StPoPlanInput, "settings">;
}

async function loadPoSyncContext(db: SqlClient, poId: string): Promise<LoadedPo | null> {
  const po = await db.query<{
    id: string;
    po_number: string;
    kind: string;
    status: string;
    scope_text: string;
    issued_at: Date | string | null;
    vendor_name: string | null;
    st_vendor_id: string | null;
    project_name: string;
    address_line1: string | null;
    city: string | null;
    region: string | null;
    postal_code: string | null;
    external_job_id: string | null;
    st_job_id: string | null;
    st_project_id: string | null;
    origin: string | null;
    st_po_id: string | null;
    st_po_sync_state: string | null;
    st_po_sync_error: string | null;
    project_id: string;
    header_code: string | null;
    header_source: string | null;
    header_external_id: string | null;
    header_amount: string;
  }>(
    `SELECT po.id, po.po_number, po.kind::text AS kind, po.status::text AS status, po.scope_text,
            po.issued_at, po.amount::text AS header_amount, po.project_id,
            po.st_job_id::text AS st_job_id, po.st_project_id::text AS st_project_id,
            po.origin, po.st_po_id, po.st_po_sync_state, po.st_po_sync_error,
            v.legal_name AS vendor_name, v.st_vendor_id,
            p.name AS project_name, p.address_line1, p.city, p.region, p.postal_code, p.external_job_id,
            cc.code AS header_code, cc.external_source AS header_source, cc.external_id AS header_external_id
       FROM projects.purchase_orders po
       JOIN projects.projects p ON p.id = po.project_id
       LEFT JOIN projects.vendors v ON v.id = po.vendor_id
       LEFT JOIN projects.cost_codes cc ON cc.id = po.cost_code_id
      WHERE po.id = $1`,
    [poId],
  );
  const row = po.rows[0];
  if (!row) return null;
  const lines = await db.query<{
    description: string;
    amount: string;
    code: string;
    external_source: string | null;
    external_id: string | null;
  }>(
    `SELECT l.description, l.current_amount::text AS amount, cc.code,
            cc.external_source, cc.external_id
       FROM projects.po_lines l
       JOIN projects.cost_codes cc ON cc.id = l.cost_code_id
      WHERE l.po_id = $1
      ORDER BY l.line_no`,
    [poId],
  );
  const jobs = await db.query<{ external_job_id: string }>(
    `SELECT external_job_id
       FROM projects.project_job_links
      WHERE project_id = $1 AND source_active
      ORDER BY external_job_id`,
    [row.project_id],
  );
  const linkedJobs = jobs.rows.map((job) => job.external_job_id).filter((id) => /^\d+$/.test(id));
  const explicitJob = numericId(row.st_job_id);
  let jobId: string | null = null;
  let jobAmbiguous = false;
  if (explicitJob) jobId = explicitJob;
  else if (linkedJobs.length === 1) jobId = linkedJobs[0]!;
  else if (linkedJobs.length > 1) jobAmbiguous = true;
  else if (numericId(row.external_job_id)) jobId = numericId(row.external_job_id);
  const connection = await db.query<{ external_project_id: string }>(
    `SELECT external_project_id FROM projects.st_project_connections WHERE project_id = $1`,
    [row.project_id],
  );
  const stProjectId =
    numericId(row.st_project_id) ??
    (connection.rows.length === 1 ? numericId(connection.rows[0]?.external_project_id) : null);
  const planLines: StPoLineInput[] =
    lines.rows.length > 0
      ? lines.rows.map((line) => ({
          description: line.description,
          amount: Number(line.amount),
          code: line.code,
          externalSource: line.external_source,
          externalId: line.external_id,
        }))
      : [
          {
            description: row.scope_text,
            amount: Number(row.header_amount),
            code: row.header_code ?? "",
            externalSource: row.header_source,
            externalId: row.header_external_id,
          },
        ];
  return {
    poId: row.id,
    poNumber: row.po_number,
    kind: row.kind,
    status: row.status,
    origin: row.origin ?? "journeyman",
    stPoId: row.st_po_id,
    syncState: row.st_po_sync_state,
    syncError: row.st_po_sync_error,
    plan: {
      poId: row.id,
      poNumber: row.po_number,
      kind: row.kind,
      scope: row.scope_text,
      issuedOn: isoDate(row.issued_at),
      vendorName: row.vendor_name,
      stVendorId: row.st_vendor_id,
      projectName: row.project_name,
      street: row.address_line1,
      city: row.city,
      region: row.region,
      postalCode: row.postal_code,
      jobId,
      jobAmbiguous,
      stProjectId,
      lines: planLines,
    },
  };
}

async function recordSync(
  db: SqlClient,
  poId: string,
  patch: { state: string; error: string | null; payload: Record<string, unknown>; stPoId?: string },
): Promise<void> {
  await db.query(
    `UPDATE projects.purchase_orders
        SET st_po_sync_state = $2,
            st_po_sync_error = $3,
            st_po_payload = $4::jsonb,
            st_po_id = COALESCE($5, st_po_id)
      WHERE id = $1
        AND (st_po_id IS NULL OR $5::text IS NULL OR st_po_id = $5)`,
    [poId, patch.state, patch.error, JSON.stringify(patch.payload), patch.stPoId ?? null],
  );
}

function numericId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function isoDate(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

/**
 * Nightly inbound link. Uses purchase orders already read from ServiceTitan.
 * Does not call ServiceTitan. A memo of jp-po:{id} updates that Journeyman
 * purchase order. Anything else becomes one material purchase order that
 * stores the ServiceTitan id, so the same total is not entered twice.
 */
export async function linkUnlinkedServiceTitanPurchaseOrders(
  db: SqlClient,
  input: {
    tenantId: string;
    projectId: string;
    orders: ReadonlyArray<{ id: string; externalJobId: string; total: number; memo?: string | null }>;
  },
): Promise<{ linked: number; created: number }> {
  let linked = 0;
  let created = 0;
  for (const order of input.orders) {
    if (!/^\d+$/.test(order.id)) continue;
    const taken = await db.query<{ id: string }>(
      `SELECT id FROM projects.purchase_orders WHERE tenant_id = $1 AND st_po_id = $2`,
      [input.tenantId, order.id],
    );
    if (taken.rows[0]) continue;
    const marker = order.memo?.match(/jp-po:([0-9a-f-]{36})/i)?.[1] ?? null;
    if (marker) {
      const updated = await db.query(
        `UPDATE projects.purchase_orders
            SET st_po_id = $2, st_po_sync_state = 'created', st_po_sync_error = NULL
          WHERE id = $1 AND project_id = $3 AND st_po_id IS NULL`,
        [marker, order.id, input.projectId],
      );
      if ((updated.rowCount ?? 0) > 0) {
        linked += 1;
        continue;
      }
    }
    const code = await db.query<{ id: string }>(
      `SELECT id FROM projects.cost_codes
        WHERE tenant_id = $1 AND active AND default_cost_type = 'M'
        ORDER BY code
        LIMIT 1`,
      [input.tenantId],
    );
    const costCodeId = code.rows[0]?.id;
    if (!costCodeId) continue;
    const poNumber = `ST-${order.id}`.slice(0, 64);
    const inserted = await db.query(
      `INSERT INTO projects.purchase_orders
         (tenant_id, project_id, po_number, supplier_name, cost_code_id, cost_type,
          amount, scope_text, status, issued_at, kind, origin, st_po_id, st_po_sync_state)
       VALUES ($1,$2,$3,'ServiceTitan',$4,'M',$5,$6,'issued', now(), 'material',
               'servicetitan', $7, 'created')
       ON CONFLICT (tenant_id, po_number) DO NOTHING`,
      [
        input.tenantId,
        input.projectId,
        poNumber,
        costCodeId,
        roundMoney(order.total),
        `Linked from ServiceTitan purchase order ${order.id}. The cost code is the first active material code so the row can be stored. ServiceTitan did not send a Journeyman cost code. This row is not an extra commitment.`,
        order.id,
      ],
    );
    if ((inserted.rowCount ?? 0) > 0) created += 1;
  }
  return { linked, created };
}
