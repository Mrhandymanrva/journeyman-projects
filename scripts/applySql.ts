/**
 * Applies db/*.sql in order.
 *
 *   tsx scripts/applySql.ts                 # against DATABASE_URL
 *   tsx scripts/applySql.ts --dry-run       # against a throwaway in-process PG
 *
 * Statement at a time, so a failure names a file and a line instead of handing
 * back "syntax error" for a 900-line script.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSqlStatements } from '../src/db/splitSql.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  path.join(repoRoot, 'db/001_schema.sql'),
  path.join(repoRoot, 'db/002_seed.sql'),
  path.join(repoRoot, 'db/004_change_orders.sql'),
  path.join(repoRoot, 'db/005_draw_schedule.sql'),
  path.join(repoRoot, 'db/006_external_invoices.sql'),
  path.join(repoRoot, 'db/007_project_invoices.sql'),
  path.join(repoRoot, 'db/008_project_planning.sql'),
  path.join(repoRoot, 'db/009_source_snapshots.sql'),
  path.join(repoRoot, 'db/010_pm_directories.sql'),
  path.join(repoRoot, 'db/011_dispatch_changes.sql'),
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
  path.join(repoRoot, "db/032_vendor_document_notes.sql"),
  path.join(repoRoot, "db/033_field_release.sql"),
];

const dryRun = process.argv.includes('--dry-run');

interface Runner {
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

async function makeRunner(): Promise<Runner> {
  if (dryRun) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { citext } = await import('@electric-sql/pglite/contrib/citext');
    const pg = await PGlite.create({ extensions: { citext } });

    // Applied as a NOSUPERUSER owner, not as postgres.
    //
    // A superuser bypasses row-level security entirely, so a migration that
    // writes data into a tenant-scoped table succeeds in a superuser dry run
    // and fails on the first real deployment against the WITH CHECK predicate.
    // That happened with db/005_draw_schedule.sql: the dry run was green and
    // the deploy died. A check that cannot see the most likely production
    // failure is worse than no check, because it is trusted.
    //
    // Extensions are installed first, as superuser, exactly as
    // src/provision.ts does — they are database-wide objects owned by the DBA.
    await pg.exec(`CREATE EXTENSION IF NOT EXISTS citext`);
    await pg.exec(`CREATE ROLE jp_owner NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    // The database name differs between hosts, so it is read rather than
    // assumed.
    const db = await pg.query<{ n: string }>(`SELECT current_database() AS n`);
    await pg.exec(`GRANT CREATE ON DATABASE "${db.rows[0]!.n}" TO jp_owner`);
    await pg.exec(`GRANT ALL ON SCHEMA public TO jp_owner`);
    await pg.exec(`SET ROLE jp_owner`);
    return { exec: (sql) => pg.exec(sql), close: () => pg.close() };
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Use --dry-run to apply to a scratch database.');
    process.exit(2);
  }
  const pg = await import('pg');
  const client = new pg.default.Client({ connectionString: url });
  await client.connect();
  return { exec: (sql) => client.query(sql), close: () => client.end() };
}

const runner = await makeRunner();
let applied = 0;

for (const file of FILES) {
  const statements = splitSqlStatements(readFileSync(file, 'utf8'));
  for (const stmt of statements) {
    try {
      await runner.exec(stmt.text);
      applied++;
    } catch (err) {
      console.error(
        `\n${path.relative(repoRoot, file)}:${stmt.startLine}\n  ` +
          (err instanceof Error ? err.message : String(err)),
      );
      console.error('\n--- statement ---');
      console.error(stmt.text.split('\n').slice(0, 20).join('\n'));
      await runner.close();
      process.exit(1);
    }
  }
  console.log(`applied ${path.relative(repoRoot, file)} (${statements.length} statements)`);
}

console.log(`\n${applied} statements applied${dryRun ? ' (dry run)' : ''}.`);
await runner.close();
