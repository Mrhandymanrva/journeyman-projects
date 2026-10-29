import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { hasExecutableSql, splitSqlStatements } from "../src/db/splitSql.js";
import { isBeforeSourceFloor } from "../src/domain/sourceFloor.js";
import { collectPlanAppointments } from "../src/domain/planAppointments.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import {
  SCHEMA_FILES,
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

process.env.PLAN_ST_REFRESH_MIN_MS = "0";

const base = "/api/v1/projects";
const readJob = vi.fn();
const sources: SourceConnections = {};
let h: Harness;
let t: TenantFixture;
let systemId: string;
let linkedId: string;
let openId: string;

const owner = () => h.as(t.staff.owner!.token);

beforeAll(async () => {
  h = await startHarness(undefined, sources);
  t = await createTenant(h, { slug: "plan-appointments" });
  linkedId = (await owner().post(base + "/projects").send(projectBody({ name: "Dalton — outside the window", project_number: "DALTON" }))).body.data.id;
  openId = (await owner().post(base + "/projects").send(projectBody({ name: "Not linked", project_number: "OPEN-1" }))).body.data.id;
  systemId = await h.db.withTenant(t.id, async (db) => {
    const system = await db.query<{ id: string }>(
      "INSERT INTO projects.external_systems(tenant_id,adapter_key,display_name) VALUES($1,'servicetitan','ST') RETURNING id",
      [t.id],
    );
    const id = system.rows[0]!.id;
    await db.query(
      `INSERT INTO projects.st_project_connections
         (project_id, tenant_id, external_system_id, external_project_id, connection_key, snapshot, observed_at, linked_by)
       VALUES ($1,$2,$3,'88001','test','{}','2026-10-20T15:00:00Z',$4)`,
      [linkedId, t.id, id, t.staff.owner!.id],
    );
    await db.query(
      `INSERT INTO projects.st_plan_appointments
         (tenant_id, project_id, external_job_id, external_appointment_id, job_number, appointment_number,
          job_status, starts_at, ends_at, status, active, technicians, observed_at)
       VALUES ($1,$2,'501','appt-far','501','1','Scheduled',$3,$4,'Scheduled',true,'[]'::jsonb,$5)`,
      [t.id, linkedId, "2027-06-01T14:00:00Z", "2027-06-01T18:00:00Z", "2026-10-20T15:00:00Z"],
    );
    await db.query(
      `INSERT INTO projects.st_plan_appointment_reads (tenant_id, project_id, read_at, skipped, failed_jobs)
       VALUES ($1,$2,'2026-10-20T15:00:00Z',0,'[]'::jsonb)`,
      [t.id, linkedId],
    );
    return id;
  });
  sources.serviceTitan = {
    tenantId: t.id,
    externalSystemId: systemId,
    key: "test",
    client: {
      readJob,
      readJobTimesheets: async (jobId: string) => ({ jobId, forbidden: false, timesheets: [] }),
      readGrossPayItems: async () => ({
        forbidden: false,
        items: [],
        skipped: 0,
        omitted: 0,
        capped: false,
        pagesRead: 1,
        timesheetTimeWithoutJob: { count: 0, withPaidHours: 0 },
      }),
    },
  };
});

afterAll(async () => {
  await h?.close();
});

it("shows a linked project with every appointment outside the plan range as linked, not as connect", async () => {
  const response = await owner().get(
    base + "/projects/" + linkedId + "/plan-appointments?from=2026-10-01&to=2026-10-28",
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data.linkedProjects).toBe(1);
  expect(response.body.data.rows).toEqual([]);
  expect(response.body.data.appointmentsReadAt).toBe("2026-10-20T15:00:00.000Z");
  expect(response.body.data.observedAt).toBe("2026-10-20T15:00:00.000Z");
  expect(response.body.data.message).toMatch(/^Linked · 0 ST appointments in this range · last read /);
  expect(response.body.data.message).not.toMatch(/Connect this project/);
});

it("asks to connect only when the project has no ServiceTitan link", async () => {
  const response = await owner().get(
    base + "/projects/" + openId + "/plan-appointments?from=2026-10-01&to=2026-10-28",
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data.linkedProjects).toBe(0);
  expect(response.body.data.message).toBe(
    "Connect this project to ServiceTitan to include technician jobs.",
  );
});

