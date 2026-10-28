import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrHandoffHtml } from "../client/handoff.js";
import { handoffWriteSchema, serviceTitanHandoff } from "../src/domain/csrHandoff.js";
import {
  normalizeServiceTitanContact,
  pickServiceTitanContact,
  type ServiceTitanContactSource,
} from "../src/domain/stCustomerContacts.js";
import { refreshLinkedProject } from "../src/workers/laborRefresh.js";
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const fixture = JSON.parse(
  readFileSync("test/fixtures/st-crm/customer-location-contacts.json", "utf8"),
) as {
  customer: { data: ServiceTitanContactSource[] };
  location: { data: ServiceTitanContactSource[] };
};

function listed(rows: ServiceTitanContactSource[]) {
  return rows.flatMap((row) => {
    const contact = normalizeServiceTitanContact(row);
    return contact ? [contact] : [];
  });
}

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

describe("ServiceTitan contact mapping", () => {
  const customer = listed(fixture.customer.data);
  const location = listed(fixture.location.data);

  it("prefers the primary mobile and primary email, and skips blank, fax, and opted-out rows", () => {
    expect(customer.some((contact) => contact.value.trim() === "")).toBe(false);
    expect(customer.find((contact) => contact.value === "804-555-0111")).toMatchObject({
      optedOut: false,
      doNotText: true,
    });
    expect(customer.find((contact) => contact.value === "old@example.test")?.optedOut).toBe(true);
    expect(pickServiceTitanContact([...customer, ...location])).toEqual({
      phone: "804-555-0177",
      email: "linh.nguyen@example.test",
      doNotText: false,
    });
    expect(pickServiceTitanContact(location)).toEqual({
      phone: "757-555-0101",
      email: "site@example.test",
      doNotText: false,
    });
    expect(pickServiceTitanContact([])).toEqual({ phone: null, email: null, doNotText: false });
    const blocked = normalizeServiceTitanContact({
      type: "Phone",
      value: "804-555-0000",
      doNotContact: true,
    });
    expect(blocked?.optedOut).toBe(true);
    expect(pickServiceTitanContact(blocked ? [blocked] : [])).toEqual({
      phone: null,
      email: null,
      doNotText: false,
    });
  });

  it("keeps a do-not-text phone and ranks a Phone memo of cell or mobile as a mobile", () => {
    const textOff = normalizeServiceTitanContact({
      type: "Phone",
      value: "804-555-0111",
      memo: "home",
      phoneSettings: { doNotText: true },
    });
    expect(textOff).toMatchObject({ optedOut: false, doNotText: true });
    expect(pickServiceTitanContact(textOff ? [textOff] : [])).toEqual({
      phone: "804-555-0111",
      email: null,
      doNotText: true,
    });
    const cell = normalizeServiceTitanContact({ type: "Phone", value: "804-555-0166", memo: "Cell--Tina" });
    const writtenMobile = normalizeServiceTitanContact({ type: "Phone", value: "804-555-0188", memo: "mobile" });
    const primaryLandline = normalizeServiceTitanContact({ type: "Phone", value: "804-555-0100", memo: "primary" });
    const primaryMobile = normalizeServiceTitanContact({
      type: "MobilePhone",
      value: "804-555-0177",
      memo: "primary",
    });
    expect(pickServiceTitanContact([primaryLandline, cell].filter((row) => row != null))).toEqual({
      phone: "804-555-0166",
      email: null,
      doNotText: false,
    });
    expect(pickServiceTitanContact([writtenMobile, cell, primaryMobile].filter((row) => row != null))).toEqual({
      phone: "804-555-0177",
      email: null,
      doNotText: false,
    });
    const view = serviceTitanHandoff({
      sourceCustomerName: "Linh Nguyen",
      addressLine1: null,
      city: null,
      region: null,
      postalCode: null,
      businessUnitName: null,
      sourceProjectSummary: null,
      scheduledStart: null,
      scheduledEnd: null,
      externalProjectId: null,
      snapshot: { customer: { contacts: textOff ? [textOff] : [] } },
      linked: true,
      estimateAmount: null,
      soldAmount: null,
    });
    expect(view.phone).toBe("804-555-0111");
    expect(view.phone_do_not_text).toBe(true);
    const html = csrHandoffHtml(
      {
        saved: false,
        fields: {},
        service_titan: view,
      },
      { esc, canSave: true },
    );
    expect(html).toContain("804-555-0111");
    expect(html).toContain("Do not text");
    expect(html).not.toContain('id="csr-phone"');
  });

  it("shows the picked contact read-only and still rejects a typed phone or email", () => {
    const picked = pickServiceTitanContact([...customer, ...location]);
    const view = serviceTitanHandoff({
      sourceCustomerName: "Linh Nguyen",
      addressLine1: "3102 Parkwood Avenue",
      city: "Richmond",
      region: "VA",
      postalCode: "23221",
      businessUnitName: "Richmond",
      sourceProjectSummary: null,
      scheduledStart: null,
      scheduledEnd: null,
      externalProjectId: "44821",
      snapshot: {
        customer: { id: "300", name: "Linh Nguyen", contacts: customer },
        location: { id: "400", contacts: location },
      },
      linked: true,
      estimateAmount: null,
      soldAmount: null,
    });
    expect(view.phone).toBe(picked.phone);
    expect(view.email).toBe(picked.email);
    const html = csrHandoffHtml(
      { saved: false, status: null, fields: { office: "richmond" }, service_titan: {
        customer_name: view.customer_name,
        phone: view.phone,
        email: view.email,
        service_address: view.service_address,
        estimate_amount: null,
        sold_amount: null,
      } },
      { esc, canSave: true },
    );
    expect(html).toContain("804-555-0177");
    expect(html).toContain("linh.nguyen@example.test");
    expect(html).not.toContain('id="csr-phone"');
    expect(html).not.toContain('id="csr-email"');
    expect(html).toContain('data-st-field="sold_amount"');
    expect(handoffWriteSchema.safeParse({
      office: "richmond",
      lead_source: "",
      scope_summary: "Tub to shower.",
      handoff_project_ref: "",
      target_start_window: "",
      access_notes: "",
      decision_maker_notes: "",
      permits_likely: "",
      submit: false,
      phone: "804-555-0177",
      email: "linh.nguyen@example.test",
    }).success).toBe(false);
  });
});

