import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parsePermitOfficeCsv } from "../src/domain/permitOffices.js";
import {
  permitOfficeSeedCsvPath,
  seedPermitOffices,
} from "../src/domain/permitOfficeSeed.js";
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
} from "./support/harness.js";

const csvPath = permitOfficeSeedCsvPath();
const base = "/api/v1/projects";

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
});

it("parses the shipped file as 18 offices and 41 contacts", () => {
  const offices = parsePermitOfficeCsv(readFileSync(csvPath, "utf8"));
  expect(offices).toHaveLength(18);
  expect(offices.reduce((sum, office) => sum + (office.contacts?.length ?? 0), 0)).toBe(41);
  const jamesCity = offices.find((office) => office.municipality === "James City County");
  const gloucester = offices.find((office) => office.municipality === "Gloucester County");
  expect(jamesCity?.contacts).toHaveLength(18);
  expect(gloucester?.contacts ?? []).toHaveLength(0);
});

it("creates 18 offices and 41 contacts on an empty tenant and does nothing the second time", async () => {
  const tenant = await createTenant(h, { slug: "permit-seed-empty" });
  const project = await h
    .as(tenant.staff.owner!.token)
    .post(base + "/projects")
    .send(
      projectBody({
        project_number: "320012949",
        name: "Logged start stays",
        scheduled_start: "2026-09-01",
      }),
    );
  expect(project.status, JSON.stringify(project.body)).toBe(201);

  const first = await seedPermitOffices(h.db, { tenantId: tenant.id, env: {}, log: () => {} });
  expect(first).toMatchObject({
    status: "applied",
    tenantId: tenant.id,
    created: 18,
    updated: 0,
    contacts_upserted: 41,
    unchanged: 0,
  });
  await expectCounts(tenant.id, 18, 41);
  await expectOffice(tenant.id, "James City County", 18);
  await expectOffice(tenant.id, "Gloucester County", 0);
  const richmond = await officeDetail(tenant.id, "City of Richmond");
  expect(richmond.contacts.map((contact) => [contact.name, contact.title])).toContainEqual([
    "David Alley",
    "Commissioner of Buildings",
  ]);

  await h.db.withTenant(tenant.id, (db) =>
    db.query(
      `UPDATE projects.jurisdictions
          SET notes = 'edited by hand'
        WHERE name = 'City of Richmond'`,
    ),
  );
  await h.db.withTenant(tenant.id, (db) =>
    db.query(
      `UPDATE projects.jurisdiction_contacts
          SET title = 'Acting commissioner'
        WHERE name = 'David Alley'`,
    ),
  );
  await h.db.withTenant(tenant.id, (db) =>
    db.query(
      `INSERT INTO projects.jurisdiction_contacts
         (tenant_id, jurisdiction_id, name, title, phone, email, notes, sort_order)
       SELECT $1, id, 'Handwritten Clerk', 'Counter', '804-555-0100', 'counter@example.test',
              'added after the seed', 50
         FROM projects.jurisdictions
        WHERE name = 'City of Richmond'`,
      [tenant.id],
    ),
  );

  const second = await seedPermitOffices(h.db, { tenantId: tenant.id, env: {}, log: () => {} });
  expect(second).toMatchObject({
    status: "already_applied",
    tenantId: tenant.id,
    created: 0,
    updated: 0,
    contacts_upserted: 0,
    unchanged: 0,
  });
  await expectCounts(tenant.id, 18, 42);
  const after = await officeDetail(tenant.id, "City of Richmond");
  expect(after.notes).toBe("edited by hand");
  expect(after.contacts.map((contact) => [contact.name, contact.title])).toEqual(
    expect.arrayContaining([
      ["David Alley", "Acting commissioner"],
      ["Handwritten Clerk", "Counter"],
    ]),
  );

  const stored = await h.db.withTenant(tenant.id, (db) =>
    db.query<{ scheduled_start: string }>(
      `SELECT scheduled_start::text AS scheduled_start
         FROM projects.projects WHERE project_number = '320012949'`,
    ),
  );
  expect(stored.rows[0]?.scheduled_start).toBe("2026-09-01");

  const other = await createTenant(h, { slug: "permit-seed-untouched" });
  await expectCounts(other.id, 0, 0);
});

