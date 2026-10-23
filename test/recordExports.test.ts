import { beforeAll, afterAll, it, expect, vi } from "vitest";
import {
  startHarness,
  createTenant,
  projectBody,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import {
  documentBlocks,
  documentHtml,
  renderDocumentPdf,
} from "../src/domain/documentExport.js";
import { ServiceTitanReadAdapter } from "../src/adapters/serviceTitan.js";
let h: Harness, t: TenantFixture, other: TenantFixture, p: string, doc: any;
const sources: SourceConnections = {};
const publish = vi.fn(),
  receipts = vi.fn();
const st = {
  id: "200",
  number: "P200",
  name: "Bathroom",
  customerId: "300",
  locationId: "400",
  jobIds: ["501"],
};
const snapshot = {
  project: st,
  jobs: [
    {
      id: "501",
      jobNumber: "J501",
      projectId: "200",
      customerId: "300",
      locationId: "400",
      jobStatus: "Scheduled",
      modifiedOn: "2026-09-16T00:00:00Z",
    },
  ],
  customer: { id: "300", name: "Customer" },
  location: { id: "400", customerId: "300", name: "Site", address: {} },
  observedAt: "2026-09-16T00:00:00Z",
};
const owner = () => h.as(t.staff.owner!.token),
  base = () => "/api/v1/projects/projects/" + p + "/controls/" + doc.id;
beforeAll(async () => {
  h = await startHarness(undefined, sources);
  t = await createTenant(h, { slug: "exports" });
  other = await createTenant(h, { slug: "exports-other" });
  p = (await owner().post("/api/v1/projects/projects").send(projectBody())).body
    .data.id;
  doc = (
    await owner()
      .post("/api/v1/projects/projects/" + p + "/controls")
      .send({
        kind: "document",
        data: {
          title: "Project charter",
          folder: "charter_scope",
          content:
            "## Project purpose\n\nA safe and durable bathroom.\n\n- Protect existing finishes\n- Coordinate inspections\n\n| Trade | Responsibility |\n| --- | --- |\n| Plumbing | Rough-in |",
        },
      })
  ).body.data;
  const source = await h.db.withTenant(t.id, async (db) => {
    const id = (
      await db.query<{ id: string }>(
        "INSERT INTO projects.external_systems(tenant_id,adapter_key,display_name) VALUES($1,'servicetitan','ST') RETURNING id",
        [t.id],
      )
    ).rows[0]!.id;
    await db.query(
      "INSERT INTO projects.st_project_connections(tenant_id,project_id,external_system_id,external_project_id,connection_key,snapshot,observed_at,linked_by) VALUES($1,$2,$3,'200','st:production:10','{}',now(),$4)",
      [t.id, p, id, t.staff.owner!.id],
    );
    return id;
  });
  sources.serviceTitan = {
    tenantId: t.id,
    externalSystemId: source,
    key: "st:production:10",
    writesEnabled: true,
    client: {
      readJob: vi.fn(),
      readProjectDetails: vi.fn().mockResolvedValue(snapshot),
      publishRecord: publish,
      recordReceipts: receipts,
    },
  };
});
afterAll(async () => {
  await h?.close();
});
it("renders safe structured previews and real PDFs, isolates records and hides reserve exports from office", async () => {
  const preview = await owner().get(base() + "/preview");
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body.data.html).toContain("<h3>Project purpose</h3>");
  expect(preview.body.data.html).toContain("<table>");
  const pdf = await owner().get(base() + "/pdf");
  expect(pdf.status, JSON.stringify(pdf.body)).toBe(200);
  const bytes = Buffer.from(pdf.body.data.content, "base64");
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(5000);
  expect(
    (await h.as(other.staff.owner!.token).get(base() + "/pdf")).status,
  ).toBe(404);
  const reserve = (
    await owner()
      .post("/api/v1/projects/projects/" + p + "/controls")
      .send({
        kind: "reserve",
        data: {
          title: "Private reserve",
          category: "contingency",
          allocated: 500,
        },
      })
  ).body.data;
  expect(
    (
      await h
        .as(t.staff.office!.token)
        .get(
          "/api/v1/projects/projects/" + p + "/controls/" + reserve.id + "/pdf",
        )
    ).status,
  ).toBe(403);
  expect(
    (
      await h
        .as(t.staff.office!.token)
        .get(
          "/api/v1/projects/projects/" +
            p +
            "/controls/" +
            reserve.id +
            "/publications",
        )
    ).status,
  ).toBe(403);
});
it("publishes one immutable revision, deduplicates double-submit, and rejects a stale draft", async () => {
  const targets = await owner().get(base() + "/publish-targets");
  expect(targets.body.data.jobs[0].id).toBe("501");
  publish.mockResolvedValueOnce({
    state: "confirmed",
    attachmentId: "700",
    message: "Saved in ST",
  });
  const input = { version: 1, job_id: "501", format: "pdf" };
  const first = await owner()
    .post(base() + "/publish")
    .send(input);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.data.state).toBe("confirmed");
  expect(first.body.data).not.toHaveProperty("file_data");
  const same = await owner()
    .post(base() + "/publish")
    .send(input);
  expect(same.status).toBe(200);
  expect(same.body.data.id).toBe(first.body.data.id);
  expect(publish).toHaveBeenCalledTimes(1);
  const sent = publish.mock.calls[0]![0];
  expect(sent.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(sent.note).toContain("PM RECORD [");
  expect(sent.projectId).toBe("200");
  expect(
    (
      await owner()
        .patch(base())
        .send({ version: 1, data: { ...doc.data, title: "Updated charter" } })
    ).status,
  ).toBe(200);
  expect(
    (
      await owner()
        .post(base() + "/publish")
        .send(input)
    ).status,
  ).toBe(409);
  const list = await owner().get(
    "/api/v1/projects/projects/" + p + "/controls",
  );
  expect(
    list.body.data.records.find((r: any) => r.id === doc.id),
  ).toMatchObject({ version: 2, st_version: 1, st_state: "confirmed" });
});
it("blocks uncertain reuploads, verifies receipts, and resumes an explicit partial failure without another attachment", async () => {
  publish.mockResolvedValueOnce({
    state: "uncertain",
    attachmentId: null,
    message: "Timed out",
  });
  const input = { version: 2, job_id: "501", format: "pdf" };
  const r = await owner()
    .post(base() + "/publish")
    .send(input);
  expect(r.body.data.state).toBe("uncertain");
  const count = publish.mock.calls.length;
  expect(
    (
      await owner()
        .post(base() + "/publish")
        .send(input)
    ).status,
  ).toBe(409);
  expect(publish.mock.calls.length).toBe(count);
  receipts.mockResolvedValueOnce({ attachmentId: "702", noteConfirmed: true });
  const checked = await owner()
    .post(base() + "/publications/" + r.body.data.id + "/check")
    .send({});
  expect(checked.body.data.state).toBe("confirmed");
  expect(
    (
      await owner()
        .patch(base())
        .send({ version: 2, data: { ...doc.data, title: "Third revision" } })
    ).status,
  ).toBe(200);
  publish.mockResolvedValueOnce({
    state: "partial",
    attachmentId: "703",
    message: "Note rejected",
  });
  const v3 = { ...input, version: 3 };
  expect(
    (
      await owner()
        .post(base() + "/publish")
        .send(v3)
    ).body.data.state,
  ).toBe("partial");
  publish.mockResolvedValueOnce({
    state: "confirmed",
    attachmentId: "703",
    message: "Note confirmed",
  });
  expect(
    (
      await owner()
        .post(base() + "/publish")
        .send(v3)
    ).body.data.state,
  ).toBe("confirmed");
  expect(publish.mock.calls.at(-1)![0].attachmentId).toBe("703");
});
it("escapes HTML and handles multi-page content with long tables", async () => {
  const model = {
    title: "Status <script>alert(1)</script>",
    project: "Renovation",
    number: "P200",
    address: "Richmond",
    company: "Demo Contracting",
    revision: 3,
    updated: "2026-09-16",
    owner: "Project Manager",
    category: "Reports",
    content:
      "## Summary\n\n<script>alert(1)</script> **bold**\n\n| Area | Update |\n| --- | --- |\n" +
      Array.from(
        { length: 80 },
        (_, i) => `| Room ${i + 1} | ${"Inspection completed. ".repeat(5)} |`,
      ).join("\n"),
  };
  expect(documentHtml(model)).not.toContain("<script>");
  expect(documentHtml(model)).toContain("<strong>bold</strong>");
  expect(documentBlocks(model.content).at(-1)?.rows).toHaveLength(81);
  const bytes = await renderDocumentPdf(model);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(
    bytes.toString("latin1").match(/\/Type \/Page\b/g)!.length,
  ).toBeGreaterThan(2);
});
it("ST adapter validates project membership, multipart upload receipts, partial writes and timeouts", async () => {
  let fileName = "";
  const fetcher = vi.fn(async (url: any, init: any) => {
    if (String(url).includes("connect/token"))
      return new Response(
        JSON.stringify({ access_token: "test", expires_in: 3600 }),
      );
    if (init.method === "GET") return new Response(JSON.stringify(st));
    if (String(url).endsWith("/attachments")) {
      expect(init.body).toBeInstanceOf(FormData);
      fileName = init.body.get("file").name;
      return new Response(JSON.stringify({ id: 700, fileName }));
    }
    return new Response(JSON.stringify({ text: JSON.parse(init.body).text }));
  });
  const adapter = new ServiceTitanReadAdapter(
    {
      environment: "integration",
      tenantId: "10",
      clientId: "test",
      clientSecret: "test",
      appKey: "test",
    },
    fetcher as any,
  );
  const input = {
    projectId: "200",
    jobId: "501",
    fileName: "record.pdf",
    mediaType: "application/pdf",
    bytes: Buffer.from("%PDF-test"),
    note: "PM RECORD [test]",
  };
  expect((await adapter.publishRecord(input)).state).toBe("confirmed");
  expect(fileName).toBe("record.pdf");
  const calls = fetcher.mock.calls.length;
  expect((await adapter.publishRecord({ ...input, jobId: "999" })).state).toBe(
    "failed",
  );
  expect(fetcher.mock.calls.length).toBe(calls + 1);
  fetcher.mockImplementation(async (url: any, init: any) =>
    init.method === "GET"
      ? new Response(JSON.stringify(st))
      : new Response("{}", { status: 403 }),
  );
  expect(
    (await adapter.publishRecord({ ...input, attachmentId: "700" })).state,
  ).toBe("partial");
  fetcher.mockImplementation(async (url: any, init: any) => {
    if (init.method === "GET") return new Response(JSON.stringify(st));
    throw new Error("network");
  });
  expect((await adapter.publishRecord(input)).state).toBe("uncertain");
});

