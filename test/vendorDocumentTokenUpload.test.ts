import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import {
  createTenant,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

/**
 * The portfolio bearer (PM_PORTFOLIO_TOKEN, the JOURNEYMAN_TOKEN the service
 * presents) may upload a vendor document. It must not verify one, and it must
 * not reach any other staff route.
 */
const TOKEN = "journeyman-service-token-for-tests-01";
const FINGERPRINT = createHash("sha256").update(TOKEN).digest("hex").slice(0, 16);
const base = "/api/v1/projects";

let h: Harness;
let mine: TenantFixture;
let theirs: TenantFixture;
let vendor: string;
let foreignVendor: string;

function pdf(size = 32): Buffer {
  const buf = Buffer.alloc(size);
  Buffer.from("%PDF-1.7\nCOI").copy(buf);
  return buf;
}

function uploadBody(patch: Record<string, unknown> = {}) {
  return {
    kind: "gl_insurance",
    coverage_kinds: ["gl_insurance", "wc_insurance"],
    expires_on: "2027-06-01",
    issued_on: "2026-06-01",
    file_name: "coi.pdf",
    media_type: "application/pdf",
    content: pdf().toString("base64"),
    notes: "Carrier portal, policy GL-100.",
    ...patch,
  };
}

function api() {
  return supertest(
    createApp({
      database: h.db,
      staffSessions: h.sessions,
      serveConsole: false,
      portfolio: { tenantId: mine.id, token: TOKEN },
    }),
  );
}

const withToken = (r: supertest.Test) => r.set("Authorization", `Bearer ${TOKEN}`);
const asOwner = (r: supertest.Test) =>
  r.set("Authorization", `Bearer ${mine.staff.owner!.token}`);

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return (value ?? {}) as Record<string, unknown>;
}

async function documentRow(id: string) {
  const { rows } = await h.db.withTenant(mine.id, (db) =>
    db.query<Record<string, unknown>>(
      `SELECT verify_method, verified_by, verified_at, notes, file_size, kind::text AS kind, expires_on::text AS expires_on
         FROM projects.vendor_documents WHERE id = $1`,
      [id],
    ),
  );
  return rows[0];
}

async function auditRows(documentId: string) {
  const { rows } = await h.db.withTenant(mine.id, (db) =>
    db.query<Record<string, unknown>>(
      `SELECT id, actor_type, actor_id, entity_table, entity_id, action, after_data, occurred_at
         FROM projects.audit_log
        WHERE entity_table = 'vendor_documents' AND entity_id = $1
        ORDER BY id`,
      [documentId],
    ),
  );
  return rows;
}

beforeAll(async () => {
  h = await startHarness();
  mine = await createTenant(h, { slug: "token-upload" });
  theirs = await createTenant(h, { slug: "token-upload-other" });
  vendor = (
    await h
      .as(mine.staff.owner!.token)
      .post(base + "/vendors")
      .send({ legal_name: "COI Electric", email: "coi-electric@example.test", trades: ["Electrical"] })
  ).body.data.id;
  foreignVendor = (
    await h
      .as(theirs.staff.owner!.token)
      .post(base + "/vendors")
      .send({ legal_name: "Other Tile", email: "other-tile@example.test", trades: ["Tile"] })
  ).body.data.id;
});

afterAll(async () => {
  await h?.close();
});

