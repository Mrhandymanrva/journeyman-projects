import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrHandoffHtml } from "../client/handoff.js";
import { handoffListHtml } from "../client/home.js";
import { CAPABILITIES } from "../src/http/capabilities.js";
import {
  handoffWriteSchema,
  officeFromBusinessUnit,
  submitGaps,
  suggestHandoff,
  type HandoffFields,
} from "../src/domain/csrHandoff.js";
import { hasExecutableSql, splitSqlStatements } from "../src/db/splitSql.js";
import {
  addBusinessUnit,
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );

function form(overrides: Record<string, unknown> = {}, submit = true) {
  return {
    customer_name: "Ada Whitfield",
    phone: "804-555-0100",
    email: "",
    service_address: "4412 Grove Avenue, Richmond, VA 23221",
    office: "richmond",
    lead_source: "Referral",
    scope_summary: "Replace the tub with a tiled shower.",
    handoff_project_ref: "44821",
    handoff_estimate_amount: 17250,
    sold_amount: 18640,
    target_start_window: "2026-11-16 to 2026-11-30",
    access_notes: "Lockbox on the side door.",
    decision_maker_notes: "Ada decides.",
    permits_likely: "unknown",
    submit,
    ...overrides,
  } as HandoffFields & { submit: boolean };
}

describe("CSR hand-off validation", () => {
  it("requires name, phone or email, address, office, and scope", () => {
    expect(submitGaps({
      customer_name: "",
      phone: "",
      email: "",
      service_address: "",
      office: "",
      lead_source: "",
      scope_summary: "",
      handoff_project_ref: "",
      handoff_estimate_amount: null,
      sold_amount: null,
      target_start_window: "",
      access_notes: "",
      decision_maker_notes: "",
      permits_likely: "",
    })).toEqual([
      "customer_name",
      "phone_or_email",
      "service_address",
      "office",
      "scope_summary",
    ]);
    const phoneOnly = form({ email: "" });
    expect(submitGaps(phoneOnly)).toEqual([]);
    const emailOnly = form({ phone: "", email: "ada@example.test" });
    expect(submitGaps(emailOnly)).toEqual([]);
    expect(handoffWriteSchema.safeParse(form({ office: "norfolk" })).success).toBe(false);
    expect(handoffWriteSchema.safeParse(form({ permits_likely: "maybe" })).success).toBe(false);
    expect(handoffWriteSchema.safeParse(form({ email: "not-an-email" })).success).toBe(false);
    expect(handoffWriteSchema.safeParse(form({ phone: "555" })).success).toBe(false);
    expect(handoffWriteSchema.safeParse(form({ sold_amount: -1 })).success).toBe(false);
    expect(handoffWriteSchema.safeParse(form({ extra: true })).success).toBe(false);
  });

  it("prefills from the stored project and the linked customer snapshot", () => {
    expect(officeFromBusinessUnit("Hampton–Newport News")).toBe("hampton_newport_news");
    expect(officeFromBusinessUnit("Richmond")).toBe("richmond");
    const fields = suggestHandoff({
      sourceCustomerName: "Linh Nguyen",
      addressLine1: "3102 Parkwood Avenue",
      city: "Richmond",
      region: "VA",
      postalCode: "23221",
      businessUnitName: "Richmond",
      sourceProjectSummary: "Replace the hall bath tub with a tiled shower.",
      scheduledStart: "2026-11-16",
      scheduledEnd: "2026-11-30",
      contractValue: 18640,
      externalProjectId: "44821",
      estimateAmount: 17250,
      snapshot: {
        leadSource: "Referral",
        customer: { name: "Someone Else", phone: "804-555-0142", email: "linh.nguyen@example.test" },
      },
    });
    expect(fields.customer_name).toBe("Linh Nguyen");
    expect(fields.phone).toBe("804-555-0142");
    expect(fields.email).toBe("linh.nguyen@example.test");
    expect(fields.service_address).toBe("3102 Parkwood Avenue, Richmond, VA 23221");
    expect(fields.office).toBe("richmond");
    expect(fields.lead_source).toBe("Referral");
    expect(fields.scope_summary).toContain("tiled shower");
    expect(fields.handoff_project_ref).toBe("44821");
    expect(fields.handoff_estimate_amount).toBe(17250);
    expect(fields.sold_amount).toBe(18640);
    expect(fields.target_start_window).toBe("2026-11-16 to 2026-11-30");
  });

  it("renders the form, the waiting list, and an acknowledge action", () => {
    const html = csrHandoffHtml(
      {
        saved: false,
        status: null,
        fields: form(),
        gate: { gate_number: 0, title: "Qualification and handoff", status: "open" },
      },
      { esc, canSave: true },
    );
    expect(html).toContain("Customer name");
    expect(html).toContain("Scope summary");
    expect(html).toContain("ServiceTitan project #");
    expect(html).toContain("Estimate amount (ServiceTitan)");
    expect(html).toContain(
      "Internal handover of a sold job to the Project Coordinator. Doesn't send anything to ServiceTitan or Handoff.",
    );
    expect(html).not.toContain("Handoff project link / id");
    expect(html).not.toContain("Handoff estimate amount");
    expect(html).toContain("Permits likely");
    expect(html).toContain("Submit hand-off");
    expect(html).toContain("Nothing is emailed");
    expect(html).toContain("data-gate-status=\"open\"");
    const done = csrHandoffHtml(
      {
        saved: true,
        status: "submitted",
        fields: form(),
        gate: { gate_number: 0, title: "Qualification and handoff", status: "approved" },
      },
      { esc, canSave: false },
    );
    expect(done).toContain("Gate 0, Qualification and handoff, is complete.");
    expect(done).not.toContain("Submit hand-off");
    const list = handoffListHtml(
      [
        {
          project_id: "p1",
          project_name: "Brooks — Powder Room",
          customer_name: "Mara Brooks",
          office: "richmond",
          scope_summary: "Powder room.",
          submitted_at: "2026-10-26T15:00:00.000Z",
          href: "/?project=p1#dashboard",
        },
      ],
      esc,
      true,
    );
    expect(list).toContain("Acknowledge");
    expect(list).toContain("Richmond");
    expect(list).toContain("Brooks — Powder Room");
    expect(handoffListHtml([], esc, true)).toContain("No hand-offs are waiting.");
    expect(handoffListHtml([{ project_id: "p1", project_name: "Brooks", href: "/?project=p1#dashboard" }], esc, false)).not.toContain("Acknowledge");
  });
});

