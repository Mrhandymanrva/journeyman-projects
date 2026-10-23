import { beforeAll, afterAll, it, expect, vi } from "vitest";
import {
  startHarness,
  createTenant,
  projectBody,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
let h: Harness,
  t: TenantFixture,
  other: TenantFixture,
  project: string,
  link: string,
  system: string;
const sources: SourceConnections = {};
const base = "/api/v1/projects";
const readJob = vi.fn();
const read = vi.fn();
const owner = () => h.as(t.staff.owner!.token);
const snapshot = () => ({
  job: { id: "123" },
  appointments: [
    {
      id: "1",
      jobId: "123",
      start: "2026-09-15T12:00:00Z",
      end: "2026-09-15T20:00:00Z",
      status: "Scheduled",
      active: true,
    },
  ],
  assignments: [
    {
      id: "2",
      appointmentId: "1",
      technicianId: "7",
      technicianName: "Alex",
      active: true,
    },
  ],
  observedAt: new Date().toISOString(),
});
beforeAll(async () => {
  h = await startHarness(undefined, sources);
  t = await createTenant(h, { slug: "sources" });
  other = await createTenant(h, { slug: "sources-other" });
  project = (
    await owner()
      .post(base + "/projects")
      .send(projectBody())
  ).body.data.id;
  system = (await owner().get(base + "/external-systems")).body.data[0].id;
  link = (
    await owner().post(`${base}/projects/${project}/jobs`).send({
      title: "ST job",
      external_system_id: system,
      external_job_id: "123",
    })
  ).body.data.id;
  sources.serviceTitan = {
    tenantId: t.id,
    externalSystemId: system,
    key: "st:test:1",
    client: { readJob },
  };
  sources.reconciliation = {
    tenantId: t.id,
    externalSystemId: system,
    key: "po:test",
    client: { read },
  };
});
afterAll(async () => {
  await h?.close();
});
it("saves dispatch separately, atomically replaces cancellations and preserves the plan", async () => {
  const url = `${base}/projects/${project}/jobs/${link}/dispatch`;
  readJob.mockResolvedValueOnce(snapshot());
  expect((await owner().post(url + "/refresh")).status).toBe(200);
  expect(
    (await owner().get(url)).body.data.snapshot.payload.assignments[0]
      .technicianId,
  ).toBe("7");
  const next = snapshot();
  next.appointments[0]!.active = false;
  next.assignments = [];
  readJob.mockResolvedValueOnce(next);
  expect((await owner().post(url + "/refresh")).status).toBe(200);
  const saved = (await owner().get(url)).body.data.snapshot;
  expect(saved.payload.assignments).toHaveLength(0);
  expect(saved.payload.appointments[0].active).toBe(false);
  expect(
    (await owner().get(`${base}/projects/${project}/schedule`)).body.data,
  ).toHaveLength(0);
  readJob.mockRejectedValueOnce(new Error("secret"));
  const failure = await owner().post(url + "/refresh");
  expect(failure.status).toBe(502);
  expect(JSON.stringify(failure.body)).not.toContain("secret");
  expect((await owner().get(url)).body.data.snapshot).toEqual(saved);
});
it("rejects other tenants and office staff before making any source call", async () => {
  const count = readJob.mock.calls.length;
  const url = `${base}/projects/${project}/jobs/${link}/dispatch/refresh`;
  expect((await h.as(other.staff.owner!.token).post(url)).status).toBe(404);
  expect((await h.as(t.staff.office!.token).post(url)).status).toBe(403);
  expect(readJob).toHaveBeenCalledTimes(count);
  expect(
    (await h.as(other.staff.owner!.token).get(base + "/reconciliation-inbox"))
      .status,
  ).toBe(409);
});
it("imports reconciliation source cents without writing vendor bills and retains higher revision", async () => {
  const payload = {
    revision: 5,
    mode: "live",
    lastSync: null,
    records: [
      {
        id: "q1",
        source: "qbo",
        vendor: "Supplier",
        amount: 10001,
        date: "2026-09-15",
        currency: "USD",
        reference: "",
        description: "",
        account: "",
      },
    ],
  };
  read.mockResolvedValueOnce(payload);
  expect(
    (await owner().post(base + "/reconciliation-inbox/refresh")).status,
  ).toBe(200);
  const saved = (await owner().get(base + "/reconciliation-inbox")).body.data;
  expect(saved.accountingEffect).toBe("none");
  expect(saved.snapshot.payload.records[0].amount).toBe(10001);
  read.mockResolvedValueOnce({ ...payload, revision: 4 });
  expect(
    (await owner().post(base + "/reconciliation-inbox/refresh")).status,
  ).toBe(409);
  expect((await owner().get(base + "/reconciliation-inbox")).body.data).toEqual(
    saved,
  );
  const count = await h.db.withTenant(
    t.id,
    async (db) =>
      (await db.query("SELECT count(*)::int AS n FROM projects.vendor_bills"))
        .rows[0],
  );
  expect(count!.n).toBe(0);
});
it("enforces database isolation for both snapshot tables", async () => {
  await h.db.withTenant(other.id, async (db) => {
    expect(
      (await db.query("SELECT * FROM projects.dispatch_snapshots")).rows,
    ).toHaveLength(0);
    expect(
      (await db.query("SELECT * FROM projects.reconciliation_snapshots")).rows,
    ).toHaveLength(0);
  });
});

it("releases the transaction during source reads and rechecks revoked sessions", async () => {
  const token = h.sessions.issue({
    tenantId: t.id,
    staffId: t.staff.owner!.id,
  });
  const url = `${base}/projects/${project}/jobs/${link}/dispatch`;
  const before = (await owner().get(url)).body.data.snapshot;
  readJob.mockImplementationOnce(async () => {
    // This would deadlock on PGlite if an authorization transaction remained open.
    await h.db.withTenant(t.id, (db) => db.query("SELECT 1"));
    h.sessions.revoke(token);
    return snapshot();
  });
  expect((await h.as(token).post(url + "/refresh")).status).toBe(401);
  expect((await owner().get(url)).body.data.snapshot).toEqual(before);
});
it("does not expose a saved dispatch snapshot under a different connection binding", async () => {
  const c = sources.serviceTitan!;
  const key = c.key;
  c.key = "st:different-account";
  try {
    expect(
      (await owner().get(`${base}/projects/${project}/jobs/${link}/dispatch`))
        .body.data.snapshot,
    ).toBeNull();
  } finally {
    c.key = key;
  }
});