describe("service token vendor document upload", () => {
  it("uploads a COI, stores notes, leaves verification empty, and appends an audit row", async () => {
    const body = uploadBody({
      verify_method: "Accepted by the portal",
      verified_by: mine.staff.owner!.id,
      verified_at: "2026-10-01T00:00:00.000Z",
      verified: true,
    });
    const res = await withToken(
      api().post(`${base}/vendors/${vendor}/documents/upload`),
    ).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.verify_method).toBeNull();
    expect(res.body.data.verified_by).toBeNull();
    expect(res.body.data.verified_at).toBeNull();
    expect(res.body.data.notes).toBe(body.notes);
    expect(res.body.data.file_name).toBe("coi.pdf");
    expect(Number(res.body.data.file_size)).toBe(pdf().length);

    const stored = await documentRow(res.body.data.id);
    expect(stored?.verify_method).toBeNull();
    expect(stored?.verified_by).toBeNull();
    expect(stored?.verified_at).toBeNull();
    expect(stored?.notes).toBe(body.notes);
    expect(stored?.kind).toBe("gl_insurance");
    expect(String(stored?.expires_on).slice(0, 10)).toBe("2027-06-01");

    const audit = await auditRows(res.body.data.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "system",
      actor_id: null,
      entity_table: "vendor_documents",
      entity_id: res.body.data.id,
      action: "vendor_document_token_upload",
    });
    const after = jsonObject(audit[0]!.after_data);
    expect(after).toMatchObject({
      token_identity: "JOURNEYMAN_TOKEN",
      token_fingerprint: FINGERPRINT,
      vendor_id: vendor,
      doc_type: "gl_insurance",
      size: pdf().length,
      expires_on: "2027-06-01",
    });
    expect(typeof after.uploaded_at).toBe("string");
    expect(audit[0]!.occurred_at).toBeTruthy();
    expect(JSON.stringify(after)).not.toContain(TOKEN);

    const again = await withToken(
      api().post(`${base}/vendors/${vendor}/documents/upload`),
    ).send(uploadBody({ file_name: "coi-2.pdf", notes: "Replacement certificate." }));
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const firstAfter = await auditRows(res.body.data.id);
    const second = await auditRows(again.body.data.id);
    expect(firstAfter).toHaveLength(1);
    expect(firstAfter[0]!.id).toBe(audit[0]!.id);
    expect(jsonObject(firstAfter[0]!.after_data)).toEqual(after);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(audit[0]!.id);

    const listed = await withToken(api().get("/api/v1/portfolio/vendors"));
    expect(listed.status).toBe(200);
    const row = listed.body.data.vendors.find((v: { id: string }) => v.id === vendor);
    const doc = row.documents.find((d: { notes: string }) => d.notes === body.notes);
    expect(doc.verified_at).toBeNull();
    expect(doc.has_file).toBe(true);
    expect(String(doc.expires_on).slice(0, 10)).toBe("2027-06-01");

    const denied = await withToken(
      api().patch(`${base}/vendors/${vendor}/documents/${res.body.data.id}`),
    ).send({ verify_method: "Accepted by the portal" });
    expect(denied.status).toBe(401);
    expect((await documentRow(res.body.data.id))?.verify_method).toBeNull();

    const reviewed = await asOwner(
      api().patch(`${base}/vendors/${vendor}/documents/${res.body.data.id}`),
    ).send({ verify_method: "Called the carrier and confirmed the policy" });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    expect(reviewed.body.data.verify_method).toBe(
      "Called the carrier and confirmed the policy",
    );
  });

  it("rejects an oversized decoded file and does not store or audit it", async () => {
    const before = await h.db.withTenant(mine.id, (db) =>
      db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM projects.vendor_documents WHERE vendor_id = $1",
        [vendor],
      ),
    );
    const audits = await h.db.withTenant(mine.id, (db) =>
      db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM projects.audit_log WHERE action = 'vendor_document_token_upload'",
        [],
      ),
    );
    const res = await withToken(
      api().post(`${base}/vendors/${vendor}/documents/upload`),
    ).send(
      uploadBody({
        content: pdf(8 * 1024 * 1024 + 1).toString("base64"),
        notes: "too big",
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(413);
    expect(res.body.error.code).toBe("payload_too_large");
    expect(res.body.error.message).toBe("Decoded file is larger than 8 MB.");
    const after = await h.db.withTenant(mine.id, (db) =>
      db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM projects.vendor_documents WHERE vendor_id = $1",
        [vendor],
      ),
    );
    const auditsAfter = await h.db.withTenant(mine.id, (db) =>
      db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM projects.audit_log WHERE action = 'vendor_document_token_upload'",
        [],
      ),
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(auditsAfter.rows[0]!.n).toBe(audits.rows[0]!.n);
  });

  it("rejects insurance and COI uploads that have no expiration date", async () => {
    for (const kind of ["gl_insurance", "wc_insurance", "auto_insurance"] as const) {
      const res = await withToken(
        api().post(`${base}/vendors/${vendor}/documents/upload`),
      ).send(
        uploadBody({
          kind,
          coverage_kinds: [kind],
          expires_on: null,
          notes: "missing expiry",
        }),
      );
      expect(res.status, kind + JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.message).toMatch(/expiration/i);
    }
    const omitted = await withToken(
      api().post(`${base}/vendors/${vendor}/documents/upload`),
    ).send(uploadBody({ expires_on: undefined }));
    expect(omitted.status).toBe(400);
  });

  it("still accepts a non-insurance document without an expiration date", async () => {
    const res = await withToken(
      api().post(`${base}/vendors/${vendor}/documents/upload`),
    ).send(
      uploadBody({
        kind: "license",
        coverage_kinds: undefined,
        expires_on: null,
        issued_on: null,
        notes: null,
        file_name: "license.pdf",
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.expires_on).toBeNull();
    expect(res.body.data.notes).toBeNull();
    expect(res.body.data.verify_method).toBeNull();
    const audit = jsonObject((await auditRows(res.body.data.id))[0]!.after_data);
    expect(audit.doc_type).toBe("license");
    expect(audit.expires_on).toBeNull();
  });

  it("does not let the service token call other staff-only routes", async () => {
    const projectId = "00000000-0000-4000-8000-000000000099";
    const attempts = [
      withToken(api().get(`${base}/vendors`)),
      withToken(api().get(`${base}/vendors/${vendor}`)),
      withToken(api().post(`${base}/vendors`)).send({
        legal_name: "Should Not Create",
        email: "nope@example.test",
      }),
      withToken(api().patch(`${base}/vendors/${vendor}`)).send({ phone: "555-0000" }),
      withToken(api().post(`${base}/projects`)).send({ name: "Nope" }),
      withToken(api().post(`${base}/projects/${projectId}/material-bills`)).send({}),
      withToken(api().get(`${base}/vendors/${vendor}/documents/00000000-0000-4000-8000-000000000099/file`)),
      api().post(`${base}/vendors/${vendor}/documents/upload`).send(uploadBody()),
      withToken(api().post(`${base}/vendors/${vendor}/documents/upload`)).set(
        "Authorization",
        "Bearer not-the-service-token",
      ),
    ];
    const statuses = await Promise.all(attempts.map(async (r) => (await r).status));
    expect(statuses).toEqual([401, 401, 401, 401, 401, 401, 401, 401, 401]);

    const foreign = await withToken(
      api().post(`${base}/vendors/${foreignVendor}/documents/upload`),
    ).send(uploadBody());
    expect(foreign.status).toBe(404);
  });

  it("keeps staff upload, review, and rejection behavior", async () => {
    const staffBody = {
      kind: "gl_insurance",
      expires_on: "2028-01-15",
      file_name: "staff-coi.pdf",
      media_type: "application/pdf",
      content: pdf().toString("base64"),
    };
    const uploaded = await asOwner(
      api().post(`${base}/vendors/${vendor}/documents/upload`),
    ).send(staffBody);
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    expect(uploaded.body.data.file_name).toBe("staff-coi.pdf");
    expect(uploaded.body.data.notes).toBeNull();
    expect(uploaded.body.data.verify_method).toBeNull();
    expect(await auditRows(uploaded.body.data.id)).toHaveLength(0);

    const withNotes = await asOwner(
      api().post(`${base}/vendors/${vendor}/documents/upload`),
    ).send({ ...staffBody, file_name: "staff-noted.pdf", notes: "Filed by the office." });
    expect(withNotes.status, JSON.stringify(withNotes.body)).toBe(201);
    expect(withNotes.body.data.notes).toBe("Filed by the office.");
    expect((await documentRow(withNotes.body.data.id))?.verify_method).toBeNull();
    expect(await auditRows(withNotes.body.data.id)).toHaveLength(0);

    const sneaky = await asOwner(
      api().post(`${base}/vendors/${vendor}/documents/upload`),
    ).send({ ...staffBody, verify_method: "Skipped review" });
    expect(sneaky.status).toBe(400);

    const noExpiry = await asOwner(
      api().post(`${base}/vendors/${vendor}/documents/upload`),
    ).send({ ...staffBody, expires_on: null });
    expect(noExpiry.status).toBe(400);

    const badType = await asOwner(
      api().post(`${base}/vendors/${vendor}/documents/upload`),
    ).send({
      ...staffBody,
      content: Buffer.from("<html>bad</html>").toString("base64"),
    });
    expect(badType.status).toBe(400);

    const pm = await api()
      .post(`${base}/vendors/${vendor}/documents/upload`)
      .set("Authorization", `Bearer ${mine.staff.pm!.token}`)
      .send(staffBody);
    expect(pm.status).toBe(403);

    const other = await api()
      .post(`${base}/vendors/${vendor}/documents/upload`)
      .set("Authorization", `Bearer ${theirs.staff.owner!.token}`)
      .send(staffBody);
    expect(other.status).toBe(404);

    const detail = await asOwner(api().get(`${base}/vendors/${vendor}`));
    const noted = detail.body.data.documents.find(
      (d: { file_name: string }) => d.file_name === "staff-noted.pdf",
    );
    expect(noted.notes).toBe("Filed by the office.");
    expect(noted.verify_method).toBeNull();
  });
});
