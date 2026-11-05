import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import { createTenant, projectBody, SCHEMA_FILES, startHarness, type Harness, type TenantFixture } from "./support/harness.js";

/** Token-feed diagnostic: what the plan can see in st_plan_appointments for one project. Read only. */
let h: Harness;
let t: TenantFixture;
let projectId: string;
const TOKEN = "portfolio-feed-token-for-tests-0059";

beforeAll(async () => {
  h = await startHarness(SCHEMA_FILES);
  t = await createTenant(h, { slug: "plan-diag" });
  projectId = (await h.as(t.staff.owner!.token).post("/api/v1/projects/projects").send(projectBody({ name: "Blanton", project_number: "321612166" }))).body.data.id;
  await h.db.withTenant(t.id, async (db) => {
    const rows: Array<[string, string, string, string]> = [
      ["901", "a1", "2026-10-30T13:00:00Z", "Scheduled"],
      ["901", "a2", "2026-11-02T13:00:00Z", "Canceled"],
      ["902", "a3", "2026-12-04T13:00:00Z", "Scheduled"],
    ];
    for (const [job, appt, start, status] of rows) {
      await db.query(
        `INSERT INTO projects.st_plan_appointments
           (tenant_id, project_id, external_job_id, external_appointment_id, job_number, appointment_number,
            job_status, starts_at, ends_at, status, active, technicians, observed_at)
         VALUES ($1,$2,$3,$4,$3,$4,'Scheduled',$5,($5::timestamptz + interval '4 hours'),$6,true,$7::jsonb,'2026-10-29T20:13:10Z')`,
        [
          t.id,
          projectId,
          job,
          appt,
          start,
          status,
          JSON.stringify([{ id: "tech-1", name: "Casey Nguyen" }]),
        ],
      );
    }
    await db.query(
      `INSERT INTO projects.st_plan_appointment_reads (tenant_id, project_id, read_at, skipped, failed_jobs, error)
       VALUES ($1,$2,'2026-10-29T20:13:10Z',0,'[{"jobId":"903","message":"timeout"}]'::jsonb,'Job 903 appointments: timeout')`,
      [t.id, projectId],
    );
    await db.query(
      `INSERT INTO projects.st_financial_reconciliation
         (tenant_id, project_id, observed_at, lines, technicians, error)
       VALUES ($1,$2,'2026-10-29T20:13:10Z',$3::jsonb,$4::jsonb,'Job 903 appointments: timeout')`,
      [
        t.id,
        projectId,
        JSON.stringify([{ address: "4412 Grove Avenue" }]),
        JSON.stringify([{ name: "Casey Nguyen" }]),
      ],
    );
  });
});
afterAll(async () => { await h?.close(); });

const feed = () => supertest(createApp({ database: h.db, staffSessions: new MemoryStaffSessions(), serveConsole: false, portfolio: { tenantId: t.id, token: TOKEN } }));

describe("plan appointment diagnostic on the portfolio feed", () => {
  it("needs the feed token", async () => {
    const res = await feed().get(`/api/v1/portfolio/projects/${projectId}/plan-appointments`);
    expect(res.status).toBe(401);
    const staff = await feed()
      .get(`/api/v1/portfolio/projects/${projectId}/plan-appointments`)
      .set("Authorization", `Bearer ${t.staff.owner!.token}`);
    expect(staff.status).toBe(401);
  });

  it("reports stored rows, span, last read and failures", async () => {
    const before = await h.db.withTenant(t.id, (db) =>
      db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM projects.st_plan_appointments WHERE project_id = $1`,
        [projectId],
      ),
    );
    const res = await feed().get(`/api/v1/portfolio/projects/${projectId}/plan-appointments`).set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.data;
    expect(d.project_id).toBe(projectId);
    expect(d.stored.total).toBe(3);
    expect(d.stored.plan_eligible).toBe(2);
    expect(d.stored.jobs).toBe(2);
    expect(new Date(d.stored.first_start).toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(new Date(d.stored.last_start).toISOString()).toBe("2026-12-04T13:00:00.000Z");
    expect(new Date(d.last_read.read_at).toISOString()).toBe("2026-10-29T20:13:10.000Z");
    expect(d.last_read.failed_jobs).toEqual([{ jobId: "903", message: "timeout" }]);
    expect(d.last_read.error).toBe("Job 903 appointments: timeout");
    expect(d.last_source_warnings.error).toBe("Job 903 appointments: timeout");
    expect(d.rows).toHaveLength(3);
    expect(d.rows[0]).toEqual({
      external_job_id: "901",
      external_appointment_id: "a1",
      job_number: "901",
      appointment_number: "a1",
      starts_at: "2026-10-30T13:00:00.000Z",
      ends_at: "2026-10-30T17:00:00.000Z",
      status: "Scheduled",
      job_status: "Scheduled",
      active: true,
      observed_at: "2026-10-29T20:13:10.000Z",
    });
    expect(d.job_links).toEqual({ total: 0, active: 0 });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("Casey Nguyen");
    expect(body).not.toContain("4412 Grove Avenue");
    expect(body).not.toContain("technicians");
    const after = await h.db.withTenant(t.id, (db) =>
      db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM projects.st_plan_appointments WHERE project_id = $1`,
        [projectId],
      ),
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    const posted = await feed()
      .post(`/api/v1/portfolio/projects/${projectId}/plan-appointments`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});
    expect(posted.status).toBe(404);
  });

  it("returns not found for an unknown project", async () => {
    const res = await feed().get(`/api/v1/portfolio/projects/00000000-0000-4000-8000-000000000000/plan-appointments`).set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(404);
  });
});
