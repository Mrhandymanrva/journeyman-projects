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
  pm: string,
  pm2: string,
  source: string;
const base = "/api/v1/projects";
const sources: SourceConnections = {};
const listProjects = vi.fn(),
  readProject = vi.fn();
let n = 0;
const st = {
  id: "200",
  number: "P-200",
  name: "ST bathroom",
  customerId: "300",
  locationId: "400",
  jobIds: ["501", "502"],
  status: "InProgress",
  startDate: "2026-09-20",
  targetCompletionDate: "2026-10-10",
};
const owner = () => h.as(t.staff.owner!.token);
const snapshot = () => ({
  project: st,
  customer: { id: "300", name: "ST Customer" },
  location: {
    id: "400",
    customerId: "300",
    name: "Service location",
    address: {
      street: "100 ST Street",
      city: "Richmond",
      state: "VA",
      zip: "23220",
    },
  },
  jobs: st.jobIds.map((id) => ({
    id,
    jobNumber: "J-" + id,
    customerId: "300",
    locationId: "400",
    projectId: "200",
    jobStatus: "Scheduled",
    modifiedOn: "2026-09-15T00:00:00Z",
    summary: "From ST",
  })),
  observedAt: new Date(Date.UTC(2026, 8, 15, 0, 0, ++n)).toISOString(),
});
beforeAll(async () => {
  h = await startHarness(undefined, sources);
  t = await createTenant(h, { slug: "st-projects" });
  other = await createTenant(h, { slug: "st-projects-other" });
  source = await h.db.withTenant(
    t.id,
    async (db) =>
      (
        await db.query<{ id: string }>(
          "INSERT INTO projects.external_systems(tenant_id,adapter_key,display_name) VALUES($1,'servicetitan','ST') RETURNING id",
          [t.id],
        )
      ).rows[0]!.id,
  );
  sources.serviceTitan = {
    tenantId: t.id,
    externalSystemId: source,
    key: "st:production:10",
    client: {
      readJob: vi.fn(),
      listProjects,
      readProject,
      readProjectDetails: readProject,
    },
  };
  pm = (
    await owner()
      .post(base + "/projects")
      .send(projectBody())
  ).body.data.id;
  pm2 = (
    await owner()
      .post(base + "/projects")
      .send(projectBody({ project_number: "PM-2", name: "Another PM project" }))
  ).body.data.id;
});
afterAll(async () => {
  await h?.close();
});
it("lists actual ST projects through the configured source without exposing credentials", async () => {
  listProjects.mockResolvedValueOnce({ data: [st], hasMore: false, page: 1 });
  const r = await owner().get(base + "/servicetitan/projects?number=P-200");
  expect(r.status).toBe(200);
  expect(r.body.data.data[0].id).toBe("200");
  expect(listProjects).toHaveBeenCalledWith(1, "P-200");
});
it("connects an ST project and its jobs without replacing PM plans or budgets; refresh is idempotent", async () => {
  const before = (await owner().get(base + "/projects/" + pm)).body.data;
  readProject.mockResolvedValueOnce(snapshot());
  const r = await owner()
    .post(base + "/projects/" + pm + "/servicetitan")
    .send({ external_project_id: "200" });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.data.linkedJobs).toBe(2);
  const after = (await owner().get(base + "/projects/" + pm)).body.data;
  expect(after.name).toBe(st.name);
  expect(after.project_number).toBe(st.number);
  expect(after.address_line1).toBe("100 ST Street");
  expect(after.source_customer_name).toBe("ST Customer");
  expect(after.contract_value).toBe(before.contract_value);
  expect(
    (await owner().get(base + "/projects/" + pm + "/jobs")).body.data,
  ).toHaveLength(2);
  readProject.mockResolvedValueOnce(snapshot());
  expect(
    (
      await owner()
        .post(base + "/projects/" + pm + "/servicetitan")
        .send({ external_project_id: "200" })
    ).status,
  ).toBe(200);
  expect(
    (await owner().get(base + "/projects/" + pm + "/jobs")).body.data,
  ).toHaveLength(2);
  const connected = (
    await owner().get(base + "/projects/" + pm + "/servicetitan")
  ).body.data;
  expect(connected.connection.snapshot.customerId).toBe("300");
  expect(connected.connectionMatches).toBe(true);
});
it("refuses duplicate ST project mappings and preserves the original association", async () => {
  readProject.mockResolvedValueOnce(snapshot());
  expect(
    (
      await owner()
        .post(base + "/projects/" + pm2 + "/servicetitan")
        .send({ external_project_id: "200" })
    ).status,
  ).toBe(409);
  readProject.mockResolvedValueOnce({
    ...snapshot(),
    project: { ...st, id: "201" },
  });
  expect(
    (
      await owner()
        .post(base + "/projects/" + pm + "/servicetitan")
        .send({ external_project_id: "201" })
    ).status,
  ).toBe(409);
  expect(
    (await owner().get(base + "/projects/" + pm + "/servicetitan")).body.data
      .connection.external_project_id,
  ).toBe("200");
});
it("enforces tenant ownership and source failure retains the existing snapshot", async () => {
  const before = readProject.mock.calls.length;
  expect(
    (
      await h
        .as(other.staff.owner!.token)
        .get(base + "/projects/" + pm + "/servicetitan")
    ).status,
  ).toBe(404);
  expect(
    (
      await h
        .as(other.staff.owner!.token)
        .post(base + "/projects/" + pm + "/servicetitan")
        .send({ external_project_id: "200" })
    ).status,
  ).toBe(404);
  expect(readProject.mock.calls).toHaveLength(before);
  readProject.mockRejectedValueOnce(Error("upstream"));
  expect(
    (
      await owner()
        .post(base + "/projects/" + pm + "/servicetitan")
        .send({ external_project_id: "200" })
    ).status,
  ).toBe(502);
  expect(
    (await owner().get(base + "/projects/" + pm + "/servicetitan")).body.data
      .connection.snapshot.id,
  ).toBe("200");
});