it("refreshes one project's appointments through the shared read and replaces rows without duplicating them", async () => {
  await h.db.withTenant(t.id, (db) =>
    db.query(
      `INSERT INTO projects.project_job_links
         (tenant_id, project_id, external_system_id, external_job_id, title, source_active)
       VALUES ($1,$2,$3,'701','Job 701',true)`,
      [t.id, linkedId, systemId],
    ),
  );
  readJob.mockImplementation(async (jobId: string) => ({
    job: { id: jobId, jobNumber: "J-" + jobId, jobStatus: "Scheduled" },
    appointments: [
      {
        id: "appt-" + jobId,
        appointmentNumber: "1",
        start: "2026-10-12T13:00:00Z",
        end: "2026-10-12T17:00:00Z",
        status: "Scheduled",
        active: true,
      },
    ],
    assignments: [
      { appointmentId: "appt-" + jobId, technicianId: "9", technicianName: "Rae", active: true },
    ],
    skippedAppointments: 0,
  }));
  const first = await owner().post(base + "/projects/" + linkedId + "/plan-appointments/refresh").send({});
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(readJob).toHaveBeenCalledWith("701");
  expect(first.body.data.stored).toBe(1);
  expect(first.body.data.readAt).toEqual(expect.any(String));
  const second = await owner().post(base + "/projects/" + linkedId + "/plan-appointments/refresh").send({});
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  const rows = await h.db.withTenant(t.id, (db) =>
    db.query<{ external_appointment_id: string; n: string }>(
      `SELECT external_appointment_id, count(*) OVER ()::text AS n
         FROM projects.st_plan_appointments
        WHERE project_id = $1 AND external_job_id = '701'`,
      [linkedId],
    ),
  );
  expect(rows.rows.map((row) => row.external_appointment_id)).toEqual(["appt-701"]);
  expect(rows.rows[0]?.n).toBe("1");
});

it("keeps a failed job's stored appointments and still replaces the jobs that read", async () => {
  await h.db.withTenant(t.id, (db) =>
    db.query(
      `INSERT INTO projects.project_job_links
         (tenant_id, project_id, external_system_id, external_job_id, title, source_active)
       VALUES ($1,$2,$3,'702','Job 702',true)
       ON CONFLICT DO NOTHING`,
      [t.id, linkedId, systemId],
    ),
  );
  await h.db.withTenant(t.id, (db) =>
    db.query(
      `INSERT INTO projects.st_plan_appointments
         (tenant_id, project_id, external_job_id, external_appointment_id, job_number, appointment_number,
          job_status, starts_at, ends_at, status, technicians)
       VALUES ($1,$2,'702','old-702','702','9','Scheduled','2026-10-11T13:00:00Z','2026-10-11T15:00:00Z','Scheduled','[]'::jsonb)`,
      [t.id, linkedId],
    ),
  );
  readJob.mockImplementation(async (jobId: string) => {
    if (jobId === "702") throw new Error("appointment page failed");
    return {
      job: { id: jobId, jobNumber: "J-" + jobId, jobStatus: "Scheduled" },
      appointments: [
        {
          id: "fresh-" + jobId,
          appointmentNumber: "2",
          start: "2026-10-13T13:00:00Z",
          end: "2026-10-13T16:00:00Z",
          status: "Scheduled",
          active: true,
        },
      ],
      assignments: [],
    };
  });
  const response = await owner().post(base + "/projects/" + linkedId + "/plan-appointments/refresh").send({});
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data.failedJobs).toEqual([{ jobId: "702", message: "appointment page failed" }]);
  expect(response.body.data.warnings.join(" ")).toMatch(/Job 702 appointments: appointment page failed/);
  const rows = await h.db.withTenant(t.id, (db) =>
    db.query<{ external_job_id: string; external_appointment_id: string }>(
      `SELECT external_job_id, external_appointment_id
         FROM projects.st_plan_appointments
        WHERE project_id = $1 AND external_job_id IN ('701','702')
        ORDER BY external_job_id`,
      [linkedId],
    ),
  );
  expect(rows.rows).toEqual([
    { external_job_id: "701", external_appointment_id: "fresh-701" },
    { external_job_id: "702", external_appointment_id: "old-702" },
  ]);
  const shown = await owner().get(
    base + "/projects/" + linkedId + "/plan-appointments?from=2026-10-01&to=2026-10-28",
  );
  expect(shown.body.data.message).toMatch(/Job 702 appointments: appointment page failed/);
  expect(shown.body.data.appointmentsReadAt).toEqual(expect.any(String));
});

it("stores appointments on the Financials refresh when payroll has no paid timesheet hours", async () => {
  readJob.mockImplementation(async (jobId: string) => ({
    job: { id: jobId, jobNumber: "J-" + jobId, jobStatus: "Scheduled" },
    appointments: [
      {
        id: "pay-" + jobId,
        appointmentNumber: "3",
        start: "2026-10-14T13:00:00Z",
        end: "2026-10-14T18:00:00Z",
        status: "Scheduled",
        active: true,
      },
    ],
    assignments: [],
  }));
  const response = await owner().post(base + "/projects/" + linkedId + "/labor/refresh").send({});
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data.warnings.join(" ")).toMatch(/no paid timesheet hours/);
  expect(response.body.data.plan_appointments.stored).toBeGreaterThan(0);
  expect(response.body.data.plan_appointments.read_at).toEqual(expect.any(String));
  const rows = await h.db.withTenant(t.id, (db) =>
    db.query<{ external_appointment_id: string }>(
      `SELECT external_appointment_id FROM projects.st_plan_appointments
        WHERE project_id = $1 AND external_appointment_id LIKE 'pay-%'`,
      [linkedId],
    ),
  );
  expect(rows.rows.length).toBeGreaterThan(0);
});

