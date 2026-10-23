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
  ServiceTitanReadError,
  ServiceTitanWriteUncertainError,
} from "../src/adapters/serviceTitan.js";
let h: Harness,
  t: TenantFixture,
  other: TenantFixture,
  project: string,
  link: string,
  source: string;
const sources: SourceConnections = {};
const readTechnicians = vi.fn(),
  rescheduleAppointment = vi.fn();
const base = "/api/v1/projects";
const owner = () => h.as(t.staff.owner!.token);
beforeAll(async () => {
  h = await startHarness(undefined, sources);
  t = await createTenant(h, { slug: "directory-tests" });
  other = await createTenant(h, { slug: "directory-other" });
  source = await h.db.withTenant(
    t.id,
    async (db) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO projects.external_systems(tenant_id,adapter_key,display_name) VALUES($1,'servicetitan','ST') RETURNING id`,
          [t.id],
        )
      ).rows[0]!.id,
  );
  sources.serviceTitan = {
    tenantId: t.id,
    externalSystemId: source,
    key: "st:test",
    writesEnabled: true,
    client: { readJob: vi.fn(), readTechnicians, rescheduleAppointment },
  };
  project = (
    await owner()
      .post(base + "/projects")
      .send(projectBody())
  ).body.data.id;
  link = (
    await owner().post(`${base}/projects/${project}/jobs`).send({
      title: "Linked job",
      external_system_id: source,
      external_job_id: "123",
    })
  ).body.data.id;
});
afterAll(async () => {
  await h?.close();
});
it("imports stable technician IDs, reflects deactivation and retains the directory on failure", async () => {
  readTechnicians.mockResolvedValueOnce([
    { id: "12", name: "Alex", active: true },
  ]);
  expect((await owner().post(base + "/technicians/refresh")).status).toBe(200);
  const id = (await owner().get(base + "/technicians")).body.data.technicians[0]
    .id;
  readTechnicians.mockResolvedValueOnce([
    { id: "12", name: "Alex updated", active: true },
  ]);
  expect((await owner().post(base + "/technicians/refresh")).status).toBe(200);
  expect(
    (await owner().get(base + "/technicians")).body.data.technicians[0].id,
  ).toBe(id);
  readTechnicians.mockRejectedValueOnce(new Error("private"));
  expect((await owner().post(base + "/technicians/refresh")).status).toBe(502);
  expect(
    (await owner().get(base + "/technicians")).body.data.technicians,
  ).toHaveLength(1);
  readTechnicians.mockResolvedValueOnce([
    { id: "12", name: "Alex", active: false },
  ]);
  expect((await owner().post(base + "/technicians/refresh")).status).toBe(200);
  expect(
    (await owner().get(base + "/technicians")).body.data.technicians,
  ).toHaveLength(0);
});
it("does not expose another account technicians or call ST for office staff", async () => {
  expect(
    (await h.as(other.staff.owner!.token).get(base + "/technicians")).body.data,
  ).toEqual({ configured: false, technicians: [] });
  const count = readTechnicians.mock.calls.length;
  expect(
    (await h.as(t.staff.office!.token).post(base + "/technicians/refresh"))
      .status,
  ).toBe(403);
  expect(readTechnicians).toHaveBeenCalledTimes(count);
});
it("persists independent activity type, phase and trade", async () => {
  const r = await owner().post(`${base}/projects/${project}/schedule`).send({
    title: "Shower wall",
    activity_type: "Install tile",
    phase: "Waterproofing and finishes",
    trade: "Tile",
    window_start: "2026-09-15",
    window_end: "2026-09-17",
  });
  expect(r.status).toBe(201);
  const rows = (await owner().get(`${base}/projects/${project}/schedule`)).body
    .data;
  expect(rows[0]).toMatchObject({
    activity_type: "Install tile",
    trade: "Tile",
  });
});
it("records ST publish results and rejects duplicate request keys", async () => {
  const body = {
    request_key: "59b8a609-c216-4434-9664-b2a510371792",
    appointment_id: "45",
    expected_modified_on: "2026-09-15T12:00:00Z",
    start: "2026-09-16T12:00:00Z",
    end: "2026-09-16T14:00:00Z",
    arrivalWindowStart: null,
    arrivalWindowEnd: null,
  };
  const url = `${base}/projects/${project}/jobs/${link}/dispatch/publish`;
  rescheduleAppointment.mockResolvedValueOnce({
    observedAt: new Date().toISOString(),
    job: { id: "123" },
    appointments: [],
    assignments: [],
  });
  expect((await owner().post(url).send(body)).body.data.state).toBe(
    "confirmed",
  );
  expect((await owner().post(url).send(body)).status).toBe(409);
  expect(rescheduleAppointment).toHaveBeenCalledTimes(1);
  rescheduleAppointment.mockRejectedValueOnce(
    new ServiceTitanReadError("Appointment changed"),
  );
  expect(
    (
      await owner()
        .post(url)
        .send({ ...body, request_key: "59b8a609-c216-4434-9664-b2a510371793" })
    ).body.data.state,
  ).toBe("failed");
  rescheduleAppointment.mockRejectedValueOnce(
    new ServiceTitanWriteUncertainError("Uncertain"),
  );
  expect(
    (
      await owner()
        .post(url)
        .send({ ...body, request_key: "59b8a609-c216-4434-9664-b2a510371794" })
    ).body.data.state,
  ).toBe("uncertain");
  expect(
    (
      await owner()
        .post(url)
        .send({ ...body, request_key: "59b8a609-c216-4434-9664-b2a510371795" })
    ).status,
  ).toBe(409);
});

it("applies a reviewed dependency proposal and preserves the original baseline", async () => {
  const a = await owner()
    .post(`${base}/projects/${project}/schedule`)
    .send({
      title: "Subcontractor work",
      window_start: "2026-09-15",
      window_end: "2026-09-16",
    });
  const b = await owner()
    .post(`${base}/projects/${project}/schedule`)
    .send({
      title: "Technician follows",
      window_start: "2026-09-17",
      window_end: "2026-09-18",
      dependencies: [{ predecessor_id: a.body.data.id, lag_days: 0 }],
    });
  const url = `${base}/projects/${project}/schedule-proposal`;
  const preview = await owner()
    .post(url)
    .send({ activity_id: a.body.data.id, start: "2026-09-18" });
  expect(preview.status).toBe(200);
  const apply = await owner()
    .post(url)
    .send({
      activity_id: a.body.data.id,
      start: "2026-09-18",
      apply: true,
      expected: preview.body.data.fingerprint,
    });
  expect(apply.status).toBe(200);
  const rows = await h.db.withTenant(
    t.id,
    async (db) =>
      (
        await db.query(
          "SELECT window_start::text,baseline_window_start::text FROM projects.schedule_items WHERE id=$1",
          [b.body.data.id],
        )
      ).rows,
  );
  expect(rows[0]).toMatchObject({
    window_start: "2026-09-22",
    baseline_window_start: "2026-09-17",
  });
  expect(
    (
      await owner()
        .post(url)
        .send({
          activity_id: a.body.data.id,
          start: "2026-09-18",
          apply: true,
          expected: preview.body.data.fingerprint,
        })
    ).status,
  ).toBe(409);
});
