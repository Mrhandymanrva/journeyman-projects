import type {AccountingGateway} from "../../src/adapters/quickbooks.js";
import type {BidMailConfig} from "../../src/adapters/bidMail.js";
import type { SourceConnections } from "../../src/adapters/sourceConnections.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import supertest from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app.js";
import { MemoryStaffSessions } from "../../src/http/memoryStaffSessions.js";
import type { StaffRole } from "../../src/http/capabilities.js";
import { PgliteDatabase } from "./pgliteDatabase.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

export const SCHEMA_FILES = [
  path.join(repoRoot, "db/001_schema.sql"),
  path.join(repoRoot, "db/002_seed.sql"),
  path.join(repoRoot, "db/004_change_orders.sql"),
  path.join(repoRoot, "db/005_draw_schedule.sql"),
  path.join(repoRoot, "db/006_external_invoices.sql"),
  path.join(repoRoot, "db/007_project_invoices.sql"),
  path.join(repoRoot, "db/008_project_planning.sql"),
  path.join(repoRoot, "db/009_source_snapshots.sql"),
  path.join(repoRoot, "db/010_pm_directories.sql"),
  path.join(repoRoot, "db/011_dispatch_changes.sql"),
  path.join(repoRoot, "db/012_subcontractor_intake.sql"),
  path.join(repoRoot, "db/013_st_projects.sql"),
  path.join(repoRoot, "db/014_st_project_authority.sql"),
  path.join(repoRoot, "db/015_staff_login.sql"),
  path.join(repoRoot, "db/016_project_controls.sql"),
  path.join(repoRoot, "db/017_record_publications.sql"),
  path.join(repoRoot, "db/018_document_links.sql"),
  path.join(repoRoot, "db/019_vendor_archive.sql"),
  path.join(repoRoot, "db/020_qbo_payables.sql"),
  path.join(repoRoot, "db/021_coi_coverage.sql"),
  path.join(repoRoot, "db/022_vendor_sync.sql"),
  path.join(repoRoot, "db/023_agreement_advisory.sql"),
  path.join(repoRoot, "db/024_po_lines.sql"),
  path.join(repoRoot, "db/025_bid_request_lines.sql"),
  path.join(repoRoot, "db/026_bill_lines.sql"),
  path.join(repoRoot, "db/029_tenant_accounting_settings.sql"),
  path.join(repoRoot, "db/030_draw_external_invoice_number.sql"),
  path.join(repoRoot, "db/031_material_bill_cost.sql"),
  path.join(repoRoot, "db/032_vendor_document_notes.sql"),
  path.join(repoRoot, "db/033_field_release.sql"),
  path.join(repoRoot, "db/034_preconstruction_tasks.sql"),
  path.join(repoRoot, "db/035_field_start.sql"),
  path.join(repoRoot, "db/036_permit_offices.sql"),
  path.join(repoRoot, "db/037_permit_office_seed.sql"),
  path.join(repoRoot, "db/038_gate_checklist_defaults.sql"),
  path.join(repoRoot, "db/039_change_order_log_and_closeout.sql"),
  path.join(repoRoot, "db/040_labor_actuals.sql"),
  path.join(repoRoot, "db/041_st_ar_observations.sql"),
  path.join(repoRoot, "db/042_project_health_snapshots.sql"),
  path.join(repoRoot, "db/043_technician_labor_rates.sql"),
  path.join(repoRoot, "db/044_labor_refresh.sql"),
  path.join(repoRoot, "db/045_labor_refresh_scheduled.sql"),
  path.join(repoRoot, "db/046_st_labor_code.sql"),
  path.join(repoRoot, "db/047_unbudgeted_labor.sql"),
  path.join(repoRoot, "db/048_pricebook_labor_code.sql"),
  path.join(repoRoot, "db/049_commission_labor.sql"),
  path.join(repoRoot, "db/050_st_project_financials.sql"),
  path.join(repoRoot, "db/051_labor_refresh_status.sql"),
  path.join(repoRoot, "db/052_st_status_sync.sql"),
  path.join(repoRoot, "db/053_st_financial_summary.sql"),
  path.join(repoRoot, "db/054_project_budget_entry.sql"),
];

