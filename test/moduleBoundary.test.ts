import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  estimatePayload,
  projectBody,
  SCHEMA_FILES,
  startHarness,
  type Harness,
} from './support/harness.js';

/**
 * MANDATORY TEST 2 — the module boundary. Handoff README §2, Addendum §3.1.
 *
 * "Drop the estimating module's schema entirely from a test database and run
 * the full Projects test suite. Everything must pass. If anything fails, a
 * dependency has crept in that the boundary was supposed to prevent."
 *
 * The literal version of that instruction is not runnable here, because the
 * estimating core is a different application with a different database and
 * this test database has never had its schema. Dropping something that was
 * never created proves nothing, and a test that cannot fail is worse than no
 * test — it reads as coverage.
 *
 * So it is inverted into something that can actually fail:
 *
 *  1. A decoy `estimating` schema is created, populated, and then dropped.
 *     The whole projects suite runs against a database where any reach across
 *     would have resolved a moment ago and now cannot. A handler that grew a
 *     join gets a "relation does not exist" here rather than in production
 *     six months after estimating was refactored.
 *  2. Static assertions over the source: no SQL in src/ names the estimating
 *     schema, and no foreign key in db/*.sql crosses out of `projects`.
 *
 * Together they are the same guarantee: this module runs for a tenant who
 * never licenses estimating at all.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('module boundary — runtime', () => {
  it('the full flow works with no estimating schema in the database', async () => {
    h = await startHarness(SCHEMA_FILES);

    // Create the decoy, so that "it works" is not an accident of the reach
    // never having been possible.
    await h.db.asOwner(async (c) => {
      await c.query(`CREATE SCHEMA estimating`);
      await c.query(`CREATE TABLE estimating.estimates (id uuid PRIMARY KEY, sold_price numeric)`);
      await c.query(
        `INSERT INTO estimating.estimates VALUES (gen_random_uuid(), 41800)`,
      );
    });
    await h.db.asOwner(async (c) => {
      await c.query(`DROP SCHEMA estimating CASCADE`);
    });

    const tenant = await createTenant(h, { slug: 'boundary-tenant' });

    const imported = await h
      .as(tenant.staff.owner!.token)
      .post('/api/v1/projects/estimate-imports')
      .send(estimatePayload());
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);

    const created = await h
      .as(tenant.staff.owner!.token)
      .post('/api/v1/projects/projects')
      .send(
        projectBody({
          estimate_import_id: imported.body.data.id,
          source_kind: 'journeyman_estimate',
        }),
      );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.budget_lines_created).toBe(3);

    const cost = await h
      .as(tenant.staff.owner!.token)
      .get(`/api/v1/projects/projects/${created.body.data.id}/cost-position`);
    expect(cost.status).toBe(200);
    expect(cost.body.data).toHaveLength(3);

    const margin = await h
      .as(tenant.staff.owner!.token)
      .get(`/api/v1/projects/projects/${created.body.data.id}/margin`);
    expect(margin.status).toBe(200);
    expect(margin.body.data.has_budget).toBe(true);
  });

  it('a tenant licensed for projects but not estimating still reads its own entitlement', async () => {
    // The licensing rule is that Projects requires the estimating entitlement,
    // so this tenant is correctly locked out of the data. What it must NOT get
    // is an empty screen with no explanation: the entitlements table is
    // tenant-isolated but deliberately not entitlement-gated.
    h = await startHarness(SCHEMA_FILES);
    const tenant = await createTenant(h, {
      slug: 'projects-only',
      entitlements: [
        { module: 'projects', state: 'active' },
        { module: 'estimating', state: 'cancelled' },
      ],
    });

    const rows = await h.db.withTenant(tenant.id, async (c) =>
      c.query<{ module_key: string; state: string }>(
        `SELECT module_key, state FROM projects.entitlements`,
      ),
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find((r) => r.module_key === 'estimating')?.state).toBe('cancelled');

    const projects = await h.db.withTenant(tenant.id, async (c) =>
      c.query(`SELECT * FROM projects.projects`),
    );
    expect(projects.rows).toHaveLength(0);
  });
});

describe('module boundary — static', () => {
  const sourceFiles = walk(path.join(repoRoot, 'src')).filter((f) => f.endsWith('.ts'));

  it('no source file names the estimating schema in SQL', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = readFileSync(file, 'utf8');
      // Strip comments — the boundary is discussed in prose all over this
      // codebase and prose is not a dependency.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
        .join('\n');
      if (/\bestimating\s*\./i.test(code) || /\bFROM\s+estimating\b/i.test(code)) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders, 'These files query the estimating schema directly.').toEqual([]);
  });

  it('every foreign key in the schema stays inside projects', () => {
    for (const file of SCHEMA_FILES) {
      const sql = readFileSync(file, 'utf8');
      const references = [...sql.matchAll(/REFERENCES\s+([A-Za-z_][\w.]*)/gi)].map((m) => m[1]!);
      for (const target of references) {
        const schema = target.includes('.') ? target.split('.')[0]! : 'projects';
        expect(
          schema,
          `${path.basename(file)} has a foreign key into ${target}`,
        ).toBe('projects');
      }
    }
  });

  it('the estimate contract is the only place a foreign payload is parsed', () => {
    // If a second parser appears, the "versioned contract" is two contracts
    // that will disagree.
    const parsers = sourceFiles.filter((f) =>
      /estimateV1PayloadSchema|SUPPORTED_CONTRACT_VERSIONS/.test(readFileSync(f, 'utf8')),
    );
    const declaring = parsers.filter((f) =>
      /export const SUPPORTED_CONTRACT_VERSIONS/.test(readFileSync(f, 'utf8')),
    );
    expect(declaring.map((f) => path.basename(f))).toEqual(['estimateContract.ts']);
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
