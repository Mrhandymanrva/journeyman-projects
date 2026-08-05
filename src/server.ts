import { createApp } from './app.js';
import { readEnv } from './env.js';
import { PgDatabase } from './db/pgDatabase.js';
import { assertDatabaseContract, StartupAssertionError } from './db/assertions.js';
import { MemoryStaffSessions } from './http/memoryStaffSessions.js';

const env = readEnv();
const database = new PgDatabase({ connectionString: env.databaseUrl });

try {
  await assertDatabaseContract(database);
} catch (err) {
  if (err instanceof StartupAssertionError) {
    console.error(err.message);
    console.error(
      '\nThe module will not start with these unmet. Each one makes tenant isolation\n' +
        'cosmetic rather than enforced, and none of them is visible in a code review.',
    );
  } else {
    console.error(err);
  }
  await database.close();
  process.exit(1);
}

// The platform owns the real staff session; this is the seam it plugs into.
const staffSessions = new MemoryStaffSessions();

const app = createApp({ database, staffSessions });
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
