import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createTenant,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const jsonFixture = readFileSync(path.join(fixtureDir, "permit-offices.json"), "utf8");
const csvFixture = readFileSync(path.join(fixtureDir, "permit-offices.csv"), "utf8");
const base = "/api/v1/projects";

let h: Harness;
let t: TenantFixture;
let other: TenantFixture;
const owner = () => h.as(t.staff.owner!.token);

beforeAll(async () => {
  h = await startHarness();
  t = await createTenant(h, { slug: "permit-offices" });
  other = await createTenant(h, { slug: "permit-offices-other" });
});

afterAll(async () => {
  await h?.close();
});

it("imports the trimmed JSON and CSV fixtures twice without changing the second copy", async () => {
  const first = await owner()
    .post(base + "/jurisdictions/import")
    .set("Content-Type", "application/json")
    .send(jsonFixture);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.data).toEqual({
    created: 2,
    updated: 0,
    contacts_upserted: 3,
    unchanged: 0,
  });

  const again = await owner()
    .post(base + "/jurisdictions/import")
    .set("Content-Type", "application/json")
    .send(jsonFixture);
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  expect(again.body.data).toEqual({
    created: 0,
    updated: 0,
    contacts_upserted: 0,
    unchanged: 2,
  });

  const csv = await owner()
    .post(base + "/jurisdictions/import")
    .set("Content-Type", "text/csv")
    .send(csvFixture);
  expect(csv.status, JSON.stringify(csv.body)).toBe(200);
  expect(csv.body.data).toEqual({
    created: 0,
    updated: 0,
    contacts_upserted: 0,
    unchanged: 2,
  });

  const list = await h.as(t.staff.estimator!.token).get(base + "/jurisdictions");
  expect(list.status).toBe(200);
  const richmond = (list.body.data as Array<{ name: string; state: string; contacts: Array<{ name: string; title: string; notes: string }> }>).find(
    (office) => office.name === "City of Richmond",
  );
  expect(richmond?.state).toBe("VA");
  expect(richmond?.contacts.map((contact) => [contact.name, contact.title, contact.notes])).toEqual([
    ["Alex Kim", "Plan reviewer", "handles residential plan review; call before 10am"],
    ["Jordan Lee", "Inspections", "afternoon inspections"],
  ]);
  expect(JSON.stringify(list.body)).not.toContain("source_urls");
  expect(JSON.stringify(list.body)).not.toContain("data_gaps");
});

it("keeps a contact the file does not mention and edits title and notes", async () => {
  const richmond = (
    (await owner().get(base + "/jurisdictions")).body.data as Array<{ id: string; name: string }>
  ).find((office) => office.name === "City of Richmond");
  const added = await owner()
    .post(base + `/jurisdictions/${richmond!.id}/contacts`)
    .send({
      name: "Local counter",
      title: "Clerk",
      phone: "804-555-0199",
      email: "counter@example.test",
      notes: "added in the office, not in the file",
    });
  expect(added.status, JSON.stringify(added.body)).toBe(201);

  const edited = await h
    .as(t.staff.pm!.token)
    .patch(base + "/jurisdiction-contacts/" + added.body.data.id)
    .send({ title: "Senior clerk", notes: "ask for the residential desk" });
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  expect(edited.body.data.title).toBe("Senior clerk");
  expect(edited.body.data.notes).toBe("ask for the residential desk");

  const imported = await owner()
    .post(base + "/jurisdictions/import")
    .set("Content-Type", "text/csv")
    .send(csvFixture);
  expect(imported.body.data.contacts_upserted).toBe(0);
  const detail = await owner().get(base + "/jurisdictions/" + richmond!.id);
  const names = (detail.body.data.contacts as Array<{ name: string; title: string }>).map(
    (contact) => [contact.name, contact.title],
  );
  expect(names).toContainEqual(["Local counter", "Senior clerk"]);
  expect(names).toContainEqual(["Alex Kim", "Plan reviewer"]);
});

it("rejects credential keys and unknown JSON, and accepts contact_role as a title", async () => {
  const secret = await owner()
    .post(base + "/jurisdictions/import")
    .send({
      offices: [{ municipality: "Nope", state: "VA" }],
      password: "do-not-store",
    });
  expect(secret.status).toBe(400);
  expect(JSON.stringify(secret.body)).not.toContain("do-not-store");

  const nested = await owner()
    .post(base + "/jurisdictions/import")
    .send({
      source_urls: [{ token: "do-not-store-either" }],
      offices: [{ municipality: "Nope", state: "VA" }],
    });
  expect(nested.status).toBe(400);
  expect(JSON.stringify(nested.body)).not.toContain("do-not-store-either");

  const extra = await owner()
    .post(base + "/jurisdictions/import")
    .send({
      offices: [{ municipality: "Nope", state: "VA" }],
      source_urls: ["https://example.test"],
      completeness: "partial",
      data_gaps: [],
      nickname: "not allowed",
    });
  expect(extra.status).toBe(400);

  const alias = await owner()
    .post(base + "/jurisdictions/import")
    .send({
      municipality: "Alias City",
      state: "nc",
      contacts: [{ name: "Riley Chen", contact_role: "Plans examiner", email: "riley@example.test" }],
    });
  expect(alias.status, JSON.stringify(alias.body)).toBe(200);
  expect(alias.body.data.created).toBe(1);
  const list = await owner().get(base + "/jurisdictions");
  const city = (list.body.data as Array<{ name: string; state: string; contacts: Array<{ title: string }> }>).find(
    (office) => office.name === "Alias City",
  );
  expect(city?.state).toBe("NC");
  expect(city?.contacts[0]?.title).toBe("Plans examiner");
});

it("requires a state, keeps one office per municipality and state, and limits who can edit", async () => {
  const missing = await owner()
    .post(base + "/jurisdictions")
    .send({ name: "No State" });
  expect(missing.status).toBe(400);

  const created = await h
    .as(t.staff.manager!.token)
    .post(base + "/jurisdictions")
    .send({
      name: "Chesterfield County",
      state: "VA",
      portal_url: "https://chesterfield.gov/permits",
      typical_review_days: 10,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.contacts).toEqual([]);

  const duplicate = await owner()
    .post(base + "/jurisdictions")
    .send({ name: "chesterfield county", state: "va" });
  expect(duplicate.status).toBe(409);

  const otherState = await owner()
    .post(base + "/jurisdictions")
    .send({ name: "Chesterfield County", state: "NC" });
  expect(otherState.status, JSON.stringify(otherState.body)).toBe(201);

  const badUrl = await owner()
    .patch(base + "/jurisdictions/" + created.body.data.id)
    .send({ website_url: "ftp://files.example.test/fees" });
  expect(badUrl.status).toBe(400);

  for (const role of ["office", "estimator", "bookkeeper"] as const) {
    const denied = await h
      .as(t.staff[role]!.token)
      .post(base + "/jurisdictions")
      .send({ name: "Blocked " + role, state: "VA" });
    expect(denied.status, role).toBe(403);
    expect(
      (await h.as(t.staff[role]!.token).get(base + "/jurisdictions")).status,
    ).toBe(200);
  }
  const session = await h.as(t.staff.office!.token).get(base + "/session");
  expect(session.body.data.capabilities).not.toContain("manage_permit_offices");
  expect(
    (await h.as(t.staff.pm!.token).get(base + "/session")).body.data.capabilities,
  ).toContain("manage_permit_offices");

  const foreign = await h
    .as(other.staff.owner!.token)
    .get(base + "/jurisdictions/" + created.body.data.id);
  expect(foreign.status).toBe(404);
});
