import { createApp } from './app.js';
import { MissingConfigError, readEnv, type Env } from './env.js';
import { PgDatabase } from './db/pgDatabase.js';
import { assertDatabaseContract, StartupAssertionError } from './db/assertions.js';
import { MemoryStaffSessions } from './http/memoryStaffSessions.js';

/**
 * A crash loop is only useful if the log says what to do. Container platforms
 * restart on exit, so whatever is printed here is printed once a second until
 * someone reads it — it had better be the answer rather than a stack trace.
 */
function die(headline: string, guidance: string): never {
  console.error(`\n${'─'.repeat(72)}`);
  console.error(`journeyman-projects cannot start.\n\n  ${headline}\n`);
  console.error(guidance);
  console.error(`${'─'.repeat(72)}\n`);
  process.exit(1);
}

let env: Env;
try {
  env = readEnv();
} catch (err) {
  if (err instanceof MissingConfigError) die(err.message, err.guidance);
  throw err;
}

const database = new PgDatabase({ connectionString: env.databaseUrl });

try {
  await assertDatabaseContract(database);
} catch (err) {
  await database.close().catch(() => {});
  if (err instanceof StartupAssertionError) {
    die(
      'The database is reachable but not configured safely.',
      [
        err.failures.map((f) => `  ✗ ${f}`).join('\n'),
        '',
        'Each of these makes tenant isolation cosmetic rather than enforced, and',
        'none of them is visible in a code review. Run `pnpm db:provision` against',
        'the database to create jp_owner and jp_app, then point DATABASE_URL at the',
        'jp_app credentials it prints. See docs/DEPLOY.md.',
      ].join('\n'),
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  die(
    'Could not reach the database.',
    [
      `  ${message}`,
      '',
      'Check that the PostgreSQL service is running and that DATABASE_URL points',
      'at it. If the host requires TLS, the connection string needs ?sslmode=require.',
    ].join('\n'),
  );
}

// The platform owns the real staff session; this is the seam it plugs into.
const staffSessions = new MemoryStaffSessions();

const app = createApp({
  database,
  staffSessions,
  devLogin: { enabled: env.devLogin, sessions: staffSessions, nodeEnv: env.nodeEnv },
});
const server = app.listen(env.port, () => {
  console.log(`journeyman-projects listening on :${env.port} (${env.nodeEnv})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void database.close().then(() => process.exit(0));
    });
  });
}