it("does not treat a current appointment as before the source floor", async () => {
  expect(isBeforeSourceFloor("2026-10-29T13:00:00Z")).toBe(false);
  expect(isBeforeSourceFloor("2022-08-02T00:00:00Z")).toBe(false);
  expect(isBeforeSourceFloor("2022-08-01T23:00:00Z")).toBe(true);
  const collected = await collectPlanAppointments(
    async () => ({
      job: { id: "1", jobNumber: "J-1", jobStatus: "Scheduled" },
      appointments: [
        {
          id: "now",
          appointmentNumber: "1",
          start: "2026-10-29T13:00:00Z",
          end: "2026-10-29T15:00:00Z",
          status: "Scheduled",
          active: true,
        },
        {
          id: "old",
          appointmentNumber: "2",
          start: "2020-01-02T13:00:00Z",
          end: "2020-01-02T15:00:00Z",
          status: "Scheduled",
          active: true,
        },
      ],
      assignments: [],
    }),
    [{ external_job_id: "1" }],
  );
  expect(collected.appointments.map((row) => row.externalAppointmentId)).toEqual(["now"]);
});

it("debounces a second ServiceTitan appointment refresh for the same project", async () => {
  const created = await owner()
    .post(base + "/projects")
    .send(projectBody({ name: "Debounce", project_number: "DEBOUNCE" }));
  const projectId = created.body.data.id as string;
  await h.db.withTenant(t.id, (db) =>
    db.query(
      `INSERT INTO projects.project_job_links
         (tenant_id, project_id, external_system_id, external_job_id, title, source_active)
       VALUES ($1,$2,$3,'703','Job 703',true)`,
      [t.id, projectId, systemId],
    ),
  );
  process.env.PLAN_ST_REFRESH_MIN_MS = "15000";
  try {
    const first = await owner().post(base + "/projects/" + projectId + "/plan-appointments/refresh").send({});
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await owner().post(base + "/projects/" + projectId + "/plan-appointments/refresh").send({});
    expect(second.status).toBe(429);
    expect(second.body.error.message).toMatch(/Wait a few seconds/);
  } finally {
    process.env.PLAN_ST_REFRESH_MIN_MS = "0";
  }
});

it("applies the appointment-read migration twice", async () => {
  const file = SCHEMA_FILES.find((entry) => entry.endsWith("059_st_plan_appointment_reads.sql"));
  expect(file).toBeTruthy();
  const apply = async () => {
    for (const statement of splitSqlStatements(readFileSync(file!, "utf8"))) {
      if (!hasExecutableSql(statement.text)) continue;
      await h.db.asOwner((db) => db.query(statement.text));
    }
  };
  await apply();
  await apply();
  const still = await h.db.withTenant(t.id, (db) =>
    db.query<{ read_at: Date }>(
      `SELECT read_at FROM projects.st_plan_appointment_reads WHERE project_id = $1`,
      [openId],
    ),
  );
  expect(still.rows).toEqual([]);
  const column = await h.db.asOwner((db) =>
    db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'projects' AND table_name = 'st_plan_appointment_reads' AND column_name = 'read_at'`,
    ),
  );
  expect(column.rows).toEqual([{ column_name: "read_at" }]);
});

it("reapplies every migration twice after the appointment read stamp exists", async () => {
  async function reapplyMigrations(): Promise<void> {
    for (const file of SCHEMA_FILES) {
      for (const statement of splitSqlStatements(readFileSync(file, "utf8"))) {
        if (!hasExecutableSql(statement.text)) continue;
        try {
          await h.db.asOwner((db) => db.query(statement.text));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/already exists/i.test(message)) continue;
          throw new Error(`${path.basename(file)}:${statement.startLine} ${message}`);
        }
      }
    }
  }
  await reapplyMigrations();
  await reapplyMigrations();
  const stamped = await h.db.withTenant(t.id, (db) =>
    db.query<{ project_id: string }>(
      `SELECT project_id::text FROM projects.st_plan_appointment_reads WHERE project_id = $1`,
      [linkedId],
    ),
  );
  expect(stamped.rows).toEqual([{ project_id: linkedId }]);
});
