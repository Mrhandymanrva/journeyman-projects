import { seedDemoSources } from "../src/demo/sourceData.js";
/**
 * The console, running locally, with no database to install.
 *
 *   pnpm dev
 *
 * Boots a real PostgreSQL in process (PGlite), applies the schema,
 * seeds the demo account, loads the shipped permit offices once, and serves
 * the console with dev sign-in on. Same
 * app, same handlers, same RLS — the only difference from production is where
 * the Postgres lives and that the data disappears when you stop it.
 *
 * Everything runs as jp_app: NOSUPERUSER, NOBYPASSRLS, not the table owner.
 * Running the dev server as a superuser would mean developing against a
 * configuration where tenant isolation silently does not apply.
 */
import { createApp } from "../src/app.js";
import { assertDatabaseContract } from "../src/db/assertions.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import { PgliteDatabase } from "../test/support/pgliteDatabase.js";
import { seedDemoTenant } from "../src/demo/demoData.js";
import { seedPermitOffices } from "../src/domain/permitOfficeSeed.js";

const PORT = Number(process.env.PORT ?? 3200);

console.log("starting an in-process PostgreSQL…");
const db = await PgliteDatabase.create([
  "db/001_schema.sql",
  "db/002_seed.sql",
  "db/004_change_orders.sql",
  "db/005_draw_schedule.sql",
  "db/006_external_invoices.sql",
  "db/007_project_invoices.sql",
  "db/008_project_planning.sql",
  "db/009_source_snapshots.sql",
  "db/010_pm_directories.sql",
  "db/011_dispatch_changes.sql",
  "db/012_subcontractor_intake.sql",
  "db/013_st_projects.sql",
  "db/014_st_project_authority.sql",
  "db/015_staff_login.sql",
  "db/016_project_controls.sql",
  "db/017_record_publications.sql",
  "db/018_document_links.sql",
  "db/019_vendor_archive.sql",
  "db/020_qbo_payables.sql",
  "db/021_coi_coverage.sql",
  "db/022_vendor_sync.sql",
  "db/023_agreement_advisory.sql",
  "db/024_po_lines.sql",
  "db/025_bid_request_lines.sql",
  "db/026_bill_lines.sql",
  "db/029_tenant_accounting_settings.sql",
  "db/030_draw_external_invoice_number.sql",
  "db/031_material_bill_cost.sql",
  "db/032_vendor_document_notes.sql",
  "db/033_field_release.sql",
  "db/034_preconstruction_tasks.sql",
  "db/035_field_start.sql",
  "db/036_permit_offices.sql",
  "db/037_permit_office_seed.sql",
  "db/038_gate_checklist_defaults.sql",
  "db/039_change_order_log_and_closeout.sql",
  "db/040_labor_actuals.sql",
  "db/041_st_ar_observations.sql",
  "db/042_project_health_snapshots.sql",
  "db/043_technician_labor_rates.sql",
  "db/044_labor_refresh.sql",
  "db/045_labor_refresh_scheduled.sql",
  "db/046_st_labor_code.sql",
  "db/047_unbudgeted_labor.sql",
]);

await assertDatabaseContract(db);
console.log(
  "startup assertions passed (no BYPASSRLS, no ownership, RLS forced everywhere)",
);

await seedDemoTenant({
  db,
  privileged: (fn) => db.asOwner(fn),
  log: (m) => console.log("  " + m),
});
await seedPermitOffices(db, { log: (m) => console.log("  " + m) });

const staffSessions = new MemoryStaffSessions();
// Fixed and published in the banner below: this listens on localhost with
// throwaway data, so a secret nobody can read is friction without safety.
const DEV_TOKEN = "local-dev";
const app = createApp({
  database: db,
  staffSessions,
  sources: await seedDemoSources(db),
  devLogin: {
    enabled: true,
    sessions: staffSessions,
    nodeEnv: "development",
    accessToken: DEV_TOKEN,
  },
});

app.listen(PORT, () => {
  console.log(`
  Console:  http://localhost:${PORT}
  Sign in:  owner@demo.test  ·  tenant slug: demo  ·  access token: ${DEV_TOKEN}

  Other roles worth trying, because they see a different console:
    pm@demo.test      project manager — no margin, no invoice recording
    office@demo.test  office — records invoice numbers, cannot see margin
    books@demo.test   bookkeeper — approves bills, cannot edit the budget
`);
});