it("updates the three existing demo offices and creates the other fifteen", async () => {
  const tenant = await createTenant(h, { slug: "permit-seed-demo" });
  await h.db.withTenant(tenant.id, (db) =>
    db.query(
      `INSERT INTO projects.jurisdictions (tenant_id, name, state, typical_review_days)
       VALUES ($1, 'City of Richmond', 'VA', 12),
              ($1, 'City of Newport News', 'VA', 15),
              ($1, 'Henrico County', 'VA', 9)`,
      [tenant.id],
    ),
  );
  const first = await seedPermitOffices(h.db, { tenantId: tenant.id, env: {}, log: () => {} });
  expect(first).toMatchObject({
    status: "applied",
    created: 15,
    updated: 3,
    contacts_upserted: 41,
    unchanged: 0,
  });
  await expectCounts(tenant.id, 18, 41);
  const again = await seedPermitOffices(h.db, { tenantId: tenant.id, env: {}, log: () => {} });
  expect(again.status).toBe("already_applied");
  await expectCounts(tenant.id, 18, 41);
});

it("uses the only tenant, the configured tenant, and skips the ambiguous cases", async () => {
  const only = await startHarness();
  try {
    const tenant = await createTenant(only, { slug: "permit-seed-only" });
    const applied = await seedPermitOffices(only.db, { env: {}, log: () => {} });
    expect(applied).toMatchObject({ status: "applied", tenantId: tenant.id, created: 18 });

    const named = await startHarness();
    try {
      const first = await createTenant(named, { slug: "permit-seed-named-a" });
      const second = await createTenant(named, { slug: "permit-seed-named-b" });
      const skipped = await seedPermitOffices(named.db, { env: {}, log: () => {} });
      expect(skipped).toMatchObject({ status: "skipped", tenantId: null, created: 0 });
      await expectCountsOn(named, first.id, 0, 0);
      await expectCountsOn(named, second.id, 0, 0);

      const chosen = await seedPermitOffices(named.db, {
        env: { SSO_TENANT_ID: second.id, PM_PORTFOLIO_TENANT_ID: first.id },
        log: () => {},
      });
      expect(chosen).toMatchObject({ status: "applied", tenantId: second.id, created: 18 });
      await expectCountsOn(named, first.id, 0, 0);
      await expectCountsOn(named, second.id, 18, 41);

      const missing = await seedPermitOffices(only.db, {
        env: { PM_PORTFOLIO_TENANT_ID: "00000000-0000-4000-8000-000000000099" },
        log: () => {},
      });
      expect(missing.status).toBe("skipped");
      expect(missing.reason).toMatch(/not a tenant/);
    } finally {
      await named.close();
    }

    const empty = await startHarness();
    try {
      const none = await seedPermitOffices(empty.db, { env: {}, log: () => {} });
      expect(none).toMatchObject({
        status: "skipped",
        reason: "no tenant in this database yet",
        created: 0,
      });
    } finally {
      await empty.close();
    }
  } finally {
    await only.close();
  }
});

async function expectCounts(tenantId: string, offices: number, contacts: number): Promise<void> {
  await expectCountsOn(h, tenantId, offices, contacts);
}

async function expectCountsOn(
  db: Harness,
  tenantId: string,
  offices: number,
  contacts: number,
): Promise<void> {
  const rows = await db.db.withTenant(tenantId, (client) =>
    client.query<{ offices: string; contacts: string }>(
      `SELECT (SELECT count(*)::text FROM projects.jurisdictions) AS offices,
              (SELECT count(*)::text FROM projects.jurisdiction_contacts) AS contacts`,
    ),
  );
  expect(Number(rows.rows[0]?.offices)).toBe(offices);
  expect(Number(rows.rows[0]?.contacts)).toBe(contacts);
}

async function expectOffice(tenantId: string, name: string, contacts: number): Promise<void> {
  const detail = await officeDetail(tenantId, name);
  expect(detail.contacts).toHaveLength(contacts);
}

async function officeDetail(
  tenantId: string,
  name: string,
): Promise<{ notes: string | null; contacts: Array<{ name: string; title: string | null }> }> {
  const found = await h.db.withTenant(tenantId, (db) =>
    db.query<{ id: string }>(
      `SELECT id::text AS id FROM projects.jurisdictions WHERE name = $1`,
      [name],
    ),
  );
  const owner = (await tenantToken(tenantId));
  const detail = await h.as(owner).get(base + "/jurisdictions/" + found.rows[0]!.id);
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  return detail.body.data;
}

const tokens = new Map<string, string>();

async function tenantToken(tenantId: string): Promise<string> {
  const cached = tokens.get(tenantId);
  if (cached) return cached;
  const staff = await h.db.withTenant(tenantId, (db) =>
    db.query<{ id: string }>(
      `SELECT id::text AS id FROM projects.staff WHERE role = 'owner' LIMIT 1`,
    ),
  );
  const token = h.sessions.issue({ tenantId, staffId: staff.rows[0]!.id });
  tokens.set(tenantId, token);
  return token;
}
