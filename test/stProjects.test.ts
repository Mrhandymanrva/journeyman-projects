import { beforeAll, afterAll, it, expect, vi } from "vitest";
import {
  startHarness,
  createTenant,
  projectBody,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";
import type { ServiceTitanReadAdapter } from "../src/adapters/serviceTitan.js";
import { ServiceTitanReadError } from "../src/adapters/serviceTitan.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import type { StoredServiceTitanContact } from "../src/domain/stCustomerContacts.js";

type ReadDetails = Awaited<ReturnType<ServiceTitanReadAdapter["readProjectDetails"]>>;
/** Contact row stored on a project snapshot. doNotText is optional here so a fixture can omit it. */
type FixtureContact = Omit<StoredServiceTitanContact, "doNotText"> & { doNotText?: boolean };
type SnapshotCustomer = Omit<ReadDetails["customer"], "contacts" | "phone" | "email" | "contactsRead"> & {
  phone?: ReadDetails["customer"]["phone"];
  email?: ReadDetails["customer"]["email"];
  contacts?: FixtureContact[] | null;
  contactsRead?: ReadDetails["customer"]["contactsRead"];
};
type SnapshotLocation = Omit<ReadDetails["location"], "contacts"> & {
  contacts?: FixtureContact[] | null;
};
type SnapshotDetails = Omit<ReadDetails, "customer" | "location" | "warnings"> & {
  customer: SnapshotCustomer;
  location: SnapshotLocation;
  warnings?: ReadDetails["warnings"];
};
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
const snapshot = (): SnapshotDetails => ({
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
    createdOn: null as string | null,
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
      readJob: vi.fn(async (id: string) => ({
        job: {
          id,
          jobNumber: "J-" + id,
          projectId: null,
          customerId: "300",
          locationId: "400",
          jobStatus: "Scheduled",
          modifiedOn: "2026-09-15T00:00:00Z",
          summary: null,
        },
        appointments: [],
        assignments: [],
        observedAt: "2026-09-15T00:00:00.000Z",
      })),
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
  expect(after.scheduled_start).toBe(before.scheduled_start);
  expect(after.scheduled_start).not.toBe(st.startDate);
  expect(after.scheduled_end).toBe("2026-10-10");
  expect(after.field_start).toEqual({
    date: null,
    source: null,
    observed_at: null,
  });
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
  readProject.mockRejectedValueOnce(new ServiceTitanReadError("ServiceTitan invoices: pagination limit reached."));
  const failed = await owner()
    .post(base + "/projects/" + pm + "/servicetitan")
    .send({ external_project_id: "200" });
  expect(failed.status).toBe(502);
  expect(failed.body.error.message).toContain("Source refresh failed:");
  expect(failed.body.error.message).toContain("pagination limit reached");
  expect(failed.body.error.message).toContain("previous snapshot is unchanged");
  expect(failed.body.error.message).not.toMatch(/Bearer |client_secret|ak1\./);
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

it("imports the project when payroll gross pay fails and records the real warning", async () => {
  const data = snapshot();
  data.project = { ...st, id: "290588725", number: "DALTON", name: "Dalton", jobIds: ["8301"] };
  data.jobs = [{
    ...data.jobs[0]!,
    id: "8301",
    jobNumber: "J8301",
    projectId: "290588725",
    createdOn: "2025-01-02T15:00:00.000Z",
  }];
  readProject.mockResolvedValueOnce(data);
  const client = sources.serviceTitan!.client as {
    readGrossPayItems?: (query: { dateOnOrAfter: string }) => Promise<unknown>;
    readJobTimesheets?: (jobId: string) => Promise<unknown>;
  };
  let window = "";
  client.readJobTimesheets = async () => ({ forbidden: false, timesheets: [] });
  client.readGrossPayItems = async (query) => {
    window = query.dateOnOrAfter;
    throw new Error("Unexpected gross pay items (data.0.id: Invalid input).");
  };
  const r = await owner()
    .post(base + "/servicetitan/projects/import")
    .send({ external_project_id: "290588725" });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(window).toBe("2025-01-01T15:00:00.000Z");
  expect(r.body.data.warnings.join(" ")).toMatch(/data\.0\.id: Invalid input/);
  expect(r.body.data.warnings.join(" ")).toMatch(/Stored hours kept/);
  expect(r.body.data.warnings.join(" ")).not.toMatch(/last 120 days/);
  const created = r.body.data.id as string;
  const stored = await h.db.withTenant(t.id, (db) =>
    db.query<{ error: string | null }>(
      `SELECT error FROM projects.st_financial_reconciliation WHERE project_id = $1`,
      [created],
    ),
  );
  expect(stored.rows[0]?.error).toMatch(/data\.0\.id/);
  delete client.readGrossPayItems;
  delete client.readJobTimesheets;
});

it("adds the project when the scoped invoice read fails and does not read the whole account", async () => {
  const data = snapshot();
  data.project = { ...st, id: "290588726", number: "D2", name: "Dalton 2", jobIds: ["8302", "8303"] };
  data.jobs = data.project.jobIds.map((id) => ({
    ...data.jobs[0]!,
    id,
    jobNumber: "J" + id,
    projectId: "290588726",
    createdOn: "2025-01-02T12:00:00.000Z",
  }));
  readProject.mockResolvedValueOnce(data);
  const client = sources.serviceTitan!.client as Record<string, unknown>;
  const calls: string[] = [];
  client.readInvoices = async () => {
    throw new Error("tenant-wide invoices must not be read");
  };
  client.readInvoicesForJobs = async (jobIds: string[]) => {
    calls.push(`invoices:${jobIds.join(",")}`);
    throw new Error("ServiceTitan invoices: pagination limit reached. No partial snapshot may be imported.");
  };
  client.readPaymentsAppliedTo = async () => {
    calls.push("payments");
    return { forbidden: false, payments: [], capped: false };
  };
  client.readEstimatesForProject = async () => {
    calls.push("estimates");
    return { forbidden: false, estimates: [], capped: false };
  };
  const r = await owner()
    .post(base + "/servicetitan/projects/import")
    .send({ external_project_id: "290588726" });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(calls).toEqual(["invoices:8302,8303"]);
  expect(r.body.data.warnings.join(" ")).toMatch(/pagination limit reached/);
  const created = r.body.data.id as string;
  const stored = await h.db.withTenant(t.id, (db) =>
    db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM projects.st_invoice_observations WHERE project_id = $1`,
      [created],
    ),
  );
  expect(stored.rows[0]?.n).toBe("0");
  delete client.readInvoices;
  delete client.readInvoicesForJobs;
  delete client.readPaymentsAppliedTo;
  delete client.readEstimatesForProject;
});

it("scopes invoices, payments, and estimates to the project on import", async () => {
  const data = snapshot();
  data.project = { ...st, id: "290588727", number: "D3", name: "Dalton 3", jobIds: ["8304", "8305"] };
  data.jobs = data.project.jobIds.map((id) => ({
    ...data.jobs[0]!,
    id,
    jobNumber: "J" + id,
    projectId: "290588727",
    createdOn: "2025-01-02T12:00:00.000Z",
  }));
  readProject.mockResolvedValueOnce(data);
  const client = sources.serviceTitan!.client as Record<string, unknown>;
  const calls: string[] = [];
  client.readInvoicesForJobs = async (jobIds: string[]) => {
    calls.push(`invoices:${jobIds.join(",")}`);
    return {
      forbidden: false,
      incomplete: false,
      capped: false,
      warnings: [],
      invoices: jobIds.map((id) => ({
        externalInvoiceId: id,
        invoiceNumber: "INV-" + id,
        externalJobId: id,
        total: 10,
        balance: 0,
        invoicedOn: "2026-10-01",
        paidOn: null,
      })),
    };
  };
  client.readPaymentsAppliedTo = async (ids: string[]) => {
    expect(ids.length).toBeLessThanOrEqual(50);
    calls.push(`payments:${ids.join(",")}`);
    return { forbidden: false, payments: [], capped: false };
  };
  client.readEstimatesForProject = async (projectId: string) => {
    calls.push(`estimates:${projectId}`);
    return { forbidden: false, estimates: [], capped: false };
  };
  const r = await owner()
    .post(base + "/servicetitan/projects/import")
    .send({ external_project_id: "290588727" });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(calls).toEqual(["invoices:8304,8305", "payments:8304,8305", "estimates:290588727"]);
  delete client.readInvoicesForJobs;
  delete client.readPaymentsAppliedTo;
  delete client.readEstimatesForProject;
});

it("stores ServiceTitan phone and email on add and refresh, and keeps them when the contact read fails", async () => {
  const added = snapshot();
  added.project = { ...st, id: "910", number: "P-910", jobIds: ["911"] };
  added.jobs = [{ ...added.jobs[0]!, id: "911", jobNumber: "J911", projectId: "910" }];
  added.customer = {
    id: "300",
    name: "ST Customer",
    phone: "804-555-0177",
    email: "linh.nguyen@example.test",
    contacts: [{ id: "506", type: "MobilePhone", value: "804-555-0177", memo: "primary", optedOut: false }],
    contactsRead: true,
  };
  added.location = { ...added.location, contacts: [] };
  readProject.mockResolvedValueOnce(added);
  const created = await owner()
    .post(base + "/servicetitan/projects/import")
    .send({ external_project_id: "910" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  const stored = (await owner().get(base + "/projects/" + id + "/servicetitan")).body.data.connection.snapshot;
  expect(stored.customer.phone).toBe("804-555-0177");
  expect(stored.customer.email).toBe("linh.nguyen@example.test");
  expect(stored.customer.contactsRead).toBeUndefined();

  const refreshed = snapshot();
  refreshed.project = added.project;
  refreshed.jobs = added.jobs;
  refreshed.customer = {
    ...added.customer,
    phone: "804-555-0199",
    email: "new@example.test",
    contactsRead: true,
  };
  refreshed.location = added.location;
  readProject.mockResolvedValueOnce(refreshed);
  expect(
    (await owner().post(base + "/projects/" + id + "/servicetitan").send({ external_project_id: "910" })).status,
  ).toBe(200);
  const afterRefresh = (await owner().get(base + "/projects/" + id + "/servicetitan")).body.data.connection.snapshot;
  expect(afterRefresh.customer.phone).toBe("804-555-0199");

  const failed = snapshot();
  failed.project = added.project;
  failed.jobs = added.jobs;
  failed.customer = {
    id: "300",
    name: "ST Customer",
    phone: null,
    email: null,
    contacts: null,
    contactsRead: false,
  };
  failed.location = { ...added.location, contacts: null };
  readProject.mockResolvedValueOnce(failed);
  expect(
    (await owner().post(base + "/projects/" + id + "/servicetitan").send({ external_project_id: "910" })).status,
  ).toBe(200);
  const kept = (await owner().get(base + "/projects/" + id + "/servicetitan")).body.data.connection.snapshot;
  expect(kept.customer.phone).toBe("804-555-0199");
  expect(kept.customer.email).toBe("new@example.test");
});

it('lets office staff browse ST projects for their permitted import workflow',async()=>{
 listProjects.mockResolvedValueOnce({data:[st],hasMore:false,page:1});
 expect((await h.as(t.staff.office!.token).get(base+'/servicetitan/projects')).status).toBe(200);
});

it("stores appointments when a project is added or refreshed, and a failed read does not undo the add", async () => {
  const readJob = sources.serviceTitan!.client.readJob as ReturnType<typeof vi.fn>;
  const visit = async (id: string) => ({
    job: {
      id,
      jobNumber: "J-" + id,
      projectId: "920",
      customerId: "300",
      locationId: "400",
      jobStatus: "Scheduled",
      modifiedOn: "2026-11-01T00:00:00Z",
      summary: null,
    },
    appointments: [
      {
        id: id + "-a",
        appointmentNumber: "1",
        start: "2026-11-02T14:00:00Z",
        end: "2026-11-02T18:00:00Z",
        status: "Scheduled",
        active: true,
      },
    ],
    assignments: [
      { appointmentId: id + "-a", technicianId: "5", technicianName: "Alex", active: true, status: "Assigned" },
    ],
    observedAt: "2026-11-01T00:00:00.000Z",
    skippedAppointments: 1,
  });
  readJob.mockImplementation(visit);
  const data = snapshot();
  data.project = { ...st, id: "920", number: "P-920", name: "Blanton add", jobIds: ["921"] };
  data.jobs = [{ ...data.jobs[0]!, id: "921", jobNumber: "J921", projectId: "920" }];
  readProject.mockResolvedValueOnce(data);
  const created = await owner()
    .post(base + "/servicetitan/projects/import")
    .send({ external_project_id: "920" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.warnings.join(" ")).toMatch(/1 ST appointment record skipped/);
  const projectId = created.body.data.id as string;
  const stored = await h.db.withTenant(t.id, (db) =>
    db.query<{ external_appointment_id: string }>(
      `SELECT external_appointment_id FROM projects.st_plan_appointments WHERE project_id = $1`,
      [projectId],
    ),
  );
  expect(stored.rows.map((row) => row.external_appointment_id)).toEqual(["921-a"]);

  readProject.mockResolvedValueOnce({ ...snapshot(), ...data, observedAt: "2026-11-04T00:00:00.000Z" });
  const refreshed = await owner()
    .post(base + "/projects/" + projectId + "/servicetitan")
    .send({ external_project_id: "920" });
  expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
  const afterRefresh = await h.db.withTenant(t.id, (db) =>
    db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM projects.st_plan_appointments WHERE project_id = $1`,
      [projectId],
    ),
  );
  expect(afterRefresh.rows[0]?.n).toBe("1");

  readJob.mockImplementation(async () => {
    throw new Error("appointments unavailable");
  });
  const fail = snapshot();
  fail.project = { ...st, id: "930", number: "P-930", name: "Add survives", jobIds: ["931"] };
  fail.jobs = [{ ...fail.jobs[0]!, id: "931", jobNumber: "J931", projectId: "930" }];
  readProject.mockResolvedValueOnce(fail);
  const failedAdd = await owner()
    .post(base + "/servicetitan/projects/import")
    .send({ external_project_id: "930" });
  expect(failedAdd.status, JSON.stringify(failedAdd.body)).toBe(201);
  expect(failedAdd.body.data.warnings.join(" ")).toMatch(/appointments unavailable/);
  const empty = await h.db.withTenant(t.id, (db) =>
    db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM projects.st_plan_appointments WHERE project_id = $1`,
      [failedAdd.body.data.id],
    ),
  );
  expect(empty.rows[0]?.n).toBe("0");

  readJob.mockImplementation(async (id: string) => ({
    job: {
      id,
      jobNumber: "J-" + id,
      projectId: null,
      customerId: "300",
      locationId: "400",
      jobStatus: "Scheduled",
      modifiedOn: "2026-09-15T00:00:00Z",
      summary: null,
    },
    appointments: [],
    assignments: [],
    observedAt: "2026-09-15T00:00:00.000Z",
  }));
});