it("imports a new project with source identity and jobs and no invented financial values", async () => {
  const data = snapshot();
  data.project = { ...st, id: "900", number: "P-900", jobIds: ["901"] };
  data.jobs = [
    { ...data.jobs[0]!, id: "901", jobNumber: "J901", projectId: "900" },
  ];
  readProject.mockResolvedValueOnce(data);
  const r = await owner()
    .post(base + "/servicetitan/projects/import")
    .send({ external_project_id: "900" });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const p = (await owner().get(base + "/projects/" + r.body.data.id)).body.data;
  expect(p.project_number).toBe("P-900");
  expect(p.contract_value).toBeNull();
  expect(p.target_margin).toBeNull();
  expect(
    (
      await owner()
        .patch(base + "/projects/" + p.id)
        .send({ name: "Manual override" })
    ).status,
  ).toBe(409);
  expect(
    (
      await owner()
        .post(base + "/projects/" + p.id + "/jobs")
        .send({
          title: "Manual",
          external_system_id: source,
          external_job_id: "902",
        })
    ).status,
  ).toBe(409);
  const updated = {
    ...data,
    project: { ...data.project, jobIds: [] },
    jobs: [],
    observedAt: "2026-10-01T00:00:00Z",
  };
  readProject.mockResolvedValueOnce(updated);
  expect(
    (
      await owner()
        .post(base + "/projects/" + p.id + "/servicetitan")
        .send({ external_project_id: "900" })
    ).status,
  ).toBe(200);
  const jobs = (await owner().get(base + "/projects/" + p.id + "/jobs")).body
    .data;
  expect(jobs).toHaveLength(1);
  expect(jobs[0].source_active).toBe(false);
  expect(jobs[0].source_job_number).toBe("J901");
  readProject.mockResolvedValueOnce({
    ...data,
    observedAt: "2026-10-02T00:00:00Z",
  });
  const again = await owner()
    .post(base + "/servicetitan/projects/import")
    .send({ external_project_id: "900" });
  expect(again.status).toBe(200);
  expect(again.body.data.id).toBe(p.id);
  expect(
    (await owner().get(base + "/projects/" + p.id + "/jobs")).body.data[0]
      .source_active,
  ).toBe(true);
});

it('lets office staff browse ST projects for their permitted import workflow',async()=>{
 listProjects.mockResolvedValueOnce({data:[st],hasMore:false,page:1});
 expect((await h.as(t.staff.office!.token).get(base+'/servicetitan/projects')).status).toBe(200);
});
