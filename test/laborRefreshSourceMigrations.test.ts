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
 * "already exists". 044 drops and re-adds projects_labor_refresh_source_check
 * before 045 runs, so a stored 'scheduled' stamp has to pass 044 itself.
 */
const base = "/api/v1/projects";
let h: Harness;
let t: TenantFixture;

beforeAll(async () => {
  h = await startHarness();
  t = await createTenant(h, { slug: "labor-refresh-source-migrations" });
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

it("reapplies every migration twice when a project is stamped scheduled", async () => {
  const owner = h.as(t.staff.owner!.token);
  const created = await owner.post(base + "/projects").send(
    projectBody({
      project_number: "LR-044",
      name: "Scheduled labor refresh",
    }),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const projectId = created.body.data.id as string;

  const stamped = await h.db.withTenant(t.id, (db) =>
    db.query(
      `UPDATE projects.projects
          SET labor_refresh_source = 'scheduled'
        WHERE id = $1
        RETURNING labor_refresh_source`,
      [projectId],
    ),
  );
  expect(stamped.rows).toEqual([{ labor_refresh_source: "scheduled" }]);

  await reapplyMigrations();
  await reapplyMigrations();

  const stored = await h.db.withTenant(t.id, (db) =>
    db.query<{ labor_refresh_source: string }>(
      `SELECT labor_refresh_source
         FROM projects.projects
        WHERE id = $1`,
      [projectId],
    ),
  );
  expect(stored.rows).toEqual([{ labor_refresh_source: "scheduled" }]);

  const constraint = await h.db.asOwner((db) =>
    db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class rel ON rel.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'projects'
          AND rel.relname = 'projects'
          AND c.conname = 'projects_labor_refresh_source_check'`,
    ),
  );
  expect(constraint.rows).toHaveLength(1);
  const def = constraint.rows[0]!.def;
  expect(def).toContain("'manual'");
  expect(def).toContain("'scheduled'");
  expect(def).toContain("'auto-hourly'");
});
