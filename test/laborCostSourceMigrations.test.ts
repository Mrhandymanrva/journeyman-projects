import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { hasExecutableSql, splitSqlStatements } from "../src/db/splitSql.js";
import {
  createTenant,
  projectBody,
  SCHEMA_FILES,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

/**
 * Provisioning re-applies every file under db/ on each deploy and ignores only
 * "already exists". 055 used to drop and re-add projects_labor_cost_source_check
 * without 'posted_commission', which 056 added. Once a refresh stored
 * 'posted_commission', the next deploy failed at 055.
 */
const base = "/api/v1/projects";
let h: Harness;
let t: TenantFixture;

beforeAll(async () => {
  h = await startHarness();
  t = await createTenant(h, { slug: "labor-cost-source-migrations" });
});

afterAll(async () => {
  await h?.close();
});

async function reapplyMigrations(): Promise<void> {
  for (const file of SCHEMA_FILES) {
    for (const statement of splitSqlStatements(readFileSync(file, "utf8"))) {
      if (!hasExecutableSql(statement.text)) continue;
      try {
        await h.db.asOwner((db) => db.query(statement.text));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/already exists/i.test(message)) continue;
        throw new Error(`${path.basename(file)}:${statement.startLine} ${message}`);
      }
    }
  }
}

it("reapplies every migration twice when projects store every labor cost source", async () => {
  const owner = h.as(t.staff.owner!.token);
  const sources = [
    "posted_commission",
    "billed_labor_25pct",
    "payroll",
    "none_recent_payroll_missing",
  ];
  const ids: string[] = [];
  for (const [i, source] of sources.entries()) {
    const created = await owner.post(base + "/projects").send(
      projectBody({ project_number: `LCS-${i}`, name: `Labor cost source ${source}` }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    ids.push(id);
    await h.db.withTenant(t.id, (db) =>
      db.query(`UPDATE projects.projects SET labor_cost_source = $2 WHERE id = $1`, [id, source]),
    );
  }

  await reapplyMigrations();
  await reapplyMigrations();

  const stored = await h.db.withTenant(t.id, (db) =>
    db.query<{ labor_cost_source: string }>(
      `SELECT labor_cost_source FROM projects.projects WHERE id = ANY($1::uuid[]) ORDER BY project_number`,
      [ids],
    ),
  );
  expect(stored.rows.map((r) => r.labor_cost_source)).toEqual(sources);

  const constraint = await h.db.asOwner((db) =>
    db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class rel ON rel.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'projects'
          AND rel.relname = 'projects'
          AND c.conname = 'projects_labor_cost_source_check'`,
    ),
  );
  expect(constraint.rows).toHaveLength(1);
  const def = constraint.rows[0]!.def;
  for (const source of sources) expect(def).toContain(`'${source}'`);

  // The check still refuses a value the app never writes.
  await expect(
    h.db.withTenant(t.id, (db) =>
      db.query(`UPDATE projects.projects SET labor_cost_source = 'bogus' WHERE id = $1`, [ids[0]]),
    ),
  ).rejects.toThrow(/projects_labor_cost_source_check/);
});
