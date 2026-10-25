import { beforeAll, afterAll, it, expect } from "vitest";
import {
  startHarness,
  createTenant,
  projectBody,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";
import type { BidMailConfig } from "../src/adapters/bidMail.js";
let h: Harness,
  t: TenantFixture,
  other: TenantFixture,
  project: string,
  vendor: string,
  vendor2: string;
const base = "/api/v1/projects";
const config: BidMailConfig = {
  tenantId: "",
  origin: "https://pm.example.test",
  linkSecret: "test-only-random-link-secret",
};
const owner = () => h.as(t.staff.owner!.token);
beforeAll(async () => {
  h = await startHarness(undefined, undefined, config);
  t = await createTenant(h, { slug: "intake" });
  other = await createTenant(h, { slug: "intake-other" });
  config.tenantId = t.id;
  project = (
    await owner()
      .post(base + "/projects")
      .send(projectBody())
  ).body.data.id;
  vendor = (
    await owner()
      .post(base + "/vendors")
      .send({
        legal_name: "Tile Co",
        email: "tile@example.test",
        primary_contact: "Taylor",
        address: "123 Test St",
        phone: "555-1234",
        trades: ["Tile"],
        specialties: ["Curbless showers"],
        license_number: "LIC123",
        license_expires_on: "2028-01-01",
        availability_status: "limited",
        available_from: "2026-10-01",
        availability_notes: "Two-week lead time",
        notes: "Prefers weekday site visits",
      })
  ).body.data.id;
  vendor2 = (
    await owner()
      .post(base + "/vendors")
      .send({
        legal_name: "Electric Co",
        email: "electric@example.test",
        trades: ["Electrical"],
      })
  ).body.data.id;
});
afterAll(async () => {
  await h?.close();
});
it("keeps s and S in contact names at the start, middle, and end", async () => {
  const samples = ["Susan", "Jessica", "Chris", "sasha", "JeSsica", "ChriS"];
  const ids: string[] = [];
  for (const [index, name] of samples.entries()) {
    const created = await owner()
      .post(base + "/vendors")
      .send({
        legal_name: name + " Co",
        email: `contact-${index}@names.test`,
        primary_contact: name,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    ids.push(created.body.data.id);
    const detail = await owner().get(base + "/vendors/" + created.body.data.id);
    expect(detail.body.data.primary_contact).toBe(name);
  }
  const listed = (await owner().get(base + "/vendors?q=Jessica")).body.data;
  expect(listed.find((row: { id: string }) => row.id === ids[1]).primary_contact).toBe("Jessica");
  const edited = await owner()
    .patch(base + "/vendors/" + ids[2])
    .send({ primary_contact: "ChriS" });
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  expect(edited.body.data.primary_contact).toBe("ChriS");
  expect((await owner().get(base + "/vendors/" + ids[2])).body.data.primary_contact).toBe("ChriS");
});

it("persists full intake and sorts/filter trades without losing specialties on partial edits", async () => {
  await owner()
    .patch(base + "/vendors/" + vendor)
    .send({ phone: "555-4567" });
  const v = (await owner().get(base + "/vendors/" + vendor)).body.data;
  expect(v).toMatchObject({
    specialties: ["Curbless showers"],
    license_number: "LIC123",
    availability_status: "limited",
    primary_contact: "Taylor",
    address: "123 Test St",
    phone: "555-4567",
  });
  const rows = (await owner().get(base + "/vendors?sort=trade")).body.data;
  expect(rows.map((r: any) => r.id)).toEqual([vendor2, vendor]);
  expect(
    (await owner().get(base + "/vendors?trade=Tile&q=Curbless")).body.data,
  ).toHaveLength(1);
});
it("stores actual private documents, requires COI expiration and blocks cross-account/unauthorized file reads", async () => {
  const file = {
    kind: "gl_insurance",
    file_name: "coi.pdf",
    media_type: "application/pdf",
    content: Buffer.from("%PDF-1.7\nTest document").toString("base64"),
  };
  expect(
    (
      await owner()
        .post(base + "/vendors/" + vendor + "/documents/upload")
        .send(file)
    ).status,
  ).toBe(400);
  const uploaded = await owner()
    .post(base + "/vendors/" + vendor + "/documents/upload")
    .send({ ...file, expires_on: "2027-01-01" });
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
  const url =
    base +
    "/vendors/" +
    vendor +
    "/documents/" +
    uploaded.body.data.id +
    "/file";
  expect((await owner().get(url)).body.data.content.replace(/\s/g, "")).toBe(
    file.content,
  );
  expect((await h.as(other.staff.owner!.token).get(url)).status).toBe(404);
  expect((await h.as(t.staff.pm!.token).get(url)).status).toBe(403);
  const metadata = (await owner().get(base + "/vendors/" + vendor)).body.data
    .documents[0];
  expect(metadata.has_file).toBe(true);
  expect(metadata).not.toHaveProperty("file_data");
  expect(
    (
      await owner()
        .post(base + "/vendors/" + vendor + "/documents/upload")
        .send({
          ...file,
          expires_on: "2027-01-01",
          content: Buffer.from("<html>bad</html>").toString("base64"),
        })
    ).status,
  ).toBe(400);
});
it("counts issued contracted work once, excludes drafts and voids, and keeps currencies separate", async () => {
  await h.db.withTenant(t.id, async (db) => {
    const code = (
      await db.query<{ id: string }>(
        "SELECT id FROM projects.cost_codes LIMIT 1",
      )
    ).rows[0]!.id;
    for (const [i, status] of [
      "draft",
      "issued",
      "partially_billed",
      "closed",
      "void",
    ].entries())
      await db.query(
        `INSERT INTO projects.purchase_orders(tenant_id,project_id,po_number,vendor_id,cost_code_id,cost_type,amount,scope_text,status) VALUES($1,$2,$3,$4,$5,'S',100,'Work',$6)`,
        [t.id, project, "INTAKE-" + i, vendor, code, status],
      );
  });
  const totals = (await owner().get(base + "/vendor-work-totals")).body.data;
  expect(totals).toHaveLength(1);
  expect(Number(totals[0].contracted_total)).toBe(300);
  expect(totals[0].contract_count).toBe(3);
  expect(
    (await h.as(other.staff.owner!.token).get(base + "/vendor-work-totals"))
      .body.data,
  ).toHaveLength(0);
});
it("creates individual Outlook drafts, tracks delivery honestly, and saves a private bid response", async () => {
  const created = await owner()
    .post(base + "/bid-requests")
    .send({
      project_id: project,
      subject: "Bathroom tile bid",
      scope: "Tile a shower",
      vendor_ids: [vendor, vendor2],
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id;
  const drafts = await owner().post(
    base + "/bid-requests/" + id + "/email-drafts",
  );
  expect(drafts.status).toBe(200);
  expect(drafts.body.data.messages).toHaveLength(2);
  let detail = (await owner().get(base + "/bid-requests/" + id)).body.data;
  expect(
    detail.recipients.every(
      (r: any) => r.delivery_status === "prepared" && !r.sent_at,
    ),
  ).toBe(true);
  const m = drafts.body.data.messages[0];
  const url = new URL(m.text.match(/https:\/\/\S+/)[0]);
  const params = new URLSearchParams(url.hash.slice(1));
  const publicPath =
    "/api/v1/bid-response/" +
    params.get("tenant") +
    "/" +
    params.get("recipient");
  const token = params.get("token")!;
  expect(
    (await h.request.get(publicPath).set("X-Bid-Token", "0".repeat(64))).status,
  ).toBe(404);
  const read = await h.request.get(publicPath).set("X-Bid-Token", token);
  expect(read.status).toBe(200);
  expect(read.body.data).not.toHaveProperty("recipients");
  expect(read.body.data).not.toHaveProperty("email");
  expect(
    (
      await h.request
        .post(publicPath)
        .set("X-Bid-Token", token)
        .send({
          response_status: "quoted",
          quote_amount: 2500,
          response_notes: "Includes waterproofing",
          available_from: "2026-10-01",
        })
    ).status,
  ).toBe(200);
  detail = (await owner().get(base + "/bid-requests/" + id)).body.data;
  expect(
    detail.recipients.find((r: any) => r.id === m.id).response_status,
  ).toBe("quoted");
  await owner().post(
    base + "/bid-requests/" + id + "/recipients/" + m.id + "/mark-sent",
  );
  expect(
    (await h.as(other.staff.owner!.token).get(base + "/bid-requests/" + id))
      .status,
  ).toBe(404);
  await owner().post(base + "/bid-requests/" + id + "/close");
  expect(
    (await h.request.get(publicPath).set("X-Bid-Token", token)).status,
  ).toBe(404);
});
it("rejects cross-tenant bid recipients and requires an explicit configured sender for API delivery", async () => {
  const foreign = (
    await h
      .as(other.staff.owner!.token)
      .post(base + "/vendors")
      .send({ legal_name: "Other", email: "other@example.test" })
  ).body.data.id;
  expect(
    (
      await owner()
        .post(base + "/bid-requests")
        .send({
          project_id: project,
          subject: "Bid",
          scope: "Test",
          vendor_ids: [foreign],
        })
    ).status,
  ).toBe(404);
  const b = (
    await owner()
      .post(base + "/bid-requests")
      .send({
        project_id: project,
        subject: "Bid",
        scope: "Test",
        vendor_ids: [vendor],
      })
  ).body.data.id;
  expect(
    (await owner().post(base + "/bid-requests/" + b + "/send")).status,
  ).toBe(409);
  expect(
    (await h.as(other.staff.owner!.token).get(base + "/bid-requests")).body.data
      .requests,
  ).toHaveLength(0);
});
it("one COI covers multiple categories with one file and review; coverage edits preserve the file", async () => {
  const v = (await owner().post(base + "/vendors").send({legal_name:"Multi COI",email:"coi@example.test",trades:[]})).body.data.id;
  const url = base + "/vendors/" + v;
  const coverage = ["gl_insurance", "wc_insurance", "auto_insurance"];
  const file = {kind:"gl_insurance",coverage_kinds:coverage,expires_on:"2099-01-01",file_name:"combined.pdf",media_type:"application/pdf",content:Buffer.from("%PDF-1.7\nCombined COI").toString("base64")};
  for (const patch of [{coverage_kinds:[]},{coverage_kinds:["tax_form"]},{coverage_kinds:["gl_insurance","gl_insurance"]},{kind:"tax_form"},{expires_on:null}]) {
    expect((await owner().post(url+"/documents/upload").send({...file,...patch})).status).toBe(400);
  }
  expect((await h.as(other.staff.owner!.token).post(url+"/documents/upload").send(file)).status).toBe(404);
  expect((await h.as(t.staff.pm!.token).post(url+"/documents/upload").send(file)).status).toBe(403);
  const uploaded = await owner().post(url+"/documents/upload").send(file);
  expect(uploaded.status,JSON.stringify(uploaded.body)).toBe(201);
  const docUrl=url+"/documents/"+uploaded.body.data.id;
  let detail=(await owner().get(url)).body.data;
  expect(detail.documents).toHaveLength(1);
  expect(detail.documents[0].coverage_kinds).toEqual(coverage);
  expect(detail.compliance.filter((c:any)=>coverage.includes(c.kind)).map((c:any)=>c.state)).toEqual(["valid","valid","valid"]);
  expect((await owner().patch(docUrl).send({verify_method:"Confirmed all three policies with carrier"})).status).toBe(200);
  detail=(await owner().get(url)).body.data;
  expect(detail.documents[0].verified_at).toBeTruthy();
  expect((await h.as(other.staff.owner!.token).patch(docUrl+"/coverage").send({coverage_kinds:coverage})).status).toBe(404);
  expect((await h.as(t.staff.pm!.token).patch(docUrl+"/coverage").send({coverage_kinds:coverage})).status).toBe(403);
  expect((await owner().patch(docUrl+"/coverage").send({coverage_kinds:["wc_insurance"]})).status).toBe(200);
  detail=(await owner().get(url)).body.data;
  expect(detail.documents).toHaveLength(1);
  expect(detail.documents[0].verified_at).toBeNull();
  expect(detail.compliance.find((c:any)=>c.kind==="gl_insurance").state).toBe("missing");
  expect(detail.compliance.find((c:any)=>c.kind==="auto_insurance").state).toBe("missing");
  expect((await owner().get(docUrl+"/file")).body.data.content.replace(/\s/g,"")).toBe(file.content);
  await h.db.withTenant(t.id,db=>db.query("UPDATE projects.vendor_documents SET expires_on='2000-01-01' WHERE id=$1",[uploaded.body.data.id]));
  expect((await owner().patch(docUrl+"/coverage").send({coverage_kinds:coverage})).status).toBe(200);
  detail=(await owner().get(url)).body.data;
  expect(detail.compliance.filter((c:any)=>coverage.includes(c.kind)).map((c:any)=>c.state)).toEqual(["expired","expired","expired"]);
});
it("adds coverage to a previously uploaded single-category COI without another upload",async()=>{
  const url=base+"/vendors/"+vendor;
  const detail=(await owner().get(url)).body.data;
  const doc=detail.documents.find((d:any)=>d.kind==="gl_insurance");
  expect((await owner().patch(url+"/documents/"+doc.id+"/coverage").send({coverage_kinds:["gl_insurance","wc_insurance","auto_insurance"]})).status).toBe(200);
  const updated=(await owner().get(url)).body.data;
  expect(updated.documents).toHaveLength(detail.documents.length);
  expect(updated.compliance.filter((c:any)=>c.kind.endsWith("_insurance")).every((c:any)=>c.state!=="missing")).toBe(true);
});
