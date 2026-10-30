import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceTitanReadAdapter, ServiceTitanStatusWriteError } from "../src/adapters/serviceTitan.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import { hasExecutableSql, splitSqlStatements } from "../src/db/splitSql.js";
import {
  buildStPurchaseOrderPlan,
  linkUnlinkedServiceTitanPurchaseOrders,
  stPoEnvSeedSql,
  stPoMarker,
  syncIssuedPurchaseOrder,
  type StInventoryPurchaseOrderClient,
} from "../src/domain/stPurchaseOrderSync.js";
import { refreshLinkedProject } from "../src/workers/laborRefresh.js";
import {
  createTenant,
  projectBody,
  SCHEMA_FILES,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const base = "/api/v1/projects";

describe("vendor bill cost and ServiceTitan purchase order sync", () => {
  let h: Harness;
  let t: TenantFixture;
  const creates: Array<Record<string, unknown>> = [];
  const finds: string[] = [];
  let remote: { id: string; memo: string } | null = null;
  let nextStId = 9001;
  const client: StInventoryPurchaseOrderClient = {
    async createInventoryPurchaseOrder(body) {
      creates.push(body);
      const id = String(nextStId);
      nextStId += 1;
      remote = { id, memo: String(body.memo ?? "") };
      return { id };
    },
    async findInventoryPurchaseOrderByMarker(_jobId, marker) {
      finds.push(marker);
      if (remote && remote.memo.includes(marker)) return { id: remote.id };
      return null;
    },
  };
  const sources = {
    serviceTitan: {
      tenantId: "00000000-0000-4000-8000-000000000001",
      externalSystemId: "00000000-0000-4000-8000-000000000002",
      key: "st:integration:1",
      client: {
        readJob: async () => {
          throw new Error("readJob should not run");
        },
        createInventoryPurchaseOrder: (body: Record<string, unknown>) => client.createInventoryPurchaseOrder(body),
        findInventoryPurchaseOrderByMarker: (jobId: string, marker: string) =>
          client.findInventoryPurchaseOrderByMarker(jobId, marker),
      },
    },
  } as SourceConnections;

  beforeAll(async () => {
    h = await startHarness(SCHEMA_FILES, sources);
    t = await createTenant(h, { slug: "bill-po-sync" });
    sources.serviceTitan!.tenantId = t.id;
  });

  afterAll(async () => {
    delete process.env.PM_ST_PO_SYNC_ENABLED;
    delete process.env.PM_ST_PO_TYPE_ID;
    delete process.env.PM_ST_INVENTORY_LOCATION_ID;
    delete process.env.PM_ST_BUSINESS_UNIT_ID;
    await h?.close();
  });

  const owner = () => h.as(t.staff.owner!.token);

  async function project(number: string) {
    const created = await owner().post(`${base}/projects`).send(
      projectBody({ project_number: number, name: `Bill sync ${number}` }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.data.id as string;
  }

  async function codes() {
    const listed = await owner().get(`${base}/cost-codes`);
    expect(listed.status).toBe(200);
    const material = (listed.body.data as Array<{ id: string; code: string; default_cost_type: string }>).find(
      (row) => row.default_cost_type === "M",
    );
    const sub = (listed.body.data as Array<{ id: string; code: string; default_cost_type: string }>).find(
      (row) => row.default_cost_type === "S",
    );
    expect(material && sub).toBeTruthy();
    return { material: material!, sub: sub! };
  }

  it("counts approved, paid, and received material bills, skips rejected, prefers bill lines, and keeps unbudgeted bills", async () => {
    const projectId = await project("BILL-VIEW");
    const { material, sub } = await codes();
    await h.db.withTenant(t.id, async (db) => {
      const vendor = await db.query<{ id: string }>(
        `INSERT INTO projects.vendors (tenant_id, legal_name, email, active)
         VALUES ($1, 'Cabinet Co', 'cab@bill.test', true) RETURNING id`,
        [t.id],
      );
      const vendorId = vendor.rows[0]!.id;
      async function po(number: string, kind: "material" | "subcontract", codeId: string, type: "M" | "S", amount: number) {
        const row = await db.query<{ id: string }>(
          `INSERT INTO projects.purchase_orders
             (tenant_id, project_id, po_number, vendor_id, cost_code_id, cost_type, amount, scope_text, status, kind)
           VALUES ($1,$2,$3,$4,$5,$6::projects.cost_type,$7,'scope','issued',$8::projects.po_kind)
           RETURNING id`,
          [t.id, projectId, number, vendorId, codeId, type, amount, kind],
        );
        const line = await db.query<{ id: string }>(
          `INSERT INTO projects.po_lines
             (tenant_id, po_id, line_no, cost_code_id, cost_type, description, original_amount)
           VALUES ($1,$2,1,$3,$4::projects.cost_type,'line',$5) RETURNING id`,
          [t.id, row.rows[0]!.id, codeId, type, amount],
        );
        return { poId: row.rows[0]!.id, lineId: line.rows[0]!.id };
      }
      async function bill(
        poId: string,
        number: string,
        status: string,
        amount: number,
        lineId?: string,
        lineAmount?: number,
      ) {
        const row = await db.query<{ id: string }>(
          `INSERT INTO projects.vendor_bills
             (tenant_id, po_id, vendor_invoice_number, amount, status)
           VALUES ($1,$2,$3,$4,$5::projects.bill_status) RETURNING id`,
          [t.id, poId, number, amount, status],
        );
        if (lineId) {
          await db.query(
            `INSERT INTO projects.bill_lines (tenant_id, bill_id, po_line_id, gross_amount)
             VALUES ($1,$2,$3,$4)`,
            [t.id, row.rows[0]!.id, lineId, lineAmount ?? amount],
          );
        }
      }
      const approved = await po("PO-APP", "material", material.id, "M", 100);
      await bill(approved.poId, "APP", "approved", 999, approved.lineId, 40);
      const paid = await po("PO-PAID", "subcontract", sub.id, "S", 80);
      await bill(paid.poId, "PAID", "paid", 80);
      const receivedMat = await po("PO-REC-M", "material", material.id, "M", 15);
      await bill(receivedMat.poId, "REC-M", "received", 15);
      const receivedSub = await po("PO-REC-S", "subcontract", sub.id, "S", 70);
      await bill(receivedSub.poId, "REC-S", "received", 70);
      const rejected = await po("PO-REJ", "material", material.id, "M", 50);
      await bill(rejected.poId, "REJ", "rejected", 50);
      const openCode = sub;
      const unbudgeted = await po("PO-OPEN", "material", openCode.id, "M", 26080.88);
      await db.query(
        `UPDATE projects.purchase_orders SET cost_type = 'M', cost_code_id = $2 WHERE id = $1`,
        [unbudgeted.poId, openCode.id],
      );
      await bill(unbudgeted.poId, "OPEN", "approved", 26080.88);

      const view = await db.query<{ kind: string; amount: string }>(
        `SELECT kind::text AS kind, SUM(amount)::text AS amount
           FROM projects.v_project_bill_cost WHERE project_id = $1 GROUP BY kind ORDER BY kind`,
        [projectId],
      );
      const byKind = Object.fromEntries(view.rows.map((row) => [row.kind, Number(row.amount)]));
      expect(byKind.material).toBeCloseTo(40 + 15 + 26080.88, 2);
      expect(byKind.subcontract).toBe(80);
      const rejectedRow = await db.query(
        `SELECT 1 FROM projects.v_project_bill_cost c
           JOIN projects.vendor_bills b ON b.id = c.bill_id
          WHERE b.vendor_invoice_number = 'REJ'`,
      );
      expect(rejectedRow.rows).toHaveLength(0);
      const receivedSubRow = await db.query(
        `SELECT 1 FROM projects.v_project_bill_cost c
           JOIN projects.vendor_bills b ON b.id = c.bill_id
          WHERE b.vendor_invoice_number = 'REC-S'`,
      );
      expect(receivedSubRow.rows).toHaveLength(0);
      const lined = await db.query<{ amount: string }>(
        `SELECT SUM(c.amount)::text AS amount
           FROM projects.v_project_bill_cost c
           JOIN projects.vendor_bills b ON b.id = c.bill_id
          WHERE b.vendor_invoice_number = 'APP'`,
      );
      expect(Number(lined.rows[0]!.amount)).toBe(40);

      await db.query(
        `INSERT INTO projects.st_invoice_lines
           (tenant_id, project_id, external_invoice_id, external_job_id, line_key, sku, kind, total)
         VALUES ($1,$2,'inv','1','1','LAB','labor',10000)`,
        [t.id, projectId],
      );
      await db.query(
        `INSERT INTO projects.st_material_expenses
           (tenant_id, project_id, external_job_id, external_po_id, total)
         VALUES ($1,$2,'1','st-small',640), ($1,$2,'1','st-linked',40)`,
        [t.id, projectId],
      );
      await db.query(`UPDATE projects.purchase_orders SET st_po_id = 'st-linked' WHERE id = $1`, [approved.poId]);
      await db.query(
        `INSERT INTO projects.labor_actuals
           (tenant_id, project_id, external_job_id, external_timesheet_id, external_technician_id,
            technician_name, work_date, hours, source, burden_amount)
         VALUES ($1,$2,'1','ts','6','Tech','2026-10-01',1,'timesheet',180)`,
        [t.id, projectId],
      );
    });

    const position = await owner().get(`${base}/projects/${projectId}/cost-position`);
    expect(position.status).toBe(200);
    const unbudgeted = (position.body.data as Array<{ description: string; actual_cost: number }>).filter(
      (row) => row.description === "Unbudgeted vendor bill",
    );
    expect(unbudgeted.some((row) => Math.abs(row.actual_cost - 26080.88) < 0.01)).toBe(true);

    const summary = await owner().get(`${base}/projects/${projectId}/financials/summary`);
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    const dash = summary.body.data;
    expect(dash.materialsExpense.value).toBeCloseTo(640 + 40 + 15 + 26080.88, 2);
    expect(dash.subcontractorExpense.value).toBe(80);
    expect(dash.laborExpense.value).toBe(180);
    expect(dash.actualExpense.value).toBeCloseTo(640 + 40 + 15 + 26080.88 + 80 + 180, 2);
    expect(dash.actualMargin.value).toBeCloseTo(10000 - dash.actualExpense.value, 2);
    expect(dash.materialsExpense.value).not.toBeCloseTo(640 + 40 + 40 + 15 + 26080.88, 2);
  });

  it("builds a ServiceTitan payload from known fields and names every gap", () => {
    const seeded = stPoEnvSeedSql({
      PM_ST_PO_SYNC_ENABLED: "true",
      PM_ST_PO_TYPE_ID: "11",
      PM_ST_BUSINESS_UNIT_ID: "not-a-number",
    });
    expect(seeded).toContain("'11'");
    expect(seeded).not.toMatch(/SYNC_ENABLED/);
    expect(seeded).not.toContain("not-a-number");
    const missing = buildStPurchaseOrderPlan({
      poId: "11111111-1111-4111-8111-111111111111",
      poNumber: "PO-1",
      kind: "material",
      scope: "Cabinets",
      issuedOn: "2026-10-01T00:00:00.000Z",
      vendorName: "Cabinet Co",
      stVendorId: null,
      projectName: "Blanton",
      street: "1904 Maplewood Lane",
      city: "Richmond",
      region: "VA",
      postalCode: "23221",
      jobId: "260260",
      jobAmbiguous: false,
      stProjectId: null,
      lines: [{ description: "Cabinets", amount: 26080.88, code: "1110", externalSource: null, externalId: null }],
      settings: { enabled: true, purchaseOrderTypeId: null, inventoryLocationId: null, businessUnitId: null },
    });
    expect(missing.missing.join("\n")).toMatch(/vendorId/);
    expect(missing.missing.join("\n")).toMatch(/typeId/);
    expect(missing.missing.join("\n")).toMatch(/businessUnitId/);
    expect(missing.missing.join("\n")).toMatch(/inventoryLocationId/);
    expect(missing.missing.join("\n")).toMatch(/skuId/);
    expect(missing.payload.memo).toContain(stPoMarker("11111111-1111-4111-8111-111111111111"));
    expect(missing.payload).not.toHaveProperty("vendorId");

    const ready = buildStPurchaseOrderPlan({
      poId: "11111111-1111-4111-8111-111111111111",
      poNumber: "PO-1",
      kind: "material",
      scope: "Cabinets",
      issuedOn: "2026-10-01T00:00:00.000Z",
      vendorName: "Cabinet Co",
      stVendorId: "77",
      projectName: "Blanton",
      street: "1904 Maplewood Lane",
      city: "Richmond",
      region: "VA",
      postalCode: "23221",
      jobId: "260260",
      jobAmbiguous: false,
      stProjectId: "88",
      lines: [
        {
          description: "Cabinets",
          amount: 26080.88,
          code: "1110",
          externalSource: "servicetitan_inventory_sku",
          externalId: "555",
        },
      ],
      settings: { enabled: true, purchaseOrderTypeId: "11", inventoryLocationId: "22", businessUnitId: "33" },
    });
    expect(ready.missing).toEqual([]);
    expect(ready.payload).toMatchObject({
      vendorId: 77,
      typeId: 11,
      businessUnitId: 33,
      inventoryLocationId: 22,
      jobId: 260260,
      projectId: 88,
      tax: 0,
      shipping: 0,
      items: [{ skuId: 555, description: "Cabinets", quantity: 1, cost: 26080.88 }],
    });
    expect(ready.payload).not.toHaveProperty("status");
    expect((ready.payload.shipTo as { address: { country?: string } }).address.country).toBeUndefined();
  });

  it("does not call ServiceTitan when the flag is off, and backfill waits for an explicit confirm", async () => {
    delete process.env.PM_ST_PO_SYNC_ENABLED;
    const before = creates.length;
    const projectId = await project("FLAG-OFF");
    const { material } = await codes();
    const created = await owner().post(`${base}/projects/${projectId}/purchase-orders`).send({
      po_number: "PO-FLAG-OFF",
      supplier_name: "Counter supplier",
      cost_code_id: material.id,
      cost_type: "M",
      amount: 25,
      scope_text: "Small order",
      kind: "material",
      issue: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(creates).toHaveLength(before);
    const poId = created.body.data.id as string;
    const preview = await owner().get(`${base}/purchase-orders/${poId}/service-titan-sync`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.writes_enabled).toBe(false);
    expect(creates).toHaveLength(before);
    const denied = await h.as(t.staff.bookkeeper!.token).post(`${base}/purchase-orders/${poId}/service-titan-sync`).send({ confirm: true });
    expect(denied.status).toBe(403);
    expect(creates).toHaveLength(before);
    const unconfirmed = await owner().post(`${base}/purchase-orders/${poId}/service-titan-sync`).send({});
    expect(unconfirmed.status).toBe(400);
    expect(creates).toHaveLength(before);
    process.env.PM_ST_PO_SYNC_ENABLED = "true";
    const ignored = await owner().post(`${base}/purchase-orders/${poId}/service-titan-sync`).send({ confirm: true });
    expect(ignored.status, JSON.stringify(ignored.body)).toBe(200);
    expect(ignored.body.data.state).toBe("flag_off");
    expect(creates).toHaveLength(before);
    await h.db.withTenant(t.id, (db) =>
      db.query(`UPDATE projects.tenant_settings SET st_po_sync_enabled = true WHERE tenant_id = $1`, [t.id]),
    );
    const blocked = await owner().post(`${base}/purchase-orders/${poId}/service-titan-sync`).send({ confirm: true });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    expect(blocked.body.data.state).toBe("blocked");
    expect(creates).toHaveLength(before);
    await h.db.withTenant(t.id, (db) =>
      db.query(`UPDATE projects.tenant_settings SET st_po_sync_enabled = false WHERE tenant_id = $1`, [t.id]),
    );
    delete process.env.PM_ST_PO_SYNC_ENABLED;
  });

  it("posts one purchase order, and a second confirm, a retry, or a crash does not post again", async () => {
    process.env.PM_ST_PO_SYNC_ENABLED = "true";
    process.env.PM_ST_PO_TYPE_ID = "11";
    process.env.PM_ST_INVENTORY_LOCATION_ID = "22";
    process.env.PM_ST_BUSINESS_UNIT_ID = "33";
    await h.db.withTenant(t.id, (db) =>
      db.query(
        `UPDATE projects.tenant_settings
            SET st_po_sync_enabled = true,
                st_po_type_id = '11',
                st_po_business_unit_id = '33',
                st_po_inventory_location_id = '22'
          WHERE tenant_id = $1`,
        [t.id],
      ),
    );
    const projectId = await project("FLAG-ON");
    const { material } = await codes();
    const system = await h.db.withTenant(t.id, (db) =>
      db.query<{ id: string }>(
        `INSERT INTO projects.external_systems (tenant_id, adapter_key, display_name)
         VALUES ($1, 'servicetitan', 'ServiceTitan') RETURNING id`,
        [t.id],
      ),
    );
    await h.db.withTenant(t.id, (db) =>
      db.query(
        `INSERT INTO projects.project_job_links
           (tenant_id, project_id, external_system_id, external_job_id, title, source_active)
         VALUES ($1,$2,$3,'260260','Job', true)`,
        [t.id, projectId, system.rows[0]!.id],
      ),
    );
    await h.db.withTenant(t.id, (db) =>
      db.query(`UPDATE projects.cost_codes SET external_source = 'servicetitan_inventory_sku', external_id = '555' WHERE id = $1`, [
        material.id,
      ]),
    );
    const vendor = await owner().post(`${base}/vendors`).send({ legal_name: "Mapped Cabinets", email: "mapped@bill.test" });
    expect(vendor.status).toBe(201);
    await h.db.withTenant(t.id, (db) =>
      db.query(`UPDATE projects.vendors SET st_vendor_id = '77' WHERE id = $1`, [vendor.body.data.id]),
    );
    const created = await owner().post(`${base}/projects/${projectId}/purchase-orders`).send({
      po_number: "PO-FLAG-ON",
      vendor_id: vendor.body.data.id,
      cost_code_id: material.id,
      cost_type: "M",
      amount: 26080.88,
      scope_text: "Cabinets",
      kind: "material",
      issue: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const poId = created.body.data.id as string;
    expect(creates).toHaveLength(0);
    const sent = await owner().post(`${base}/purchase-orders/${poId}/service-titan-sync`).send({ confirm: true });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.data.state).toBe("created");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ vendorId: 77, jobId: 260260, typeId: 11, items: [{ skuId: 555, cost: 26080.88 }] });
    const again = await owner().post(`${base}/purchase-orders/${poId}/service-titan-sync`).send({ confirm: true });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.state).toBe("created");
    expect(again.body.data.stPoId).toBe("9001");
    expect(creates).toHaveLength(1);

    remote = null;
    const crashPo = await h.db.withTenant(t.id, async (db) => {
      const row = await db.query<{ id: string }>(
        `INSERT INTO projects.purchase_orders
           (tenant_id, project_id, po_number, vendor_id, cost_code_id, cost_type, amount, scope_text, status, issued_at, kind)
         VALUES ($1,$2,'PO-CRASH',$3,$4,'M',10,'Crash','issued', now(), 'material') RETURNING id`,
        [t.id, projectId, vendor.body.data.id, material.id],
      );
      await db.query(
        `INSERT INTO projects.po_lines (tenant_id, po_id, line_no, cost_code_id, cost_type, description, original_amount)
         VALUES ($1,$2,1,$3,'M','Crash',10)`,
        [t.id, row.rows[0]!.id, material.id],
      );
      return row.rows[0]!.id;
    });
    const settings = {
      enabled: true,
      purchaseOrderTypeId: "11",
      inventoryLocationId: "22",
      businessUnitId: "33",
    };
    await expect(
      syncIssuedPurchaseOrder({
        database: h.db,
        tenantId: t.id,
        poId: crashPo,
        settings,
        client,
        afterRemoteCreate: async () => {
          throw new Error("crash before store");
        },
      }),
    ).rejects.toThrow(/crash before store/);
    expect(creates).toHaveLength(2);
    const retry = await syncIssuedPurchaseOrder({
      database: h.db,
      tenantId: t.id,
      poId: crashPo,
      settings,
      client,
    });
    expect(retry).toMatchObject({ state: "created", stPoId: "9002" });
    expect(creates).toHaveLength(2);
    const stored = await h.db.withTenant(t.id, (db) =>
      db.query<{ st_po_id: string; st_po_sync_state: string }>(
        `SELECT st_po_id, st_po_sync_state FROM projects.purchase_orders WHERE id = $1`,
        [crashPo],
      ),
    );
    expect(stored.rows[0]).toMatchObject({ st_po_id: "9002", st_po_sync_state: "created" });
  });

  it("links an unlinked nightly ServiceTitan purchase order once and does not call ServiceTitan", async () => {
    const projectId = await project("NIGHTLY");
    const calls = { create: 0 };
    const system = await h.db.withTenant(t.id, (db) =>
      db.query<{ id: string }>(
        `SELECT id FROM projects.external_systems WHERE tenant_id = $1 AND adapter_key = 'servicetitan' LIMIT 1`,
        [t.id],
      ),
    );
    const SYSTEM = system.rows[0]!.id;
    await h.db.withTenant(t.id, async (db) => {
      await db.query(
        `INSERT INTO projects.project_job_links
           (tenant_id, project_id, external_system_id, external_job_id, title, source_active)
         VALUES ($1,$2,$3,'4242','Nightly job', true)`,
        [t.id, projectId, SYSTEM],
      );
      await db.query(
        `INSERT INTO projects.st_project_connections
           (project_id, tenant_id, external_system_id, external_project_id, connection_key, snapshot, observed_at, linked_by)
         VALUES ($1,$2,$3,'9','st:nightly','{}'::jsonb, now(), $4)`,
        [projectId, t.id, SYSTEM, t.staff.owner!.id],
      );
    });
    const { material } = await codes();
    const existing = await h.db.withTenant(t.id, async (db) => {
      const row = await db.query<{ id: string }>(
        `INSERT INTO projects.purchase_orders
           (tenant_id, project_id, po_number, supplier_name, cost_code_id, cost_type, amount, scope_text, status, kind)
         VALUES ($1,$2,'PO-MEMO','Supplier',$3,'M',12,'Memo','issued','material') RETURNING id`,
        [t.id, projectId, material.id],
      );
      return row.rows[0]!.id;
    });
    const conn = {
      tenantId: t.id,
      externalSystemId: SYSTEM,
      key: "st:nightly",
      client: {
        readJob: async () => ({ job: { id: "4242", jobNumber: "4242", jobStatus: "Scheduled" }, appointments: [], assignments: [] }),
        readProjectJobs: async () => [
          { id: "4242", jobNumber: "4242", jobStatus: "Scheduled", createdOn: "2026-10-01T00:00:00Z", completedOn: null },
        ],
        readJobInvoiceLines: async () => ({ lines: [], invoices: [] }),
        readJobPurchaseOrders: async () => [
          { id: "777", total: 80, memo: null },
          { id: "778", total: 12, memo: stPoMarker(existing) },
        ],
        readJobTimesheets: async () => ({ forbidden: false, timesheets: [] }),
        readGrossPayItems: async () => ({ forbidden: false, items: [] }),
        createInventoryPurchaseOrder: async () => {
          calls.create += 1;
          throw new Error("nightly must not create a ServiceTitan purchase order");
        },
      },
    };
    await refreshLinkedProject(h.db, conn as never, t.id, projectId, new Date("2026-10-20T12:00:00Z"), {
      ok: false,
      reason: "missing",
      message: "test",
    });
    expect(calls.create).toBe(0);
    const rows = await h.db.withTenant(t.id, (db) =>
      db.query<{ po_number: string; st_po_id: string; origin: string }>(
        `SELECT po_number, st_po_id, origin FROM projects.purchase_orders
          WHERE project_id = $1 AND st_po_id IS NOT NULL ORDER BY st_po_id`,
        [projectId],
      ),
    );
    expect(rows.rows).toEqual([
      { po_number: "ST-777", st_po_id: "777", origin: "servicetitan" },
      { po_number: "PO-MEMO", st_po_id: "778", origin: "journeyman" },
    ]);
    await h.db.withTenant(t.id, (db) =>
      linkUnlinkedServiceTitanPurchaseOrders(db, {
        tenantId: t.id,
        projectId,
        orders: [
          { id: "777", externalJobId: "4242", total: 80 },
          { id: "778", externalJobId: "4242", total: 12, memo: stPoMarker(existing) },
        ],
      }),
    );
    const again = await h.db.withTenant(t.id, (db) =>
      db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.purchase_orders WHERE project_id = $1 AND st_po_id IS NOT NULL`,
        [projectId],
      ),
    );
    expect(again.rows[0]!.n).toBe("2");
    expect(calls.create).toBe(0);
  });

  it("applies every migration twice", async () => {
    await reapply(h);
    await reapply(h);
    const view = await h.db.asOwner((db) =>
      db.query<{ def: string }>(
        `SELECT pg_get_viewdef('projects.v_project_bill_cost'::regclass, true) AS def`,
      ),
    );
    expect(view.rows[0]!.def).toMatch(/v_project_bill_cost|vendor_bills|bill_lines/);
    expect(view.rows[0]!.def).not.toMatch(/budget_lines/);
    const position = await h.db.asOwner((db) =>
      db.query<{ def: string }>(`SELECT pg_get_viewdef('projects.v_cost_position'::regclass, true) AS def`),
    );
    expect(position.rows[0]!.def).toMatch(/v_project_bill_cost/);
    expect(position.rows[0]!.def).toMatch(/Unbudgeted vendor bill/);
  });
});

async function reapply(h: Harness): Promise<void> {
  for (const file of SCHEMA_FILES) {
    for (const statement of splitSqlStatements(readFileSync(file, "utf8"))) {
      if (!hasExecutableSql(statement.text)) continue;
      try {
        await h.db.asOwner((db) => db.query(statement.text));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/already exists/i.test(message)) continue;
        throw new Error(`${path.basename(file)}:${statement.startLine} ${message}`);
      }
    }
  }
}

describe("ServiceTitan purchase order create uses the injected fetch", () => {
  it("POSTs the inventory purchase order and does not follow a redirect", async () => {
    const bodies: string[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      if (String(url).includes("/connect/token")) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 900, scope: "tn.inv.purchaseorders:w" }), {
          status: 200,
        });
      }
      expect(String(url)).toBe("https://api-integration.servicetitan.io/inventory/v2/tenant/10/purchase-orders");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    };
    const adapter = new ServiceTitanReadAdapter(
      { environment: "integration", tenantId: "10", clientId: "client", clientSecret: "secret", appKey: "app" },
      fetcher as typeof fetch,
    );
    const created = await adapter.createInventoryPurchaseOrder({ vendorId: 7, jobId: 9, memo: "jp-po:abc" });
    expect(created).toEqual({ id: "4242" });
    expect(JSON.parse(bodies[0]!)).toMatchObject({ vendorId: 7, jobId: 9, memo: "jp-po:abc" });
  });

  it("treats a timeout as retryable and does not invent a purchase order id", async () => {
    const fetcher = async (url: string) => {
      if (String(url).includes("/connect/token")) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 900 }), { status: 200 });
      }
      throw new Error("timed out");
    };
    const adapter = new ServiceTitanReadAdapter(
      { environment: "integration", tenantId: "10", clientId: "client", clientSecret: "secret", appKey: "app" },
      fetcher as typeof fetch,
    );
    await expect(adapter.createInventoryPurchaseOrder({ memo: "jp-po:abc" })).rejects.toBeInstanceOf(
      ServiceTitanStatusWriteError,
    );
  });
});
