/**
 * One-time database provisioning.
 *
 *   ADMIN_DATABASE_URL=postgres://…   # the superuser string the host gave you
 *   JP_OWNER_PASSWORD=…
 *   JP_APP_PASSWORD=…
 *   pnpm db:provision            # locally, against ADMIN_DATABASE_URL
 *   node dist/provision.js       # on a host, as a pre-deploy step
 *
 * Creates jp_owner and jp_app, applies db/001–002 as jp_owner, then grants.
 * Prints the DATABASE_URL the application should use — which is jp_app's, not
 * the one you started with.
 *
 * Idempotent, and deliberately so: it runs as Railway's preDeployCommand on
 * every deploy, which is also how grants reach a table added by a later
 * migration. Lives in src/ rather than scripts/ so it compiles into dist and
 * needs no devDependency at runtime — a pre-deploy step that depends on tsx is
 * a pre-deploy step that breaks the first time the host prunes dev packages.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  hasExecutableSql,
  splitSqlStatements,
  strippedSql,
} from "./db/splitSql.js";
import {
  NON_TENANT_SCOPED_TABLES,
  TENANT_SCOPED_TABLES,
} from "./db/assertions.js";
import { PgDatabase } from "./db/pgDatabase.js";
import type { SqlClient } from "./db/database.js";
import { seedPermitOffices } from "./domain/permitOfficeSeed.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required.`);
    process.exit(2);
  }
  return v;
}

// DATABASE_PUBLIC_URL is what Railway calls the externally reachable string on
// a Postgres service; DATABASE_URL there resolves to an internal hostname that
// only other services in the project can see. Preferring the public one means
// this can run under `railway run --service Postgres` without anyone copying a
// password out of a dashboard and into a shell.
//
// All three point at a superuser on a fresh managed Postgres. That is the
// whole point of this script: the application must stop using that role.
const adminUrl =
  process.env.ADMIN_DATABASE_URL ??
  process.env.DATABASE_PUBLIC_URL ??
  required("DATABASE_URL");
const ownerPassword = required("JP_OWNER_PASSWORD");
const appPassword = required("JP_APP_PASSWORD");

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();

const who = await admin.query<{ rolsuper: boolean; current_user: string }>(
  `SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user`,
);
if (!who.rows[0]?.rolsuper) {
  console.error(
    `Connected as ${who.rows[0]?.current_user}, which is not a superuser. ` +
      `Role creation needs one.`,
  );
  await admin.end();
  process.exit(1);
}

console.log(`connected as ${who.rows[0].current_user} (superuser)\n`);

// --- roles ----------------------------------------------------------------
// CREATE ROLE takes no bind parameters, and neither does a DO block: its body
// is a string literal as far as the server is concerned, so $1 inside it is
// not a placeholder and the statement reports zero parameters. Postgres says
// "bind message supplies 2 parameters, but prepared statement requires 0".
//
// So the DDL is built by a parameterised SELECT — an ordinary query, which
// does take parameters — and executed as the text it returns. The quoting is
// done by Postgres's own format(%I, %L) rather than by concatenating a
// password into DDL here.
for (const [role, password] of [
  ["jp_owner", ownerPassword],
  ["jp_app", appPassword],
] as const) {
  const existing = await admin.query(
    `SELECT 1 FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  // Fixed vocabulary, never derived from input.
  const verb = (existing.rowCount ?? 0) > 0 ? "ALTER" : "CREATE";

  const built = await admin.query<{ ddl: string }>(
    `SELECT format(
       '${verb} ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB',
       $1::text, $2::text
     ) AS ddl`,
    [role, password],
  );
  await admin.query(built.rows[0]!.ddl);
  console.log(`role ${role} ready (${verb.toLowerCase()}d)`);
}

const db = await admin.query<{ current_database: string }>(
  `SELECT current_database()`,
);
const database = db.rows[0]!.current_database;
await admin.query(
  `GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO jp_app, jp_owner`,
);
// jp_owner runs the migrations, so it needs to be able to CREATE SCHEMA. On a
// managed Postgres the roles you create have CONNECT and nothing else, and the
// first thing 001_schema.sql does is create a schema.
await admin.query(
  `GRANT CREATE ON DATABASE ${quoteIdent(database)} TO jp_owner`,
);
await admin.query(`GRANT jp_owner TO ${quoteIdent(who.rows[0].current_user)}`);

// Extensions are installed by the superuser, before the owner runs anything.
// citext is a trusted extension from PostgreSQL 13, so jp_owner could install
// it given CREATE on the database — but extensions are database-wide objects
// that outlive this schema, and having the DBA own them is the honest
// arrangement. Doing it here also means 001_schema.sql's
// `CREATE EXTENSION IF NOT EXISTS` is already satisfied when the owner reaches
// it.
await admin.query(`CREATE EXTENSION IF NOT EXISTS citext`);
console.log("extension citext ready");

// --- schema, as jp_owner --------------------------------------------------
// Applied by the owner so that jp_owner owns every object. Running these as
// the superuser and granting afterwards leaves the tables owned by a role that
// bypasses RLS, which is the failure this whole script exists to avoid.
const owner = new pg.Client({
  connectionString: withCredentials(adminUrl, "jp_owner", ownerPassword),
});
await owner.connect();

for (const file of [
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
  "db/041_project_health_snapshots.sql",
]) {
  const full = path.join(repoRoot, file);
  const statements = splitSqlStatements(readFileSync(full, "utf8"));
  let applied = 0;
  for (const stmt of statements) {
    try {
      await owner.query(stmt.text);
      applied++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Re-running provisioning against an existing database is expected.
      if (/already exists/i.test(message)) continue;
      console.error(`\n${file}:${stmt.startLine}\n  ${message}`);
      await owner.end();
      await admin.end();
      process.exit(1);
    }
  }
  console.log(`applied ${file} (${applied}/${statements.length} statements)`);
}

// --- grants ---------------------------------------------------------------
// Run on the admin connection, not the owner's. Two of these are outside
// jp_owner's authority however the schema is set up: ALTER DEFAULT PRIVILEGES
// FOR ROLE jp_owner may only be issued by that role or a superuser, and
// REVOKE CREATE ON SCHEMA public needs whoever owns `public`, which on a
// managed Postgres is the platform's own role.
const grants = readFileSync(path.join(repoRoot, "db/003_roles.sql"), "utf8");
for (const stmt of splitSqlStatements(grants)) {
  // Every executable statement in this file is a grant. It used to be filtered
  // with /^\s*(GRANT|REVOKE|ALTER DEFAULT)/ against the raw statement text,
  // which was wrong in a way nothing could see: the splitter attaches the
  // comment lines above a statement to it, so any grant with a comment over it
  // failed the test and was skipped. GRANT USAGE ON SCHEMA projects has a
  // comment block over it. The table grants, which do not, ran fine — so the
  // application had SELECT on every table and no USAGE on the schema holding
  // them, and every request died with "permission denied for schema projects".
  //
  // Nothing is filtered now. A statement that is only comments is an empty
  // query and Postgres accepts it.
  if (!hasExecutableSql(stmt.text)) continue;
  try {
    await admin.query(stmt.text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A REVOKE against an object this database does not have is not a failure
    // — it is a hardening step that was already unnecessary here.
    if (
      /does not exist|must be owner/i.test(message) &&
      /^REVOKE/i.test(strippedSql(stmt.text))
    ) {
      console.warn(`  skipped: ${stmt.text.split("\n")[0]} (${message})`);
      continue;
    }
    console.error(`\ndb/003_roles.sql:${stmt.startLine}\n  ${message}`);
    await owner.end();
    await admin.end();
    process.exit(1);
  }
}
console.log("grants applied");

// --- verify ---------------------------------------------------------------
// Checked against the named tenant-scoped list, not against "every table in
// the schema". Two tables deliberately have no RLS, and a verification that
// reports those as failures is a verification people learn to scroll past.
const checks = await owner.query<{ label: string; value: string }>(
  `SELECT 'jp_app is superuser'  AS label,
          (SELECT rolsuper::text     FROM pg_roles WHERE rolname='jp_app') AS value
   UNION ALL
   SELECT 'jp_app has BYPASSRLS',
          (SELECT rolbypassrls::text FROM pg_roles WHERE rolname='jp_app')
   UNION ALL
   SELECT 'tables owned by jp_app',
          (SELECT count(*)::text FROM pg_class c
             JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='projects' AND c.relkind='r'
              AND pg_get_userbyid(c.relowner)='jp_app')
   UNION ALL
   SELECT 'tenant-scoped tables without FORCE RLS',
          (SELECT count(*)::text FROM pg_class c
             JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='projects' AND c.relkind='r'
              AND c.relname = ANY($1::text[])
              AND NOT c.relforcerowsecurity)
   UNION ALL
   SELECT 'tenant-scoped tables missing entirely',
          (SELECT (cardinality($1::text[]) - count(*))::text FROM pg_class c
             JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='projects' AND c.relkind='r'
              AND c.relname = ANY($1::text[]))`,
  [TENANT_SCOPED_TABLES as unknown as string[]],
);

console.log("\nverification (every value must be false or 0):");
let bad = false;
for (const row of checks.rows) {
  const ok = row.value === "false" || row.value === "0";
  if (!ok) bad = true;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${row.label} = ${row.value}`);
}

// Anything unpoliced that is not on the known-exempt list is named, so a table
// added later without RLS is visible rather than absorbed into a count.
const unexpected = await owner.query<{ relname: string }>(
  `SELECT c.relname FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'projects' AND c.relkind = 'r'
      AND NOT c.relforcerowsecurity
      AND NOT (c.relname = ANY($1::text[]))`,
  [NON_TENANT_SCOPED_TABLES as unknown as string[]],
);
for (const row of unexpected.rows) {
  bad = true;
  console.log(
    `  FAIL  projects.${row.relname} has no forced RLS and is not a known exemption`,
  );
}
if (bad) {
  await owner.end();
  await admin.end();
  process.exit(1);
}

// --- optional demo data ---------------------------------------------------
// A managed Postgres usually has no public endpoint, so there is no way to
// reach it from a laptop to seed anything. This is the hook for a demo or
// staging instance to populate itself, and it is refused outright under
// NODE_ENV=production for the same reason DEV_LOGIN is: demo tenants and
// customer data must never share a database.
if (process.env.SEED_DEMO === "true") {
  if (process.env.NODE_ENV === "production") {
    console.error("SEED_DEMO is refused when NODE_ENV=production.");
    await owner.end();
    await admin.end();
    process.exit(1);
  }
  console.log("\nSEED_DEMO is on — rebuilding the demo account.");
  const { seedDemoTenant } = await import("./demo/demoData.js");
  const appDb = new PgDatabase({
    connectionString: process.env.DATABASE_URL ?? adminUrl,
  });
  try {
    await seedDemoTenant({
      db: appDb,
      privileged: (fn) => fn(admin as unknown as SqlClient),
      log: (m) => console.log("  " + m),
    });
    console.log(
      '  demo account ready: tenant slug "demo", sign in as owner@demo.test',
    );
  } finally {
    await appDb.close();
  }
}

// Explicitly bind the configured ST source to an existing entitled PM account.
if (process.env.PM_ST_TENANT_ID && process.env.PM_ST_EXTERNAL_SYSTEM_ID) {
  const connectorDb = new PgDatabase({
    connectionString: required("DATABASE_URL"),
  });
  try {
    await connectorDb.withTenant(process.env.PM_ST_TENANT_ID, async (db) => {
      await db.query(
        `INSERT INTO projects.external_systems(id,tenant_id,adapter_key,display_name,is_revenue_system_of_record) VALUES($1,$2,'servicetitan','ServiceTitan',true) ON CONFLICT(tenant_id,adapter_key) DO NOTHING`,
        [process.env.PM_ST_EXTERNAL_SYSTEM_ID, process.env.PM_ST_TENANT_ID],
      );
      const check = await db.query(
        `SELECT id FROM projects.external_systems WHERE id=$1 AND adapter_key='servicetitan'`,
        [process.env.PM_ST_EXTERNAL_SYSTEM_ID],
      );
      if (!check.rows.length)
        throw new Error("Configured ST source does not match the PM account.");
    });
  } finally {
    await connectorDb.close();
  }
}
// Same load the application runs at boot. Doing it here means a deploy that
// finishes provisioning already has the offices, and the following boot sees
// the marker and does not write again. DATABASE_URL is jp_app, so the insert
// goes through the same RLS path as POST /jurisdictions/import.
if (process.env.DATABASE_URL) {
  const seedDb = new PgDatabase({ connectionString: process.env.DATABASE_URL });
  try {
    await seedPermitOffices(seedDb);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\npermit offices seed failed\n  ${message}`);
    await seedDb.close().catch(() => {});
    await owner.end();
    await admin.end();
    process.exit(1);
  }
  await seedDb.close();
} else {
  console.log(
    "permit offices seed: DATABASE_URL is not set, so application boot will load the offices.",
  );
}

await owner.end();
await admin.end();

console.log(
  "\nSet DATABASE_URL for the application to the jp_app credentials:\n  " +
    withCredentials(adminUrl, "jp_app", "<JP_APP_PASSWORD>"),
);

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}
