/**
 * One-time database provisioning.
 *
 *   ADMIN_DATABASE_URL=postgres://…   # the superuser string the host gave you
 *   JP_OWNER_PASSWORD=…
 *   JP_APP_PASSWORD=…
 *   tsx scripts/provisionRoles.ts
 *
 * Creates jp_owner and jp_app, applies db/001–002 as jp_owner, then grants.
 * Prints the DATABASE_URL the application should use — which is jp_app's, not
 * the one you started with.
 *
 * Idempotent. Safe to re-run after a migration to re-apply grants.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { splitSqlStatements } from '../src/db/splitSql.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required.`);
    process.exit(2);
  }
  return v;
}

const adminUrl = required('ADMIN_DATABASE_URL');
const ownerPassword = required('JP_OWNER_PASSWORD');
const appPassword = required('JP_APP_PASSWORD');

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
// CREATE ROLE takes no bind parameters, so the password reaches it through
// format(%L) inside a DO block rather than by string concatenation into DDL.
for (const [role, password] of [
  ['jp_owner', ownerPassword],
  ['jp_app', appPassword],
] as const) {
  await admin.query(
    `DO $do$
     BEGIN
       IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) THEN
         EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB', $1, $2);
       ELSE
         EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB', $1, $2);
       END IF;
     END $do$`,
    [role, password],
  );
  console.log(`role ${role} ready`);
}

const db = await admin.query<{ current_database: string }>(`SELECT current_database()`);
const database = db.rows[0]!.current_database;
await admin.query(`GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO jp_app, jp_owner`);
await admin.query(`GRANT jp_owner TO ${quoteIdent(who.rows[0].current_user)}`);
await admin.end();

// --- schema, as jp_owner --------------------------------------------------
// Applied by the owner so that jp_owner owns every object. Running these as
// the superuser and granting afterwards leaves the tables owned by a role that
// bypasses RLS, which is the failure this whole script exists to avoid.
const owner = new pg.Client({
  connectionString: withCredentials(adminUrl, 'jp_owner', ownerPassword),
});
await owner.connect();

for (const file of ['db/001_schema.sql', 'db/002_seed.sql']) {
  const full = path.join(repoRoot, file);
  const statements = splitSqlStatements(readFileSync(full, 'utf8'));
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
      process.exit(1);
    }
  }
  console.log(`applied ${file} (${applied}/${statements.length} statements)`);
}

// --- grants ---------------------------------------------------------------
const grants = readFileSync(path.join(repoRoot, 'db/003_roles.sql'), 'utf8');
for (const stmt of splitSqlStatements(grants)) {
  if (!/^\s*(GRANT|REVOKE|ALTER DEFAULT)/i.test(stmt.text)) continue;
  await owner.query(stmt.text);
}
console.log('grants applied');

// --- verify ---------------------------------------------------------------
const checks = await owner.query<{ label: string; value: string }>(`
  SELECT 'jp_app is superuser'  AS label, (SELECT rolsuper::text     FROM pg_roles WHERE rolname='jp_app') AS value
  UNION ALL
  SELECT 'jp_app has BYPASSRLS', (SELECT rolbypassrls::text FROM pg_roles WHERE rolname='jp_app')
  UNION ALL
  SELECT 'tables owned by jp_app', (SELECT count(*)::text FROM pg_class c
     JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='projects' AND c.relkind='r' AND pg_get_userbyid(c.relowner)='jp_app')
  UNION ALL
  SELECT 'tables without FORCE RLS', (SELECT count(*)::text FROM pg_class c
     JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='projects' AND c.relkind='r' AND NOT c.relforcerowsecurity)
`);

console.log('\nverification (every value must be false or 0):');
let bad = false;
for (const row of checks.rows) {
  const ok = row.value === 'false' || row.value === '0';
  if (!ok) bad = true;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${row.label} = ${row.value}`);
}
await owner.end();

if (bad) process.exit(1);

console.log(
  '\nSet DATABASE_URL for the application to the jp_app credentials:\n  ' +
    withCredentials(adminUrl, 'jp_app', '<JP_APP_PASSWORD>'),
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