export interface TenantFixture {
  id: string;
  slug: string;
  businessUnits: Record<string, string>;
  staff: Record<string, { id: string; token: string; role: StaffRole }>;
}

export interface Harness {
  app: Express;
  db: PgliteDatabase;
  sessions: MemoryStaffSessions;
  request: supertest.Agent;
  as(token: string): TokenScopedRequest;
  close(): Promise<void>;
}

export interface TokenScopedRequest {
  get(url: string): supertest.Test;
  post(url: string): supertest.Test;
  put(url: string): supertest.Test;
  patch(url: string): supertest.Test;
  del(url: string): supertest.Test;
}

export async function startHarness(
  sqlFiles: string[] = SCHEMA_FILES,
  sources?: SourceConnections,
  bidMail?:BidMailConfig,
  accounting?:AccountingGateway,
): Promise<Harness> {
  const db = await PgliteDatabase.create(sqlFiles);
  const sessions = new MemoryStaffSessions();
  // serveConsole off: the static handler would answer an unmatched non-API
  // path with index.html, which turns a routing mistake in a test into a
  // passing 200.
  const app = createApp({
    database: db,
    staffSessions: sessions,
    serveConsole: false,
    sources,
    bidMail,
    accounting,
  });
  // supertest(app) binds every method to one http.Server and closes it when
  // the last request settles. The next call can run while that close is still
  // finishing, and formatServerUrl then reads a null address. A new server
  // per call keeps the requests independent.
  const http = () => supertest(app);
  const request = {
    get: (url: string) => http().get(url),
    post: (url: string) => http().post(url),
    put: (url: string) => http().put(url),
    patch: (url: string) => http().patch(url),
    delete: (url: string) => http().delete(url),
    del: (url: string) => http().delete(url),
  } as unknown as supertest.Agent;

  return {
    app,
    db,
    sessions,
    request,
    as(token: string) {
      const auth = (t: supertest.Test) =>
        t.set("Authorization", `Bearer ${token}`);
      return {
        get: (url) => auth(request.get(url)),
        post: (url) => auth(request.post(url)),
        put: (url) => auth(request.put(url)),
        patch: (url) => auth(request.patch(url)),
        del: (url) => auth(request.delete(url)),
      };
    },
    close: () => db.close(),
  };
}

export interface CreateTenantOptions {
  slug: string;
  displayName?: string;
  unitName?: string;
  /** Defaults to both modules active. */
  entitlements?: Array<{ module: "estimating" | "projects"; state: string }>;
  enforceBusinessUnitScoping?: boolean;
  staff?: Array<{
    key: string;
    email: string;
    role: StaffRole;
    unit?: string | null;
  }>;
}

const DEFAULT_STAFF: NonNullable<CreateTenantOptions["staff"]> = [
  { key: "owner", email: "owner@example.test", role: "owner" },
  { key: "manager", email: "manager@example.test", role: "manager" },
  { key: "pm", email: "pm@example.test", role: "project_manager" },
  { key: "office", email: "office@example.test", role: "office" },
  { key: "estimator", email: "estimator@example.test", role: "estimator" },
  { key: "bookkeeper", email: "bookkeeper@example.test", role: "bookkeeper" },
];

/**
 * Provisions a tenant exactly the way production must: the platform writes the
 * tenants and entitlements rows, then the module's own activation runs inside
 * a transaction with app.tenant_id already set. Getting that order wrong is
 * the first thing an operator will do, so the fixture does it right and the
 * order is visible here rather than buried in a runbook.
 */
