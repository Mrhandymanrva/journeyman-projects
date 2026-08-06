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
