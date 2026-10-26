import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import type { AdvisoryLock, Database, SqlClient } from '../../src/db/database.js';
import { splitSqlStatements } from '../../src/db/splitSql.js';

/**
 * A real PostgreSQL, in process.
 *
 * The tests that matter here — cross-tenant isolation, entitlement gating,
 * the eligibility trigger — are all enforced by the database. A mocked or
 * SQLite-backed test database would assert that the mock behaves, which is
 * exactly the assurance we do not need.
 *
 * Everything runs as `jp_app`: NOSUPERUSER, NOBYPASSRLS, not the table owner.
 * A superuser connection ignores RLS entirely regardless of FORCE ROW LEVEL
 * SECURITY, so testing as one would make every isolation test pass for the
 * wrong reason.
 */
export const APP_ROLE = 'jp_app';
const DATE_OID = 1082;

export class PgliteDatabase implements Database {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly pg: PGlite) {}

  static async create(sqlFiles: string[]): Promise<PgliteDatabase> {
    const pg = await PGlite.create({
      extensions: { citext },
      // Match src/db/pgDatabase.ts: a `date` stays the calendar day Postgres
      // sent, rather than becoming a JS Date at local midnight that
      // JSON-serialises to the previous day west of Greenwich.
      parsers: { [DATE_OID]: (value: string) => value },
    });

    for (const file of sqlFiles) {
      for (const stmt of splitSqlStatements(readFileSync(file, 'utf8'))) {
        await pg.exec(stmt.text);
      }
    }

    await pg.exec(`
      CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA projects TO ${APP_ROLE};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA projects TO ${APP_ROLE};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA projects TO ${APP_ROLE};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA projects TO ${APP_ROLE};
      -- cost_code_library is product content, not tenant data: read only.
      REVOKE INSERT, UPDATE, DELETE ON projects.cost_code_library FROM ${APP_ROLE};
    `);

    return new PgliteDatabase(pg);
  }

  withTenant<T>(tenantId: string, fn: (client: SqlClient) => Promise<T>): Promise<T> {
    return this.transaction(tenantId, fn, APP_ROLE);
  }

  withoutTenant<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    return this.transaction(null, fn, APP_ROLE);
  }

  /**
   * Session lock. The acquire transaction commits before this returns, and the
   * lock stays on this one connection until release. PGlite has one session,
   * so a second acquire of the same key on this object reenters instead of
   * failing. A second replica is what returns null.
   */
  async tryAdvisoryLock(key: string): Promise<AdvisoryLock | null> {
    const locked = await this.transaction(
      null,
      async (client) => {
        const result = await client.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked`,
          [key],
        );
        return result.rows[0]?.locked === true;
      },
      APP_ROLE,
    );
    if (!locked) return null;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await this.transaction(
          null,
          async (client) => {
            await client.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [key]);
          },
          APP_ROLE,
        );
      },
    };
  }

  /**
   * Platform-owned writes: the tenants and entitlements rows that billing owns
   * and that the application role is not granted. Test-only escape hatch, and
   * named so that its use in a test is a deliberate act.
   */
  asOwner<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    return this.transaction(null, fn, null);
  }

  private transaction<T>(
    tenantId: string | null,
    fn: (client: SqlClient) => Promise<T>,
    role: string | null,
  ): Promise<T> {
    // PGlite is a single connection. Serialising keeps concurrent requests in
    // a test from interleaving their transactions on it.
    const run = this.queue.then(async () => {
      const client: SqlClient = {
        query: async <R>(text: string, params?: readonly unknown[]) => {
          const result = await this.pg.query<R>(text, params ? [...params] : undefined);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
      };
      await this.pg.exec('BEGIN');
      try {
        if (role) await this.pg.exec(`SET LOCAL ROLE ${role}`);
        if (tenantId !== null) {
          await this.pg.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
        }
        const out = await fn(client);
        await this.pg.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          await this.pg.exec('ROLLBACK');
        } catch {
          /* already aborted */
        }
        throw err;
      }
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