it("syncs secure project document links once per revision and enforces access", async () => {
  vi.stubEnv("PM_PUBLIC_APP_URL", "https://pm.example.test");
  const send = vi
    .fn()
    .mockResolvedValue({ state: "confirmed", message: "Saved" });
  sources.serviceTitan!.client.publishProjectNote = send;
  sources.serviceTitan!.client.projectNoteReceipt = vi
    .fn()
    .mockResolvedValue(false);
  const docBase = "/api/v1/projects/projects/" + p + "/controls";
  const created = (
    await owner()
      .post(docBase)
      .send({
        kind: "document",
        data: {
          title: "Permit drawing",
          description: "Approved bathroom plans",
          folder: "plans_specs",
        },
      })
  ).body.data;
  const endpoint = docBase + "/" + created.id + "/sync-link";
  expect(
    (await h.as(other.staff.owner!.token).post(endpoint).send({ version: 1 }))
      .status,
  ).toBe(404);
  expect((await owner().post(endpoint).send({ version: 99 })).status).toBe(409);
  const first = await owner().post(endpoint).send({ version: 1 });
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.data.state).toBe("confirmed");
  expect(first.body.data.url).toBe(
    "https://pm.example.test/?project=" +
      p +
      "&document=" +
      created.id +
      "#documents",
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toBe("200");
  expect(send.mock.calls[0]![1]).toContain("Approved bathroom plans");
  expect(send.mock.calls[0]![1]).not.toContain("access_token");
  await owner().post(endpoint).send({ version: 1 });
  expect(send).toHaveBeenCalledTimes(1);
  const listed = await owner().get(docBase);
  expect(
    listed.body.data.records.find((r: any) => r.id === created.id)
      .st_link_state,
  ).toBe("confirmed");
  vi.unstubAllEnvs();
});
it("checks uncertain link writes without posting duplicate project notes", async () => {
  vi.stubEnv("PM_PUBLIC_APP_URL", "https://pm.example.test");
  const send = vi
    .fn()
    .mockResolvedValue({ state: "uncertain", message: "Timeout" });
  const check = vi.fn().mockResolvedValue(false);
  sources.serviceTitan!.client.publishProjectNote = send;
  sources.serviceTitan!.client.projectNoteReceipt = check;
  const docBase = "/api/v1/projects/projects/" + p + "/controls";
  const created = (
    await owner()
      .post(docBase)
      .send({
        kind: "document",
        data: { title: "Uncertain link", folder: "other" },
      })
  ).body.data;
  const endpoint = docBase + "/" + created.id + "/sync-link";
  expect(
    (await owner().post(endpoint).send({ version: 1 })).body.data.state,
  ).toBe("uncertain");
  expect(
    (await owner().post(endpoint).send({ version: 1 })).body.data.state,
  ).toBe("uncertain");
  expect(send).toHaveBeenCalledTimes(1);
  check.mockResolvedValue(true);
  expect(
    (await owner().post(endpoint).send({ version: 1 })).body.data.state,
  ).toBe("confirmed");
  expect(send).toHaveBeenCalledTimes(1);
  vi.unstubAllEnvs();
});

it("posts the documented project-note payload and verifies its receipt", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "test", expires_in: 3600 }), {
        status: 200,
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "Document URL" }), { status: 200 }),
    );
  const client = new ServiceTitanReadAdapter(
    {
      environment: "production",
      tenantId: "10",
      clientId: "test",
      clientSecret: "test",
      appKey: "test",
    },
    fetcher,
  );
  expect((await client.publishProjectNote("200", "Document URL")).state).toBe(
    "confirmed",
  );
  expect(fetcher.mock.calls[1]![0]).toBe(
    "https://api.servicetitan.io/jpm/v2/tenant/10/projects/200/notes",
  );
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
    text: "Document URL",
    pinToTop: false,
  });
});
