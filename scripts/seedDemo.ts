/**
 * Seeds the demo account against a real database.
 *
 *   DATABASE_URL=… tsx scripts/seedDemo.ts
 *
 * The platform rows (tenants, entitlements) are not writable by the
 * application role, so this needs a connection with rights beyond jp_app —
 * ADMIN_DATABASE_URL if you have it, otherwise DATABASE_URL and the role had
 * better own the schema.
 */
import pg from 'pg';
import { PgDatabase } from '../src/db/pgDatabase.js';
import type { SqlClient } from '../src/db/database.js';
import { seedDemoTenant } from '../src/demo/demoData.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
const adminUrl = process.env.ADMIN_DATABASE_URL ?? url;

const db = new PgDatabase({ connectionString: url });
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();

try {
  await seedDemoTenant({
    db,
    privileged: (fn) => fn(admin as unknown as SqlClient),
    log: (m) => console.log(m),
  });
} finally {
  await admin.end();
  await db.close();
}

console.log(`
Demo account ready.

  tenant slug   demo
  sign in as    owner@demo.test      (owner — sees everything)
                pm@demo.test         (project manager — no margin export)
                office@demo.test     (office — records invoice numbers, no margin)
                books@demo.test      (bookkeeper — approves bills, no budget edit)

Start the server with DEV_LOGIN=true and open the console.
`);
