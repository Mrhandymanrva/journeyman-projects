import pg from 'pg';
import type { Database, SqlClient } from './database.js';

const { Pool } = pg;

/**
 * A `date` column is a calendar day. It has no time and no zone.
 *
 * node-postgres parses it into a JS Date at local midnight, which then
 * JSON-serialises to an instant in UTC — so a permit due on 2026-08-16, read
 * anywhere west of Greenwich, arrives at the client as 2026-08-15T22:00:00Z
 * and renders as the day before. Every due date, window, and expiry in this
 * module is a `date`, so that is every one of them, off by one, only for some
 * users, only some of the time.
 *
 * Handing back the string Postgres actually sent is the fix.
 */
const DATE_OID = 1082;
pg.types.setTypeParser(DATE_OID, (value) => value);

export interface PgDatabaseOptions {
  connectionString: string;
  max?: number;
  /**
   * Statement timeout in ms, applied per connection. A runaway report should
   * not hold a pooled connection open indefinitely.
   */
  statementTimeoutMs?: number;
}

export class PgDatabase implements Database {
  private readonly pool: pg.Pool;

  constructor(opts: PgDatabaseOptions) {
    this.pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 10,
      // search_path is pinned so nothing depends on the server default, but
      // note that every reference in the schema's functions is qualified too —
      // this is belt, not the braces.
      options: '-c search_path=projects,public',
      statement_timeout: opts.statementTimeoutMs ?? 30_000,
    });
  }

  async withTenant<T>(tenantId: string, fn: (client: SqlClient) => Promise<T>): Promise<T> {
    return this.transaction(tenantId, fn);
  }

  async withoutTenant<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    return this.transaction(null, fn);
  }

  private async transaction<T>(
    tenantId: string | null,
    fn: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (tenantId !== null) {
        await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      }
      const result = await fn(client as unknown as SqlClient);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already broken; releasing it with an error tells
        // the pool to discard rather than reuse it.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