describe("nightly refresh stores customer contacts", () => {
  let h: Harness;
  let t: TenantFixture;
  let projectId = "";
  const systemId = "33333333-3333-4333-8333-333333333333";
  const readCustomerContacts = async () => ({
    ok: true,
    customerContacts: listed(fixture.customer.data),
    locationContacts: listed(fixture.location.data),
    warnings: [] as string[],
  });
  const conn = {
    tenantId: "",
    externalSystemId: systemId,
    key: "st:test",
    client: {
      readJobTimesheets: async () => ({ forbidden: false, timesheets: [] }),
      readCustomerContacts,
    },
  };

  beforeAll(async () => {
    h = await startHarness(undefined, { serviceTitan: conn as never });
    t = await createTenant(h, { slug: "contact-nightly" });
    conn.tenantId = t.id;
    const created = await h.as(t.staff.owner!.token).post("/api/v1/projects/projects").send(
      projectBody({ project_number: "C-1", name: "Contact nightly" }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    projectId = created.body.data.id;
    await h.db.withTenant(t.id, async (db) => {
      await db.query(
        `INSERT INTO projects.external_systems (id, tenant_id, adapter_key, display_name)
         VALUES ($1, $2, 'servicetitan', 'ServiceTitan')`,
        [systemId, t.id],
      );
      await db.query(
        `INSERT INTO projects.st_project_connections
           (project_id, tenant_id, external_system_id, external_project_id, connection_key, snapshot, observed_at, linked_by)
         VALUES ($1, $2, $3, '44821', 'st:test', $4::jsonb, '2026-10-01T00:00:00Z', $5)`,
        [
          projectId,
          t.id,
          systemId,
          JSON.stringify({
            id: "44821",
            customerId: "300",
            locationId: "400",
            customer: { id: "300", name: "Linh Nguyen" },
            location: { id: "400", name: "Home" },
          }),
          t.staff.owner!.id,
        ],
      );
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  it("writes the picked phone and email onto the snapshot without moving observed_at", async () => {
    const { warnings } = await refreshLinkedProject(
      h.db,
      conn as never,
      t.id,
      projectId,
      new Date("2026-10-28T07:00:00Z"),
      { ok: false, reason: "missing", message: "test" },
      "scheduled",
    );
    expect(warnings.join(" ")).not.toMatch(/Customer contacts/);
    const row = await h.db.withTenant(t.id, (db) =>
      db.query<{ snapshot: { customer: { phone: string; email: string } }; observed_at: string }>(
        `SELECT snapshot, observed_at::text AS observed_at
           FROM projects.st_project_connections WHERE project_id = $1`,
        [projectId],
      ),
    );
    expect(row.rows[0]?.snapshot.customer.phone).toBe("804-555-0177");
    expect(row.rows[0]?.snapshot.customer.email).toBe("linh.nguyen@example.test");
    expect(row.rows[0]?.observed_at.startsWith("2026-10-01")).toBe(true);
  });
});
