import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import {
  hasExecutableSql,
  splitSqlStatements,
  strippedSql,
} from '../src/db/splitSql.js';

/**
 * The SQL src/provision.ts issues, executed against a real PostgreSQL.
 *
 * This file exists because of a bug that no amount of type-checking could
 * catch and that only appears against a live server: the role creation was
 * written as a DO block taking $1 and $2. A DO block's body is a string
 * literal as far as the server is concerned, so those are not placeholders,
 * the statement reports zero parameters, and the bind fails with
 * "bind message supplies 2 parameters, but prepared statement requires 0".
 *
 * It shipped, and the first thing that ran it was a production deploy.
 */

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create({ extensions: { citext } });
});

afterAll(async () => {
  await pg?.close();
});

/** Mirrors the loop in src/provision.ts. */
async function ensureRole(role: string, password: string): Promise<string> {
  const existing = await pg.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
  const verb = existing.rows.length > 0 ? 'ALTER' : 'CREATE';
  const built = await pg.query<{ ddl: string }>(
    `SELECT format(
       '${verb} ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB',
       $1::text, $2::text
     ) AS ddl`,
    [role, password],
  );
  await pg.exec(built.rows[0]!.ddl);
  return verb;
}

describe('role provisioning', () => {
  it('creates a role, then alters it on a re-run', async () => {
    expect(await ensureRole('jp_owner', 'first-password')).toBe('CREATE');
    expect(await ensureRole('jp_owner', 'second-password')).toBe('ALTER');
  });

  it('creates the application role without superuser or BYPASSRLS', async () => {
    await ensureRole('jp_app', 'app-password');
    const { rows } = await pg.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'jp_app'`,
    );
    expect(rows[0]!.rolsuper).toBe(false);
    expect(rows[0]!.rolbypassrls).toBe(false);
  });

  it('quotes a password containing quotes and backslashes', async () => {
    // format(%L) does this, not string concatenation here. A password with a
    // single quote in it would otherwise end the literal and turn the rest
    // into DDL.
    const nasty = `p'a\\ss"word'; DROP SCHEMA projects CASCADE; --`;
    await expect(ensureRole('jp_nasty', nasty)).resolves.toBe('CREATE');

    const { rows } = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_roles WHERE rolname = 'jp_nasty'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('rejects a DO block carrying bind parameters, which is the bug this guards', async () => {
    // Kept as an executable statement of why the code is shaped the way it is.
    await expect(
      pg.query(
        `DO $do$ BEGIN
           EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', $1, $2);
         END $do$`,
        ['jp_never', 'nope'],
      ),
    ).rejects.toThrow(/bind message supplies|parameter/i);
  });
});

describe('the grants file is applied in full', () => {
  const grantsFile = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../db/003_roles.sql'),
    'utf8',
  );

  it('every executable statement survives the comment-stripping filter', () => {
    // The bug this guards: the filter tested /^\s*GRANT/ against raw statement
    // text, but splitSqlStatements attaches the comment lines above a
    // statement to it. GRANT USAGE ON SCHEMA projects has a comment block over
    // it and was therefore skipped, so the application ended up with SELECT on
    // every table and no USAGE on the schema containing them.
    const statements = splitSqlStatements(grantsFile).filter((s) => hasExecutableSql(s.text));
    const kinds = statements.map((s) => strippedSql(s.text).split(/\s+/)[0]!.toUpperCase());

    expect(kinds.length).toBeGreaterThan(0);
    expect(new Set(kinds)).toEqual(new Set(['GRANT', 'REVOKE', 'ALTER']));

    // The specific statement that went missing.
    const usage = statements.find((s) => /GRANT\s+USAGE\s+ON\s+SCHEMA\s+projects/i.test(s.text));
    expect(usage, 'GRANT USAGE ON SCHEMA projects must not be filtered out').toBeDefined();
  });

  it('the old filter would have dropped it, which is why this test exists', () => {
    const statements = splitSqlStatements(grantsFile);
    const usage = statements.find((s) => /GRANT\s+USAGE\s+ON\s+SCHEMA\s+projects/i.test(s.text))!;
    expect(/^\s*(GRANT|REVOKE|ALTER DEFAULT)/i.test(usage.text)).toBe(false);
    expect(/^(GRANT|REVOKE|ALTER DEFAULT)/i.test(strippedSql(usage.text))).toBe(true);
  });

  it('applying the whole file to a provisioned database leaves jp_app able to read', async () => {
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS projects`);
    await pg.exec(`CREATE TABLE IF NOT EXISTS projects.tenants (id uuid PRIMARY KEY)`);
    await pg.exec(`CREATE TABLE IF NOT EXISTS projects.entitlements (tenant_id uuid)`);
    await pg.exec(`CREATE TABLE IF NOT EXISTS projects.cost_code_library (code text)`);
    await ensureRole('jp_app', 'pw');

    for (const stmt of splitSqlStatements(grantsFile)) {
      if (!hasExecutableSql(stmt.text)) continue;
      try {
        await pg.exec(stmt.text);
      } catch (err) {
        // REVOKE ON SCHEMA public needs an owner PGlite does not model.
        if (!/must be owner|does not exist/i.test(String(err))) throw err;
      }
    }

    const { rows } = await pg.query<{ has: boolean }>(
      `SELECT has_schema_privilege('jp_app', 'projects', 'USAGE') AS has`,
    );
    expect(rows[0]!.has, 'jp_app must have USAGE on the projects schema').toBe(true);
  });
});