describe("CSR hand-off flow", () => {
  let h: Harness;
  let n = 0;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  async function project(t: TenantFixture, overrides: Record<string, unknown> = {}) {
    const created = await h
      .as(t.staff.owner!.token)
      .post("/api/v1/projects/projects")
      .send(projectBody(overrides));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.data.id as string;
  }

  async function gate0(t: TenantFixture, id: string) {
    const gates = await h.as(t.staff.owner!.token).get(`/api/v1/projects/projects/${id}/gates`);
    expect(gates.status).toBe(200);
    return (gates.body.data as Array<{ gate_number: number; title: string; status: string }>).find(
      (gate) => gate.gate_number === 0,
    );
  }

  it("lets office save, refuses other roles, and completes Gate 0 on submit", async () => {
    const t = await createTenant(h, { slug: `hand-save-${n++}` });
    const id = await project(t, { project_number: `HO-${n}`, name: "Hall Bath" });
    const office = h.as(t.staff.office!.token);
    const session = await office.get("/api/v1/projects/session");
    const officeCaps = Object.entries(CAPABILITIES)
      .filter(([, roles]) => (roles as readonly string[]).includes("office"))
      .map(([name]) => name);
    expect(officeCaps.sort()).toEqual([
      "create_project",
      "manage_project_documents",
      "manage_vendors",
      "record_external_invoice",
      "save_csr_handoff",
    ]);
    expect(new Set(session.body.data.capabilities)).toEqual(new Set(officeCaps));
    expect(session.body.data.capabilities).not.toContain("acknowledge_csr_handoff");
    expect(session.body.data.capabilities).not.toContain("advance_stage");
    expect(session.body.data.capabilities).not.toContain("manage_precon_tasks");
    const pmSession = await h.as(t.staff.pm!.token).get("/api/v1/projects/session");
    expect(pmSession.body.data.capabilities).toContain("acknowledge_csr_handoff");

    const draft = await office
      .put(`/api/v1/projects/projects/${id}/handoff`)
      .send(form({ customer_name: "", phone: "", email: "", scope_summary: "" }, false));
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    expect(draft.body.data.status).toBe("draft");
    expect((await gate0(t, id))?.status).toBe("open");

    const missing = await office
      .put(`/api/v1/projects/projects/${id}/handoff`)
      .send(form({ phone: "", email: "" }, true));
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).toContain("phone_or_email");
    expect((await gate0(t, id))?.status).toBe("open");

    const bad = await office
      .put(`/api/v1/projects/projects/${id}/handoff`)
      .send(form({ office: "norfolk" }));
    expect(bad.status).toBe(400);

    for (const role of ["estimator", "bookkeeper"] as const) {
      const denied = await h
        .as(t.staff[role]!.token)
        .put(`/api/v1/projects/projects/${id}/handoff`)
        .send(form());
      expect(denied.status, role).toBe(403);
    }

    await h.db.withTenant(t.id, (db) =>
      db.query(
        `UPDATE projects.stage_gates
            SET checklist = '[{"key":"signed","label":"Signed","done":false}]'::jsonb
          WHERE project_id = $1 AND gate_number = 0`,
        [id],
      ),
    );

    const emailOnly = await office
      .put(`/api/v1/projects/projects/${id}/handoff`)
      .send(form({ phone: "", email: "ada@example.test" }));
    expect(emailOnly.status, JSON.stringify(emailOnly.body)).toBe(200);
    expect(emailOnly.body.data.status).toBe("submitted");
    expect(emailOnly.body.data.gate).toMatchObject({
      gate_number: 0,
      title: "Qualification and handoff",
      status: "approved",
    });
    expect(emailOnly.body.data).not.toHaveProperty("email_sent");
    expect((await gate0(t, id))?.status).toBe("approved");

    const phoneOnlyId = await project(t, { project_number: `HO-PH-${n}`, name: "Phone Only" });
    const phoneOnly = await office
      .put(`/api/v1/projects/projects/${phoneOnlyId}/handoff`)
      .send(form({ email: "" }));
    expect(phoneOnly.status, JSON.stringify(phoneOnly.body)).toBe(200);
    expect((await gate0(t, phoneOnlyId))?.status).toBe("approved");

    const rejected = await h
      .as(t.staff.manager!.token)
      .post(`/api/v1/projects/projects/${id}/gates/0/reject`)
      .send({ note: "Need a clearer scope." });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((await gate0(t, id))?.status).toBe("rejected");
    const kept = await office
      .put(`/api/v1/projects/projects/${id}/handoff`)
      .send(form({ email: "ada@example.test", phone: "" }, false));
    expect(kept.status).toBe(200);
    expect((await gate0(t, id))?.status).toBe("rejected");
    const again = await office
      .put(`/api/v1/projects/projects/${id}/handoff`)
      .send(form({ email: "ada@example.test", phone: "" }, true));
    expect(again.status).toBe(200);
    expect((await gate0(t, id))?.status).toBe("approved");

    const advance = await h
      .as(t.staff.owner!.token)
      .post(`/api/v1/projects/projects/${id}/stage`)
      .send({ stage: "precon" });
    expect(advance.status, JSON.stringify(advance.body)).toBe(200);
    const late = await office
      .put(`/api/v1/projects/projects/${id}/handoff`)
      .send(form({ email: "ada@example.test", phone: "" }));
    expect(late.status).toBe(409);
  });

  it("lists submitted hand-offs and lets the project coordinator acknowledge them", async () => {
    const t = await createTenant(h, { slug: `hand-list-${n++}` });
    const other = await createTenant(h, { slug: `hand-other-${n++}` });
    const waiting = await project(t, { project_number: `HO-W-${n}`, name: "Powder Room" });
    const draftId = await project(t, { project_number: `HO-D-${n}`, name: "Still Draft" });
    const foreign = await project(other, { project_number: `HO-F-${n}`, name: "Other Tenant" });
    const office = h.as(t.staff.office!.token);
    expect(
      (await office.put(`/api/v1/projects/projects/${waiting}/handoff`).send(form())).status,
    ).toBe(200);
    expect(
      (
        await office
          .put(`/api/v1/projects/projects/${draftId}/handoff`)
          .send(form({ customer_name: "Pat" }, false))
      ).status,
    ).toBe(200);
    expect(
      (await h.as(other.staff.office!.token).put(`/api/v1/projects/projects/${foreign}/handoff`).send(form())).status,
    ).toBe(200);

    const listed = await office.get("/api/v1/projects/home/handoffs");
    expect(listed.status).toBe(200);
    expect(listed.body.data.count).toBe(1);
    expect(listed.body.data.items.map((row: { project_id: string }) => row.project_id)).toEqual([
      waiting,
    ]);
    expect(listed.body.data.items[0].customer_name).toBe("Ada Whitfield");
    expect(listed.body.data.items[0].office_label).toBe("Richmond");

    const hidden = await h.as(other.staff.office!.token).get("/api/v1/projects/home/handoffs");
    expect(hidden.body.data.items.map((row: { project_id: string }) => row.project_id)).toEqual([
      foreign,
    ]);
    expect(
      (await h.as(other.staff.owner!.token).get(`/api/v1/projects/projects/${waiting}/handoff`)).status,
    ).toBe(404);
    expect((await h.request.get("/api/v1/projects/home/handoffs")).status).toBe(401);

    for (const role of ["office", "owner", "manager", "estimator"] as const) {
      const denied = await h
        .as(t.staff[role]!.token)
        .post(`/api/v1/projects/projects/${waiting}/handoff/acknowledge`);
      expect(denied.status, role).toBe(403);
    }
    const early = await h
      .as(t.staff.pm!.token)
      .post(`/api/v1/projects/projects/${draftId}/handoff/acknowledge`);
    expect(early.status).toBe(409);

    const acked = await h
      .as(t.staff.pm!.token)
      .post(`/api/v1/projects/projects/${waiting}/handoff/acknowledge`);
    expect(acked.status, JSON.stringify(acked.body)).toBe(200);
    expect(acked.body.data.acknowledged_by_name).toBe("pm");
    expect(acked.body.data.status).toBe("submitted");
    const again = await h
      .as(t.staff.pm!.token)
      .post(`/api/v1/projects/projects/${waiting}/handoff/acknowledge`);
    expect(again.status).toBe(200);
    expect(again.body.data.acknowledged_by_name).toBe("pm");
    const after = await office.get("/api/v1/projects/home/handoffs");
    expect(after.body.data.count).toBe(0);
    expect(after.body.data.items).toEqual([]);
  });

  it("hides another business unit's hand-off from a scoped office user", async () => {
    const t = await createTenant(h, {
      slug: `hand-unit-${n++}`,
      unitName: "Richmond",
      enforceBusinessUnitScoping: true,
      staff: [
        { key: "owner", email: `owner-unit-${n}@example.test`, role: "owner" },
        { key: "pm", email: `pm-unit-${n}@example.test`, role: "project_manager" },
        { key: "office", email: `office-unit-${n}@example.test`, role: "office", unit: "Richmond" },
      ],
    });
    const hampton = await addBusinessUnit(h, t, "Hampton-Newport News");
    const owner = h.as(t.staff.owner!.token);
    const away = await project(t, {
      project_number: `HO-HAM-${n}`,
      name: "Hampton Job",
      business_unit_id: hampton,
    });
    const home = await project(t, {
      project_number: `HO-RIC-${n}`,
      name: "Richmond Job",
      business_unit_id: t.businessUnits.Richmond,
    });
    expect((await owner.put(`/api/v1/projects/projects/${away}/handoff`).send(form({ office: "hampton_newport_news" }))).status).toBe(200);
    expect((await owner.put(`/api/v1/projects/projects/${home}/handoff`).send(form())).status).toBe(200);
    const office = h.as(t.staff.office!.token);
    const list = await office.get("/api/v1/projects/home/handoffs");
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((row: { project_id: string }) => row.project_id)).toEqual([home]);
    expect((await office.get(`/api/v1/projects/projects/${away}/handoff`)).status).toBe(404);
    expect((await office.get(`/api/v1/projects/projects/${home}/handoff`)).status).toBe(200);
  });

  it("prefills a linked ServiceTitan snapshot without calling ServiceTitan", async () => {
    const t = await createTenant(h, { slug: `hand-prefill-${n++}` });
    const id = await project(t, {
      project_number: `HO-PRE-${n}`,
      name: "Nguyen Hall Bath",
      address_line1: "3102 Parkwood Avenue",
      city: "Richmond",
      region: "VA",
      postal_code: "23221",
    });
    const richmond = await addBusinessUnit(h, t, "Richmond");
    await h.db.withTenant(t.id, async (db) => {
      await db.query(
        `UPDATE projects.projects
            SET business_unit_id = $2,
                source_customer_name = 'Linh Nguyen',
                source_project_summary = 'Replace the hall bath tub with a tiled shower.',
                contract_value = 18640,
                scheduled_start = '2026-11-16',
                scheduled_end = '2026-11-30'
          WHERE id = $1`,
        [id, richmond],
      );
      const system = await db.query<{ id: string }>(
        `SELECT id FROM projects.external_systems LIMIT 1`,
      );
      await db.query(
        `INSERT INTO projects.st_project_connections
           (project_id, tenant_id, external_system_id, external_project_id, connection_key,
            snapshot, observed_at, linked_by)
         VALUES ($1,$2,$3,'44821','test', $4::jsonb, now(), $5)`,
        [
          id,
          t.id,
          system.rows[0]!.id,
          JSON.stringify({
            id: "44821",
            leadSource: "Referral",
            customer: {
              name: "Linh Nguyen",
              phone: "804-555-0142",
              email: "linh.nguyen@example.test",
            },
          }),
          t.staff.owner!.id,
        ],
      );
      await db.query(
        `INSERT INTO projects.st_estimate_observations
           (tenant_id, project_id, external_system_id, external_estimate_id, name,
            status, customer_amount, classification)
         VALUES ($1,$2,$3,'est-prefill','Hall bath','Open',17250,'original')`,
        [t.id, id, system.rows[0]!.id],
      );
    });
    const view = await h.as(t.staff.office!.token).get(`/api/v1/projects/projects/${id}/handoff`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.data.saved).toBe(false);
    expect(view.body.data.fields).toMatchObject({
      customer_name: "Linh Nguyen",
      phone: "804-555-0142",
      email: "linh.nguyen@example.test",
      service_address: "3102 Parkwood Avenue, Richmond, VA 23221",
      office: "richmond",
      lead_source: "Referral",
      scope_summary: "Replace the hall bath tub with a tiled shower.",
      handoff_project_ref: "44821",
      handoff_estimate_amount: 17250,
      sold_amount: 18640,
      target_start_window: "2026-11-16 to 2026-11-30",
    });
    const route = readFileSync("src/routes/csrHandoff.ts", "utf8");
    const domain = readFileSync("src/domain/csrHandoff.ts", "utf8");
    expect(route).not.toContain("fetch(");
    expect(domain).not.toContain("fetch(");
    expect(route + domain).not.toMatch(/nodemailer|mailto:/);
  });

  it("reapplies the hand-off migration without dropping a saved row", async () => {
    const t = await createTenant(h, { slug: `hand-migrate-${n++}` });
    const id = await project(t, { project_number: `HO-MIG-${n}`, name: "Migration" });
    const saved = await h
      .as(t.staff.office!.token)
      .put(`/api/v1/projects/projects/${id}/handoff`)
      .send(form({}, false));
    expect(saved.status).toBe(200);
    const sql = readFileSync("db/057_csr_handoff.sql", "utf8");
    for (let pass = 0; pass < 2; pass++) {
      for (const statement of splitSqlStatements(sql)) {
        if (!hasExecutableSql(statement.text)) continue;
        try {
          await h.db.asOwner((db) => db.query(statement.text));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/already exists/i.test(message)) continue;
          throw new Error(`057:${statement.startLine} ${message}`);
        }
      }
    }
    const row = await h.db.withTenant(t.id, (db) =>
      db.query<{ customer_name: string; status: string }>(
        `SELECT customer_name, status FROM projects.csr_handoffs WHERE project_id = $1`,
        [id],
      ),
    );
    expect(row.rows).toEqual([{ customer_name: "Ada Whitfield", status: "draft" }]);
  });
});
