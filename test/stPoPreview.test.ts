import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceTitanReadAdapter } from "../src/adapters/serviceTitan.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import { stPoPreviewMarkup } from "../client/stPoSync.js";
import {
  clearStPoLookupCache,
  loadStPoCatalog,
  ST_PO_SKU_NOTE,
  type StPoCatalogClient,
} from "../src/domain/stPoLookups.js";
import {
  createTenant,
  projectBody,
  SCHEMA_FILES,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const base = "/api/v1/projects";

describe("ServiceTitan purchase order preview dropdowns", () => {
  let h: Harness;
  let t: TenantFixture;
  const calls: string[] = [];
  const catalog: StPoCatalogClient = {
    async listPoVendors() {
      calls.push("listPoVendors");
      return [
        { id: "77", name: "Cabinet Co" },
        { id: "78", name: "Other Supply" },
      ];
    },
    async listPoTypes() {
      calls.push("listPoTypes");
      return [{ id: "11", name: "Special order" }];
    },
    async listBusinessUnits() {
      calls.push("listBusinessUnits");
      return [
        { id: "33", name: "Install" },
        { id: "34", name: "Service" },
      ];
    },
    async listInventoryLocations() {
      calls.push("listInventoryLocations");
      return [{ id: "22", name: "Warehouse · Main" }];
    },
    async listPoSkus() {
      calls.push("listPoSkus");
      return [
        { id: "555", name: "Cabinet box", code: "CAB", nonInventory: false },
        { id: "556", name: "Miscellaneous", code: "MISC", nonInventory: true },
      ];
    },
    async readPoJob(jobId: string) {
      calls.push(`readPoJob:${jobId}`);
      return { id: jobId, jobNumber: "92493149", summary: "Blanton kitchen", businessUnitId: "33" };
    },
  };
  const creates: Array<Record<string, unknown>> = [];
  const sources = {
    serviceTitan: {
      tenantId: "00000000-0000-4000-8000-000000000001",
      externalSystemId: "00000000-0000-4000-8000-000000000002",
      key: "st:preview",
      client: {
        async readJob() {
          throw new Error("readJob should not run");
        },
        ...catalog,
        async createInventoryPurchaseOrder(body: Record<string, unknown>) {
          calls.push("create");
          creates.push(body);
          return { id: "9001" };
        },
        async findInventoryPurchaseOrderByMarker() {
          calls.push("find");
          return null;
        },
      },
    },
  } as SourceConnections;

  beforeAll(async () => {
    clearStPoLookupCache();
    h = await startHarness(SCHEMA_FILES, sources);
    t = await createTenant(h, { slug: "po-preview" });
    sources.serviceTitan!.tenantId = t.id;
  });

  afterAll(async () => {
    delete process.env.PM_ST_PO_SYNC_ENABLED;
    delete process.env.PM_ST_PO_TYPE_ID;
    delete process.env.PM_ST_BUSINESS_UNIT_ID;
    delete process.env.PM_ST_INVENTORY_LOCATION_ID;
    clearStPoLookupCache();
    await h?.close();
  });

  const owner = () => h.as(t.staff.owner!.token);
  const manager = () => h.as(t.staff.manager!.token);
  const pm = () => h.as(t.staff.pm!.token);

  async function materialCode() {
    const listed = await owner().get(`${base}/cost-codes`);
    const material = (listed.body.data as Array<{ id: string; code: string; default_cost_type: string }>).find(
      (row) => row.default_cost_type === "M",
    );
    const sub = (listed.body.data as Array<{ id: string; code: string; default_cost_type: string }>).find(
      (row) => row.default_cost_type === "S",
    );
    expect(material && sub).toBeTruthy();
    return { material: material!, sub: sub! };
  }

  async function project(number: string, name = "Blanton") {
    const created = await owner().post(`${base}/projects`).send(
      projectBody({ project_number: number, name }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.data.id as string;
  }

  async function systemId() {
    const existing = await h.db.withTenant(t.id, (db) =>
      db.query<{ id: string }>(
        `SELECT id FROM projects.external_systems WHERE adapter_key = 'servicetitan' LIMIT 1`,
      ),
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const created = await h.db.withTenant(t.id, (db) =>
      db.query<{ id: string }>(
        `INSERT INTO projects.external_systems (tenant_id, adapter_key, display_name)
         VALUES ($1, 'servicetitan', 'ServiceTitan') RETURNING id`,
        [t.id],
      ),
    );
    return created.rows[0]!.id;
  }

  async function linkJob(
    projectId: string,
    jobId: string,
    number: string,
    summary: string,
  ) {
    const system = await systemId();
    await h.db.withTenant(t.id, (db) =>
      db.query(
        `INSERT INTO projects.project_job_links
           (tenant_id, project_id, external_system_id, external_job_id, title, source_active, source_job_number, source_summary)
         VALUES ($1,$2,$3,$4,$5,true,$6,$7)`,
        [t.id, projectId, system, jobId, summary, number, summary],
      ),
    );
  }

  it("is registered after the plan-appointment migration", () => {
    expect(SCHEMA_FILES.some((file) => file.endsWith("060_st_po_preview_defaults.sql"))).toBe(true);
  });

  it("fills missing required fields from read-only lookups and does not write", async () => {
    calls.length = 0;
    creates.length = 0;
    clearStPoLookupCache();
    const projectId = await project("SO-BLANTON");
    await linkJob(projectId, "260260", "92493149", "Blanton kitchen");
    await linkJob(projectId, "260261", "92493150", "Blanton bath");
    const { material } = await materialCode();
    const vendor = await owner().post(`${base}/vendors`).send({ legal_name: "Cabinet Co", email: "cab@preview.test" });
    expect(vendor.status).toBe(201);
    const created = await owner().post(`${base}/projects/${projectId}/purchase-orders`).send({
      po_number: "SO92493149",
      vendor_id: vendor.body.data.id,
      cost_code_id: material.id,
      cost_type: "M",
      amount: 26080.88,
      scope_text: "Cabinet",
      kind: "material",
      issue: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const poId = created.body.data.id as string;
    const before = await h.db.withTenant(t.id, (db) =>
      db.query<{ st_vendor_id: string | null; st_po_id: string | null }>(
        `SELECT v.st_vendor_id, po.st_po_id
           FROM projects.purchase_orders po
           LEFT JOIN projects.vendors v ON v.id = po.vendor_id
          WHERE po.id = $1`,
        [poId],
      ),
    );
    calls.length = 0;
    const preview = await pm().get(`${base}/purchase-orders/${poId}/service-titan-sync`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const data = preview.body.data;
    expect(data.writes_enabled).toBe(false);
    expect(data.sku_required).toBe(true);
    expect(data.generic_item).toBeNull();
    expect(data.sku_note).toBe(ST_PO_SKU_NOTE);
    const vendorField = data.fields.find((field: { key: string }) => field.key === "vendorId");
    expect(vendorField.suggested).toBe("77");
    expect(vendorField.options.map((option: { label: string }) => option.label)).toEqual(["Cabinet Co", "Other Supply"]);
    expect(data.fields.map((field: { key: string }) => field.key)).toEqual(
      expect.arrayContaining(["vendorId", "typeId", "businessUnitId", "inventoryLocationId", "jobId"]),
    );
    const job = data.fields.find((field: { key: string }) => field.key === "jobId");
    expect(job.options.map((option: { label: string }) => option.label)).toEqual([
      "92493149 — Blanton kitchen",
      "92493150 — Blanton bath",
    ]);
    expect(job.suggested).toBeNull();
    const line = data.lines[0];
    expect(line.needs_sku).toBe(true);
    expect(line.options.some((option: { label: string }) => option.label.startsWith("Non-inventory"))).toBe(true);
    expect(calls).not.toContain("create");
    expect(calls).not.toContain("find");
    const after = await h.db.withTenant(t.id, (db) =>
      db.query<{ st_vendor_id: string | null; st_po_id: string | null }>(
        `SELECT v.st_vendor_id, po.st_po_id
           FROM projects.purchase_orders po
           LEFT JOIN projects.vendors v ON v.id = po.vendor_id
          WHERE po.id = $1`,
        [poId],
      ),
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(creates).toHaveLength(0);
  });

  it("saves the vendor on the vendor row so the next purchase order is filled", async () => {
    const projectId = await project("SO-VENDOR");
    const { material } = await materialCode();
    const vendor = await owner().post(`${base}/vendors`).send({ legal_name: "Cabinet Co", email: "cab2@preview.test" });
    const first = await pm().post(`${base}/projects/${projectId}/purchase-orders`).send({
      po_number: "SO-VENDOR-1",
      vendor_id: vendor.body.data.id,
      cost_code_id: material.id,
      cost_type: "M",
      amount: 10,
      scope_text: "Cabinet",
      kind: "material",
      issue: true,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const saved = await pm().put(`${base}/purchase-orders/${first.body.data.id}/service-titan-choices`).send({
      vendor_id: "77",
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const stored = await h.db.withTenant(t.id, (db) =>
      db.query<{ st_vendor_id: string }>(`SELECT st_vendor_id FROM projects.vendors WHERE id = $1`, [
        vendor.body.data.id,
      ]),
    );
    expect(stored.rows[0]?.st_vendor_id).toBe("77");
    const second = await pm().post(`${base}/projects/${projectId}/purchase-orders`).send({
      po_number: "SO-VENDOR-2",
      vendor_id: vendor.body.data.id,
      cost_code_id: material.id,
      cost_type: "M",
      amount: 12,
      scope_text: "Cabinet",
      kind: "material",
      issue: true,
    });
    const preview = await pm().get(`${base}/purchase-orders/${second.body.data.id}/service-titan-sync`);
    expect(preview.status).toBe(200);
    expect(preview.body.data.fields.some((field: { key: string }) => field.key === "vendorId")).toBe(false);
    expect(preview.body.data.plan.payload.vendorId).toBe(77);
    expect(creates).toHaveLength(0);
  });

  it("stores company defaults for an owner or manager and keeps sending off unless the owner turns it on", async () => {
    process.env.PM_ST_PO_SYNC_ENABLED = "true";
    process.env.PM_ST_PO_TYPE_ID = "99";
    const initial = await owner().get(`${base}/settings/service-titan-purchase-orders`);
    expect(initial.status).toBe(200);
    expect(initial.body.data.enabled).toBe(false);
    expect(initial.body.data.can_toggle).toBe(true);
    expect(initial.body.data.purchase_order_type_id).toBeNull();
    const pmDenied = await pm().get(`${base}/settings/service-titan-purchase-orders`);
    expect(pmDenied.status).toBe(403);
    const managerToggle = await manager().patch(`${base}/settings/service-titan-purchase-orders`).send({ enabled: true });
    expect(managerToggle.status).toBe(403);
    const managerDefaults = await manager().patch(`${base}/settings/service-titan-purchase-orders`).send({
      purchase_order_type_id: "11",
      business_unit_id: "33",
      inventory_location_id: "22",
    });
    expect(managerDefaults.status, JSON.stringify(managerDefaults.body)).toBe(200);
    expect(managerDefaults.body.data).toMatchObject({
      enabled: false,
      can_toggle: false,
      purchase_order_type_id: "11",
      business_unit_id: "33",
      inventory_location_id: "22",
    });
    const stillOff = await owner().get(`${base}/settings/service-titan-purchase-orders`);
    expect(stillOff.body.data.enabled).toBe(false);
    const ownerOn = await owner().patch(`${base}/settings/service-titan-purchase-orders`).send({ enabled: true });
    expect(ownerOn.status).toBe(200);
    expect(ownerOn.body.data.enabled).toBe(true);
    await owner().patch(`${base}/settings/service-titan-purchase-orders`).send({ enabled: false });
    delete process.env.PM_ST_PO_SYNC_ENABLED;
    delete process.env.PM_ST_PO_TYPE_ID;
  });

  it("copies numeric environment ids once and does not copy the send flag", async () => {
    await h.db.asOwner(async (db) => {
      await db.query(`SELECT set_config('pm.st_po_type_id', '41', false)`);
      await db.query(`SELECT set_config('pm.st_po_business_unit_id', '42', false)`);
      await db.query(`SELECT set_config('pm.st_po_inventory_location_id', '43', false)`);
      await db.query(
        `UPDATE projects.tenant_settings
            SET st_po_defaults_seeded = false,
                st_po_type_id = NULL,
                st_po_business_unit_id = NULL,
                st_po_inventory_location_id = NULL,
                st_po_sync_enabled = false
          WHERE tenant_id = $1`,
        [t.id],
      );
      await db.query(`SELECT projects.seed_st_po_defaults_from_env()`);
    });
    const seeded = await h.db.withTenant(t.id, (db) =>
      db.query<{
        st_po_type_id: string;
        st_po_business_unit_id: string;
        st_po_inventory_location_id: string;
        st_po_sync_enabled: boolean;
        st_po_defaults_seeded: boolean;
      }>(
        `SELECT st_po_type_id, st_po_business_unit_id, st_po_inventory_location_id, st_po_sync_enabled, st_po_defaults_seeded
           FROM projects.tenant_settings WHERE tenant_id = $1`,
        [t.id],
      ),
    );
    expect(seeded.rows[0]).toMatchObject({
      st_po_type_id: "41",
      st_po_business_unit_id: "42",
      st_po_inventory_location_id: "43",
      st_po_sync_enabled: false,
      st_po_defaults_seeded: true,
    });
    await h.db.asOwner(async (db) => {
      await db.query(`SELECT set_config('pm.st_po_type_id', '99', false)`);
      await db.query(`SELECT projects.seed_st_po_defaults_from_env()`);
    });
    const again = await h.db.withTenant(t.id, (db) =>
      db.query<{ st_po_type_id: string }>(`SELECT st_po_type_id FROM projects.tenant_settings WHERE tenant_id = $1`, [t.id]),
    );
    expect(again.rows[0]?.st_po_type_id).toBe("41");
    await manager().patch(`${base}/settings/service-titan-purchase-orders`).send({
      purchase_order_type_id: "11",
      business_unit_id: "33",
      inventory_location_id: "22",
    });
  });

  it("suggests the linked job's business unit and builds the payload after the choices are saved", async () => {
    clearStPoLookupCache();
    const projectId = await project("SO-ONE-JOB");
    await linkJob(projectId, "260270", "92493149", "Blanton kitchen");
    const { material } = await materialCode();
    const vendor = await owner().post(`${base}/vendors`).send({ legal_name: "Mapped Co", email: "mapped@preview.test" });
    await h.db.withTenant(t.id, (db) =>
      db.query(
        `UPDATE projects.vendors SET st_vendor_id = NULL WHERE tenant_id = $1 AND st_vendor_id = '77' AND id <> $2`,
        [t.id, vendor.body.data.id],
      ),
    );
    await h.db.withTenant(t.id, (db) =>
      db.query(`UPDATE projects.vendors SET st_vendor_id = '77' WHERE id = $1`, [vendor.body.data.id]),
    );
    await manager().patch(`${base}/settings/service-titan-purchase-orders`).send({
      purchase_order_type_id: null,
      business_unit_id: null,
      inventory_location_id: "22",
    });
    const created = await pm().post(`${base}/projects/${projectId}/purchase-orders`).send({
      po_number: "SO-ONE",
      vendor_id: vendor.body.data.id,
      cost_code_id: material.id,
      cost_type: "M",
      amount: 80,
      scope_text: "Cabinet",
      kind: "material",
      issue: true,
    });
    const poId = created.body.data.id as string;
    const preview = await pm().get(`${base}/purchase-orders/${poId}/service-titan-sync`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const bu = preview.body.data.fields.find((field: { key: string }) => field.key === "businessUnitId");
    expect(bu.suggested).toBe("33");
    expect(preview.body.data.fields.some((field: { key: string }) => field.key === "inventoryLocationId")).toBe(false);
    expect(preview.body.data.plan.payload.inventoryLocationId).toBe(22);
    const lines = await owner().get(`${base}/purchase-orders/${poId}/lines`);
    const lineId = lines.body.data[0].id as string;
    const saved = await pm().put(`${base}/purchase-orders/${poId}/service-titan-choices`).send({
      type_id: "11",
      business_unit_id: "33",
      job_id: "260270",
      lines: [{ line_id: lineId, sku_id: "555" }],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const ready = await pm().get(`${base}/purchase-orders/${poId}/service-titan-sync`);
    expect(ready.body.data.plan.missing).toEqual([]);
    expect(ready.body.data.plan.payload).toMatchObject({
      vendorId: 77,
      typeId: 11,
      businessUnitId: 33,
      inventoryLocationId: 22,
      jobId: 260270,
      items: [{ skuId: 555, description: "Cabinet", quantity: 1, cost: 80 }],
    });
    expect(ready.body.data.writes_enabled).toBe(false);
    const markup = stPoPreviewMarkup(ready.body.data);
    expect(markup).toContain("Apply / Send to ServiceTitan");
    expect(markup).toContain("disabled");
    expect(markup).toContain("Cabinet");
    const ownerOn = await owner().patch(`${base}/settings/service-titan-purchase-orders`).send({ enabled: true });
    expect(ownerOn.body.data.enabled).toBe(true);
    const armed = await pm().get(`${base}/purchase-orders/${poId}/service-titan-sync`);
    const armedMarkup = stPoPreviewMarkup(armed.body.data);
    expect(armedMarkup).toContain("Apply / Send to ServiceTitan");
    expect(armedMarkup).not.toContain('id="st-po-confirm" disabled');
    calls.length = 0;
    creates.length = 0;
    const sent = await pm().post(`${base}/purchase-orders/${poId}/service-titan-sync`).send({ confirm: true });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.data.state).toBe("created");
    expect(creates).toHaveLength(1);
    const bookkeeper = await h.as(t.staff.bookkeeper!.token).post(`${base}/purchase-orders/${poId}/service-titan-sync`).send({ confirm: true });
    expect(bookkeeper.status).toBe(403);
    const estimator = await h.as(t.staff.estimator!.token).get(`${base}/purchase-orders/${poId}/service-titan-sync`);
    expect(estimator.status).toBe(403);
    await owner().patch(`${base}/settings/service-titan-purchase-orders`).send({ enabled: false });
  });

  it("does not call ServiceTitan from create, material bill post, update, or bill approve", async () => {
    await owner().patch(`${base}/settings/service-titan-purchase-orders`).send({
      enabled: true,
      purchase_order_type_id: "11",
      business_unit_id: "33",
      inventory_location_id: "22",
    });
    process.env.PM_ST_PO_SYNC_ENABLED = "true";
    const projectId = await project("SO-QUIET");
    await linkJob(projectId, "260280", "92493149", "Blanton kitchen");
    const { material, sub } = await materialCode();
    await h.db.withTenant(t.id, (db) =>
      db.query(
        `UPDATE projects.cost_codes
            SET external_source = 'servicetitan_inventory_sku', external_id = '555'
          WHERE id = $1 OR id = $2`,
        [material.id, sub.id],
      ),
    );
    const vendor = await owner().post(`${base}/vendors`).send({ legal_name: "Quiet Co", email: "quiet@preview.test" });
    await h.db.withTenant(t.id, (db) =>
      db.query(
        `UPDATE projects.vendors SET st_vendor_id = NULL WHERE tenant_id = $1 AND st_vendor_id = '77' AND id <> $2`,
        [t.id, vendor.body.data.id],
      ),
    );
    await h.db.withTenant(t.id, (db) =>
      db.query(`UPDATE projects.vendors SET st_vendor_id = '77' WHERE id = $1`, [vendor.body.data.id]),
    );
    calls.length = 0;
    creates.length = 0;
    const issued = await pm().post(`${base}/projects/${projectId}/purchase-orders`).send({
      po_number: "SO-QUIET-1",
      vendor_id: vendor.body.data.id,
      cost_code_id: material.id,
      cost_type: "M",
      amount: 40,
      scope_text: "Cabinet",
      kind: "material",
      issue: true,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const draft = await pm().post(`${base}/projects/${projectId}/purchase-orders`).send({
      po_number: "SO-QUIET-2",
      vendor_id: vendor.body.data.id,
      cost_code_id: material.id,
      cost_type: "M",
      amount: 15,
      scope_text: "Cabinet",
      kind: "material",
      issue: false,
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const updated = await pm().patch(`${base}/purchase-orders/${draft.body.data.id}`).send({ status: "issued" });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const materialBill = await pm().post(`${base}/projects/${projectId}/material-bills`).send({
      vendor_id: vendor.body.data.id,
      cost_code_id: material.id,
      amount: 26080.88,
      order_number: "HD-1001",
      invoice_date: "2026-10-01",
      description: "Cabinet pulls",
    });
    expect(materialBill.status, JSON.stringify(materialBill.body)).toBe(201);
    expect(materialBill.body.data).toMatchObject({
      status: "received",
      po_kind: "material",
      vendor_invoice_number: "HD-1001",
      vendor: "Quiet Co",
      amount: 26080.88,
      card_charge_state: "awaiting_card_charge",
      cost_code_id: material.id,
    });
    const kinds = await owner().get(`${base}/compliance-requirements`);
    for (const req of kinds.body.data as Array<{ kind: string; required: boolean }>) {
      if (!req.required) continue;
      const doc = await owner().post(`${base}/vendors/${vendor.body.data.id}/documents`).send({
        kind: req.kind,
        expires_on: "2027-12-31",
        file_key: `quiet/${req.kind}`,
      });
      expect(doc.status, JSON.stringify(doc.body)).toBe(201);
    }
    const subPo = await owner().post(`${base}/projects/${projectId}/purchase-orders`).send({
      po_number: "SO-QUIET-SUB",
      vendor_id: vendor.body.data.id,
      cost_code_id: sub.id,
      cost_type: "S",
      amount: 90,
      scope_text: "Install",
      kind: "subcontract",
      issue: true,
    });
    expect(subPo.status, JSON.stringify(subPo.body)).toBe(201);
    const bill = await owner().post(`${base}/purchase-orders/${subPo.body.data.id}/bills`).send({
      vendor_invoice_number: "SUB-1",
      amount: 90,
      invoice_date: "2026-10-02",
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    const approved = await owner().post(`${base}/bills/${bill.body.data.id}/approve`).send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe("approved");
    expect(calls).toEqual([]);
    expect(creates).toHaveLength(0);
    const quiet = await h.db.withTenant(t.id, (db) =>
      db.query<{ st_po_id: string | null; st_po_sync_state: string }>(
        `SELECT st_po_id, st_po_sync_state FROM projects.purchase_orders WHERE po_number = 'SO-QUIET-1'`,
      ),
    );
    expect(quiet.rows[0]?.st_po_id).toBeNull();
    expect(quiet.rows[0]?.st_po_sync_state).toBe("ready");
    await owner().patch(`${base}/settings/service-titan-purchase-orders`).send({ enabled: false });
    delete process.env.PM_ST_PO_SYNC_ENABLED;
  });

  it("caches lookup lists and the adapter uses GET for them", async () => {
    clearStPoLookupCache();
    let reads = 0;
    const counting: StPoCatalogClient = {
      async listPoVendors() {
        reads += 1;
        return [{ id: "1", name: "A" }];
      },
      async listPoTypes() {
        return [];
      },
      async listBusinessUnits() {
        return [];
      },
      async listInventoryLocations() {
        return [];
      },
      async listPoSkus() {
        return [];
      },
      async readPoJob() {
        return null;
      },
    };
    await loadStPoCatalog("cache-test", counting);
    await loadStPoCatalog("cache-test", counting);
    expect(reads).toBe(1);
    clearStPoLookupCache();

    const seen: Array<{ method: string; url: string }> = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      seen.push({ method, url: String(url) });
      if (String(url).includes("/connect/token")) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 900 }), { status: 200 });
      }
      if (method !== "GET") throw new Error(`ServiceTitan write ${method} ${url}`);
      const page = { data: [] as unknown[], hasMore: false };
      if (String(url).includes("/vendors")) page.data = [{ id: 7, name: "Cabinet Co", active: true }];
      if (String(url).includes("/purchase-order-types")) page.data = [{ id: 11, name: "Special order", active: true }];
      if (String(url).includes("/business-units")) page.data = [{ id: 33, name: "Install", active: true }];
      if (String(url).includes("/warehouses")) page.data = [{ id: 22, name: "Main", active: true }];
      if (String(url).includes("/trucks")) page.data = [{ id: 23, name: "Truck 1", active: true }];
      if (String(url).includes("/materials")) {
        page.data = [{ id: 555, displayName: "Cabinet box", code: "CAB", active: true, isInventory: true }];
      }
      if (String(url).includes("/equipment")) {
        page.data = [{ id: 556, displayName: "Miscellaneous", code: "MISC", active: true, isInventory: false }];
      }
      if (String(url).includes("/jobs/260260")) {
        return new Response(
          JSON.stringify({ id: 260260, jobNumber: "92493149", summary: "Blanton kitchen", businessUnitId: 33 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(page), { status: 200 });
    };
    const adapter = new ServiceTitanReadAdapter(
      {
        environment: "integration",
        tenantId: "10",
        clientId: "client",
        clientSecret: "secret",
        appKey: "app",
      },
      fetcher as typeof fetch,
      async () => {},
    );
    expect(await adapter.listPoVendors()).toEqual([{ id: "7", name: "Cabinet Co" }]);
    expect(await adapter.listPoTypes()).toEqual([{ id: "11", name: "Special order" }]);
    expect(await adapter.listBusinessUnits()).toEqual([{ id: "33", name: "Install" }]);
    expect(await adapter.listInventoryLocations()).toEqual([
      { id: "22", name: "Warehouse · Main" },
      { id: "23", name: "Truck · Truck 1" },
    ]);
    const skus = await adapter.listPoSkus();
    expect(skus).toEqual([
      { id: "555", name: "Cabinet box", code: "CAB", nonInventory: false },
      { id: "556", name: "Miscellaneous", code: "MISC", nonInventory: true },
    ]);
    expect(await adapter.readPoJob("260260")).toMatchObject({ businessUnitId: "33", jobNumber: "92493149" });
    expect(seen.filter((call) => !call.url.includes("/connect/token")).every((call) => call.method === "GET")).toBe(true);
    expect(seen.some((call) => call.method === "POST" && call.url.includes("/purchase-orders"))).toBe(false);
  });
});