export async function createTenant(
  h: Harness,
  opts: CreateTenantOptions,
): Promise<TenantFixture> {
  const entitlements = opts.entitlements ?? [
    { module: "estimating", state: "active" },
    { module: "projects", state: "active" },
  ];

  const tenantId = await h.db.asOwner(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO projects.tenants (id, slug, display_name)
       VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
      [opts.slug, opts.displayName ?? opts.slug],
    );
    const id = rows[0]!.id;
    for (const e of entitlements) {
      await c.query(
        `INSERT INTO projects.entitlements (tenant_id, module_key, state)
         VALUES ($1, $2, $3::projects.entitlement_state)`,
        [id, e.module, e.state],
      );
    }
    return id;
  });

  const fixture: TenantFixture = {
    id: tenantId,
    slug: opts.slug,
    businessUnits: {},
    staff: {},
  };

  // Activation writes through RLS, so it only works when BOTH modules are
  // live. `.every()` on an empty list is true, which is exactly wrong here.
  const live = new Set(
    entitlements
      .filter((e) => ["trial", "active", "past_due"].includes(e.state))
      .map((e) => e.module),
  );
  if (!live.has("estimating") || !live.has("projects")) return fixture;

  await h.db.withTenant(tenantId, async (c) => {
    await c.query(`SELECT projects.activate_tenant_full($1, $2)`, [
      tenantId,
      opts.unitName ?? "Main",
    ]);
    if (opts.enforceBusinessUnitScoping) {
      await c.query(
        `UPDATE projects.tenant_settings SET enforce_business_unit_scoping = true
          WHERE tenant_id = $1`,
        [tenantId],
      );
    }
    const units = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM projects.business_units WHERE tenant_id = $1`,
      [tenantId],
    );
    for (const u of units.rows) fixture.businessUnits[u.name] = u.id;

    for (const s of opts.staff ?? DEFAULT_STAFF) {
      const unitId = s.unit ? fixture.businessUnits[s.unit] : null;
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO projects.staff (tenant_id, email, full_name, role, business_unit_id)
         VALUES ($1,$2,$3,$4::projects.staff_role,$5) RETURNING id`,
        [tenantId, s.email, s.key, s.role, unitId ?? null],
      );
      fixture.staff[s.key] = {
        id: rows[0]!.id,
        role: s.role,
        token: h.sessions.issue({ tenantId, staffId: rows[0]!.id }),
      };
    }
  });

  return fixture;
}

export async function addBusinessUnit(
  h: Harness,
  tenant: TenantFixture,
  name: string,
): Promise<string> {
  const id = await h.db.withTenant(tenant.id, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO projects.business_units (tenant_id, name) VALUES ($1,$2) RETURNING id`,
      [tenant.id, name],
    );
    return rows[0]!.id;
  });
  tenant.businessUnits[name] = id;
  return id;
}

export function estimatePayload(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    contract_version: "estimate.v1",
    source_kind: "journeyman_estimate",
    source_key: `est-${Math.random().toString(36).slice(2, 10)}`,
    payload: {
      sold_price: 41800,
      currency: "USD",
      lines: [
        {
          code: "1120",
          description: "Tile setting subcontract",
          quantity: 1,
          unit: "ls",
          cost_type: "S",
          amount: 5200,
        },
        {
          code: "1110",
          description: "Tile — material",
          quantity: 220,
          unit: "sf",
          cost_type: "M",
          amount: 1980,
        },
        {
          code: "930",
          description: "Carpentry labor",
          quantity: 40,
          unit: "hr",
          cost_type: "L",
          amount: 3200,
        },
      ],
    },
    ...overrides,
  };
}

export function projectBody(overrides: Record<string, unknown> = {}) {
  return {
    project_number: `MHR-2026-${Math.floor(Math.random() * 9000 + 1000)}`,
    name: "Whitfield — Primary Bath",
    address_line1: "4412 Grove Avenue",
    city: "Richmond",
    region: "VA",
    postal_code: "23221",
    contract_value: 41800,
    currency: "USD",
    target_margin: 0.38,
    source_kind: "manual",
    ...overrides,
  };
}
