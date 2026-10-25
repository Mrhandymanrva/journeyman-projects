import { seedDemoSources } from "../src/demo/sourceData.js";
/**
 * The console, running locally, with no database to install.
 *
 *   pnpm dev
 *
 * Boots a real PostgreSQL in process (PGlite), applies db/001 and db/002,
 * seeds the demo account, and serves the console with dev sign-in on. Same
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
  "db/032_field_release.sql",
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
