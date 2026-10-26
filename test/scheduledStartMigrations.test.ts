import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { hasExecutableSql, splitSqlStatements, strippedSql } from "../src/db/splitSql.js";
import {
  createTenant,
  projectBody,
  SCHEMA_FILES,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

/**
 * The four logged starts called out on migration 035. A deploy re-applies
 * every file under db/, so this checks the combined result, not only 035.
 */
const LIVE = [
  ["320012949", "2026-09-01"],
  ["321293715", "2026-10-05"],
  ["321586598", "2026-10-19"],
  ["321612166", "2026-09-17"],
] as const;

const base = "/api/v1/projects";
let h: Harness;
let t: TenantFixture;

beforeAll(async () => {
  h = await startHarness();
  t = await createTenant(h, { slug: "scheduled-start-migrations" });
});

afterAll(async () => {
  await h?.close();
});

it("has no migration that assigns scheduled_start", () => {
  const hits: string[] = [];
  for (const file of SCHEMA_FILES) {
    for (const statement of splitSqlStatements(readFileSync(file, "utf8"))) {
      const body = strippedSql(statement.text);
      const updates =
        /\bUPDATE\b/i.test(body) && /\bscheduled_start\b/i.test(body);
      const assigns = /\bSET\s+scheduled_start\b/i.test(body);
      if (updates || assigns) {
        hits.push(`${path.basename(file)}:${statement.startLine}`);
      }
    }
  }
  expect(hits).toEqual([]);
});

it("keeps an existing project's scheduled_start after every migration is applied again", async () => {
  const owner = h.as(t.staff.owner!.token);
  const ids: string[] = [];
  for (const [number, start] of LIVE) {
    const created = await owner.post(base + "/projects").send(
      projectBody({
        project_number: number,
        name: "Live " + number,
        scheduled_start: start,
      }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.scheduled_start).toBe(start);
    ids.push(created.body.data.id as string);
  }

  await h.db.withTenant(t.id, (db) =>
    db.query(
      `UPDATE projects.projects SET labor_refresh_source = 'scheduled' WHERE id = $1`,
      [ids[0]],
    ),
  );

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

  const stored = await h.db.withTenant(t.id, (db) =>
    db.query<{ project_number: string; scheduled_start: string }>(
      `SELECT project_number, scheduled_start::text AS scheduled_start
         FROM projects.projects
        WHERE project_number = ANY($1::text[])`,
      [LIVE.map(([number]) => number)],
    ),
  );
  expect(stored.rows).toHaveLength(LIVE.length);
  for (const [index, [number, start]] of LIVE.entries()) {
    const row = stored.rows.find((item) => item.project_number === number);
    expect(row?.scheduled_start).toBe(start);
    const detail = await owner.get(base + "/projects/" + ids[index]);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.data.scheduled_start).toBe(start);
    expect(detail.body.data.project_number).toBe(number);
  }
  const source = await h.db.withTenant(t.id, (db) =>
    db.query<{ labor_refresh_source: string }>(
      `SELECT labor_refresh_source FROM projects.projects WHERE id = $1`,
      [ids[0]],
    ),
  );
  expect(source.rows[0]?.labor_refresh_source).toBe("scheduled");
});
