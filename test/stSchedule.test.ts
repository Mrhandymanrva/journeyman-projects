import { beforeAll, afterAll, it, expect, vi } from "vitest";
import {
  startHarness,
  createTenant,
  projectBody,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
let h: Harness, t: TenantFixture, other: TenantFixture, id: string;
const sources: SourceConnections = {};
const readJob = vi.fn(),
  readProject = vi.fn();
const base = "/api/v1/projects",
  query = "?from=2026-09-16&to=2026-09-29";
const owner = () => h.as(t.staff.owner!.token);
let jobs = ["101"];
function snapshot(jobId = "101") {
  return {
    job: {
      id: jobId,
      jobNumber: "JOB-" + jobId,
      projectId: "200",
      jobStatus: "Scheduled",
    },
    appointments: [
      {
        id: jobId + "1",
        jobId,
        appointmentNumber: "A-" + jobId,
        start: "2026-09-17T01:00:00Z",
        end: "2026-09-17T04:00:00Z",
        active: true,
        status: "Scheduled",
      },
    ],
    assignments: [
      {
        appointmentId: jobId + "1",
        technicianId: "5",
        technicianName: "Alex",
        active: true,
        status: "Assigned",
      },
      {
        appointmentId: jobId + "1",
        technicianId: "6",
        technicianName: "Blair",
        active: true,
        status: "Assigned",
      },
      {
        appointmentId: jobId + "1",
        technicianId: "7",
        technicianName: "Removed",
        active: false,
        status: "Assigned",
      },
    ],
  };
}
beforeAll(async () => {
  h = await startHarness(undefined, sources);
  t = await createTenant(h, { slug: "st-schedule" });
  other = await createTenant(h, { slug: "other-schedule" });
  id = (
    await owner()
      .post(base + "/projects")
      .send(projectBody())
  ).body.data.id;
  const source = await h.db.withTenant(t.id, async (db) => {
    const s = (
      await db.query<{ id: string }>(
        "INSERT INTO projects.external_systems(tenant_id,adapter_key,display_name) VALUES($1,'servicetitan','ST') RETURNING id",
        [t.id],
      )
    ).rows[0]!.id;
    await db.query(
      "INSERT INTO projects.st_project_connections(project_id,tenant_id,external_system_id,external_project_id,connection_key,snapshot,observed_at,linked_by) VALUES($1,$2,$3,'200','test','{}',now(),$4)",
      [id, t.id, s, t.staff.owner!.id],
    );
    return s;
  });
  sources.serviceTitan = {
    tenantId: t.id,
    externalSystemId: source,
    key: "test",
    client: { readJob, readProject },
  };
  readProject.mockImplementation(async () => ({
    project: { id: "200", jobIds: jobs },
    observedAt: new Date().toISOString(),
  }));
  readJob.mockImplementation(async (jobId: string) => snapshot(jobId));
});
afterAll(async () => h?.close());
it("pulls current ST project jobs without requiring imported job links and includes all active technicians", async () => {
  const r = await owner().get(
    base + "/projects/" + id + "/servicetitan/schedule" + query,
  );
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const row = r.body.data.rows[0];
  expect(row.source).toBe("servicetitan");
  expect(row.resources.map((x: any) => x.name)).toEqual(["Alex", "Blair"]);
  expect(row.window_start).toBe("2026-09-16");
  expect(row.window_end).toBe("2026-09-16");
  expect(row.job_link_id).toBeNull();
  expect(
    (await owner().get(base + "/projects/" + id + "/schedule")).body.data,
  ).toEqual([]);
  jobs = ["101", "102"];
  const next = await owner().get(base + "/servicetitan/schedule" + query);
  expect(next.body.data.rows).toHaveLength(2);
  jobs = ["101"];
});
it("refresh removes cancellations and skips inactive or out-of-range appointments", async () => {
  const s = snapshot();
  s.appointments.push(
    { ...s.appointments[0]!, id: "cancelled", status: "Canceled" },
    { ...s.appointments[0]!, id: "inactive", active: false },
    {
      ...s.appointments[0]!,
      id: "future",
      start: "2026-10-01T12:00:00Z",
      end: "2026-10-01T13:00:00Z",
    },
  );
  readJob.mockResolvedValueOnce(s);
  expect(
    (
      await owner().get(
        base + "/projects/" + id + "/servicetitan/schedule" + query,
      )
    ).body.data.rows,
  ).toHaveLength(1);
  readJob.mockResolvedValueOnce({
    ...s,
    job: { ...s.job, jobStatus: "Canceled" },
  });
  expect(
    (
      await owner().get(
        base + "/projects/" + id + "/servicetitan/schedule" + query,
      )
    ).body.data.rows,
  ).toHaveLength(0);
});
it("keeps tenant boundaries and validates ranges before any upstream read", async () => {
  const n = readJob.mock.calls.length;
  expect(
    (
      await h
        .as(other.staff.owner!.token)
        .get(base + "/projects/" + id + "/servicetitan/schedule" + query)
    ).status,
  ).toBe(404);
  expect(
    (
      await h
        .as(other.staff.owner!.token)
        .get(base + "/servicetitan/schedule" + query)
    ).body.data.rows,
  ).toEqual([]);
  expect(
    (
      await owner().get(
        base +
          "/projects/" +
          id +
          "/servicetitan/schedule?from=2026-10-01&to=2026-09-16",
      )
    ).status,
  ).toBe(400);
  expect(readJob.mock.calls.length).toBe(n);
});
it("fails the ST read explicitly without modifying the PM plan or leaking upstream errors", async () => {
  readJob.mockRejectedValueOnce(Error("private source detail"));
  const r = await owner().get(
    base + "/projects/" + id + "/servicetitan/schedule" + query,
  );
  expect(r.status).toBe(502);
  expect(JSON.stringify(r.body)).not.toContain("private source detail");
  expect(
    (await owner().get(base + "/projects/" + id + "/schedule")).body.data,
  ).toEqual([]);
});
it("rejects membership drift instead of mixing jobs from different projects", async () => {
  readProject
    .mockResolvedValueOnce({ project: { id: "200", jobIds: ["101"] } })
    .mockResolvedValueOnce({ project: { id: "200", jobIds: [] } });
  expect(
    (
      await owner().get(
        base + "/projects/" + id + "/servicetitan/schedule" + query,
      )
    ).status,
  ).toBe(502);
});
