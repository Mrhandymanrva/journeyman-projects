import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financialsDashboardHtml } from "../client/financialsDashboard.js";
import {
  blantonCommittedAppointments,
  BLANTON_CASEY,
  BLANTON_CLOSED_JOB,
  BLANTON_OPEN_JOB,
  BLANTON_PRICED_JOB,
  BLANTON_RILEY,
  BLANTON_WINDOW_END,
  BLANTON_WINDOW_START,
} from "../src/demo/blantonCommittedFixture.js";
import {
  buildCommittedLabor,
  FLAG_BURDEN,
  FLAG_REVENUE_ESTIMATED,
  FLAG_UNASSIGNED,
  workingHours,
  zonedLocalToUtc,
  type CommittedAppointment,
  type CommittedLaborInput,
} from "../src/domain/committedLabor.js";
import { buildFinancialsDashboard } from "../src/domain/financialsDashboard.js";
import {
  createTenant,
  projectBody,
  SCHEMA_FILES,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

function appointment(overrides: Partial<CommittedAppointment> & Pick<CommittedAppointment, "externalJobId">): CommittedAppointment {
  return {
    externalAppointmentId: overrides.externalAppointmentId ?? "a1",
    jobNumber: overrides.jobNumber ?? overrides.externalJobId,
    jobStatus: overrides.jobStatus ?? "Scheduled",
    startsAt: overrides.startsAt ?? zonedLocalToUtc("2026-10-29", 8, 0),
    endsAt: overrides.endsAt ?? zonedLocalToUtc("2026-10-29", 12, 0),
    status: overrides.status ?? "Scheduled",
    active: overrides.active ?? true,
    technicians: overrides.technicians ?? [{ id: "tech-casey", name: "Casey Nguyen" }],
    externalJobId: overrides.externalJobId,
  };
}

describe("committed labor hours", () => {
  it("counts a same-day window inside the workday as clock time", () => {
    const start = zonedLocalToUtc("2026-10-29", 8, 0);
    const end = zonedLocalToUtc("2026-10-29", 12, 0);
    expect(start).toBe("2026-10-29T12:00:00.000Z");
    expect(workingHours(start, end)).toBe(4);
  });

  it("counts each weekday's working hours on a multi-day appointment, not the wall clock", () => {
    const start = zonedLocalToUtc("2026-11-02", 8, 0);
    const end = zonedLocalToUtc("2026-11-04", 12, 0);
    expect(start).toBe("2026-11-02T13:00:00.000Z");
    const wallClock = (Date.parse(end) - Date.parse(start)) / 3_600_000;
    expect(wallClock).toBeGreaterThan(40);
    // Mon 8:00–3:00 = 7, Tue 7:00–3:00 = 8, Wed 7:00–12:00 = 5.
    expect(workingHours(start, end)).toBe(20);
  });

  it("skips Saturday and Sunday when an appointment crosses the weekend", () => {
    const start = zonedLocalToUtc("2026-10-30", 14, 0);
    const end = zonedLocalToUtc("2026-11-02", 10, 0);
    const wallClock = (Date.parse(end) - Date.parse(start)) / 3_600_000;
    expect(wallClock).toBeGreaterThan(40);
    // Friday 2:00–3:00 p.m. plus Monday 7:00–10:00 a.m.
    expect(workingHours(start, end)).toBe(4);
  });
});

describe("committed labor rules", () => {
  const rates = [{ technicianId: "tech-casey", burdenRate: 12 }];

  function input(extra: Partial<CommittedLaborInput> = {}): CommittedLaborInput {
    return {
      appointments: [],
      links: [],
      invoiceLines: [],
      actuals: [],
      rates,
      billableRate: 188,
      ...extra,
    };
  }

  it("counts an unassigned appointment as one technician and flags it", () => {
    const result = buildCommittedLabor(
      input({
        links: [{ externalJobId: "open", jobNumber: "100", jobStatus: "Scheduled", active: true }],
        appointments: [appointment({ externalJobId: "open", technicians: [] })],
      }),
    );
    expect(result.hours).toBe(4);
    expect(result.jobs[0]?.flags).toEqual(expect.arrayContaining([FLAG_UNASSIGNED, FLAG_BURDEN, FLAG_REVENUE_ESTIMATED]));
    expect(result.jobs[0]?.technicians).toEqual(["Unassigned"]);
    expect(result.jobs[0]?.revenue).toBe(752);
    expect(result.jobs[0]?.commission).toBe(188);
    expect(result.jobs[0]?.burden).toBe(0);
    expect(result.jobs[0]?.cost).toBe(188);
    expect(result.method).toContain("25%");
    expect(result.method).toContain("$188");
    expect(result.method).toContain("7:00 a.m.");
    expect(result.method).toContain("no technician");
  });

  it("uses labor invoice lines when they exist, and ignores materials and never-labor codes", () => {
    const result = buildCommittedLabor(
      input({
        links: [{ externalJobId: "open", jobNumber: "100", jobStatus: "InProgress", active: true }],
        appointments: [appointment({ externalJobId: "open" })],
        invoiceLines: [
          { externalJobId: "open", sku: "MHM.25PLFE", kind: "labor", total: 800 },
          { externalJobId: "open", sku: "TILE", kind: "material", total: 500 },
          { externalJobId: "open", sku: "MHM.25LFCO", kind: "labor", total: 90 },
        ],
      }),
    );
    expect(result.jobs[0]?.revenue).toBe(800);
    expect(result.jobs[0]?.revenueSource).toBe("invoice");
    expect(result.jobs[0]?.commission).toBe(200);
    expect(result.jobs[0]?.burden).toBe(48);
    expect(result.jobs[0]?.cost).toBe(248);
    expect(result.revenueEstimated).toBe(false);
  });

  it("uses estimate labor lines when the job has no invoice labor", () => {
    const result = buildCommittedLabor(
      input({
        links: [{ externalJobId: "open", jobNumber: "100", jobStatus: "Scheduled", active: true }],
        appointments: [appointment({ externalJobId: "open" })],
        estimateLines: [{ externalJobId: "open", sku: "MHM.25PLFE", kind: "service", total: 500 }],
      }),
    );
    expect(result.jobs[0]?.revenue).toBe(500);
    expect(result.jobs[0]?.revenueSource).toBe("estimate");
    expect(result.jobs[0]?.commission).toBe(125);
    expect(result.jobs[0]?.flags).not.toContain(FLAG_REVENUE_ESTIMATED);
  });

  it("prices burden from stored actuals when the rate column is empty", () => {
    const result = buildCommittedLabor(
      input({
        rates: [],
        links: [{ externalJobId: "open", jobNumber: "100", jobStatus: "Scheduled", active: true }],
        appointments: [appointment({ externalJobId: "open" })],
        actuals: [
          {
            externalJobId: "other",
            technicianId: "tech-casey",
            hours: 6,
            laborAmount: 900,
            burdenAmount: 180,
            burdenUnset: false,
          },
        ],
      }),
    );
    expect(result.jobs[0]?.burden).toBe(120);
    expect(result.jobs[0]?.flags).not.toContain(FLAG_BURDEN);
  });

  it("keeps a completed job committed until it is invoiced", () => {
    const result = buildCommittedLabor(
      input({
        links: [{ externalJobId: "done", jobNumber: "200", jobStatus: "Completed", active: true }],
        appointments: [appointment({ externalJobId: "done", status: "Done", jobStatus: "Completed" })],
        actuals: [
          {
            externalJobId: "done",
            technicianId: "tech-casey",
            hours: 6,
            laborAmount: 250,
            burdenAmount: 72,
            burdenUnset: false,
          },
        ],
      }),
    );
    expect(result.hours).toBe(4);
    expect(result.actualHours).toBe(0);
    expect(result.actualJobIds).toEqual([]);
    expect(result.jobs.map((job) => job.jobId)).toEqual(["done"]);
  });

  it("does not count a completed invoiced job as both committed and actual", () => {
    const result = buildCommittedLabor(
      input({
        links: [
          { externalJobId: "open", jobNumber: "100", jobStatus: "Scheduled", active: true },
          { externalJobId: "closed", jobNumber: "200", jobStatus: "Completed", active: true },
        ],
        appointments: [
          appointment({ externalJobId: "open", externalAppointmentId: "open-1" }),
          appointment({
            externalJobId: "closed",
            externalAppointmentId: "closed-1",
            status: "Done",
            jobStatus: "Completed",
          }),
        ],
        invoiceLines: [{ externalJobId: "closed", sku: "MHM.25PLFE", kind: "labor", total: 1000 }],
        actuals: [
          {
            externalJobId: "closed",
            technicianId: "tech-casey",
            hours: 6,
            laborAmount: 250,
            burdenAmount: 72,
            burdenUnset: false,
          },
        ],
      }),
    );
    expect(result.hours).toBe(4);
    expect(result.hours).not.toBe(8);
    expect(result.jobs.map((job) => job.jobId)).toEqual(["open"]);
    expect(result.revenue).toBe(752);
    expect(result.revenue).not.toBe(1752);
    expect(result.actualJobIds).toEqual(["closed"]);
    expect(result.actualHours).toBe(6);
    expect(result.actualCost).toBe(322);
    expect(result.jobs.some((job) => job.jobId === "closed")).toBe(false);
  });

  it("leaves an invoiced job committed while it is still in progress", () => {
    const result = buildCommittedLabor(
      input({
        links: [{ externalJobId: "open", jobNumber: "100", jobStatus: "InProgress", active: true }],
        appointments: [appointment({ externalJobId: "open" })],
        invoiceLines: [{ externalJobId: "open", sku: "MHM.25PLFE", kind: "labor", total: 800 }],
      }),
    );
    expect(result.actualJobIds).toEqual([]);
    expect(result.jobs).toHaveLength(1);
    expect(result.revenue).toBe(800);
  });

  it("skips canceled appointments, inactive rows, and jobs that are not linked", () => {
    const result = buildCommittedLabor(
      input({
        links: [{ externalJobId: "open", jobNumber: "100", jobStatus: "Scheduled", active: true }],
        appointments: [
          appointment({ externalJobId: "open", externalAppointmentId: "live" }),
          appointment({ externalJobId: "open", externalAppointmentId: "void", status: "Canceled" }),
          appointment({ externalJobId: "open", externalAppointmentId: "off", active: false }),
          appointment({ externalJobId: "stray", externalAppointmentId: "stray" }),
        ],
      }),
    );
    expect(result.hours).toBe(4);
    expect(result.jobs).toHaveLength(1);
  });

  it("counts each assigned technician once, including on a multi-day visit", () => {
    const result = buildCommittedLabor(
      input({
        rates: [
          { technicianId: "tech-casey", burdenRate: 12 },
          { technicianId: "tech-riley", burdenRate: null },
        ],
        links: [{ externalJobId: "open", jobNumber: "100", jobStatus: "Scheduled", active: true }],
        appointments: [
          appointment({
            externalJobId: "open",
            startsAt: zonedLocalToUtc("2026-11-02", 8, 0),
            endsAt: zonedLocalToUtc("2026-11-04", 12, 0),
            technicians: [BLANTON_CASEY, BLANTON_CASEY, BLANTON_RILEY],
          }),
        ],
      }),
    );
    expect(result.hours).toBe(40);
    expect(result.jobs[0]?.burden).toBe(240);
    expect(result.jobs[0]?.flags).toContain(FLAG_BURDEN);
    expect(result.jobs[0]?.technicians).toEqual(["Casey Nguyen", "Riley Cho"]);
  });
});

describe("Blanton committed labor fixture", () => {
  const visits = blantonCommittedAppointments();

  it("has 40 appointments, 36 Scheduled and 4 Done, inside Oct 29–Nov 25", () => {
    expect(visits).toHaveLength(40);
    expect(visits.filter((visit) => visit.status === "Scheduled")).toHaveLength(36);
    expect(visits.filter((visit) => visit.status === "Done")).toHaveLength(4);
    const starts = visits.map((visit) => visit.startsAt).sort();
    const ends = visits.map((visit) => visit.endsAt).sort();
    expect(starts[0]).toContain("2026-10-29");
    expect(ends[ends.length - 1]).toContain(BLANTON_WINDOW_END);
    expect(visits.some((visit) => visit.startsAt.includes(BLANTON_WINDOW_START.slice(0, 10)))).toBe(true);
    expect(visits.filter((visit) => visit.technicians.length === 0)).toHaveLength(1);
  });

  it("keeps the completed invoiced job out of committed hours, cost, and revenue", () => {
    const result = buildCommittedLabor({
      appointments: visits.map((visit) => ({
        externalJobId: visit.externalJobId,
        externalAppointmentId: visit.externalAppointmentId,
        jobNumber: visit.jobNumber,
        jobStatus: visit.jobStatus,
        startsAt: visit.startsAt,
        endsAt: visit.endsAt,
        status: visit.status,
        active: true,
        technicians: visit.technicians,
      })),
      links: [
        { externalJobId: BLANTON_OPEN_JOB, jobNumber: "261001", jobStatus: "Scheduled", active: true },
        { externalJobId: BLANTON_PRICED_JOB, jobNumber: "261002", jobStatus: "InProgress", active: true },
        { externalJobId: BLANTON_CLOSED_JOB, jobNumber: "260260", jobStatus: "Completed", active: true },
      ],
      invoiceLines: [
        { externalJobId: BLANTON_CLOSED_JOB, sku: "MHM.25PLFE", kind: "labor", total: 4200 },
        { externalJobId: BLANTON_PRICED_JOB, sku: "MHM.25PLFE", kind: "labor", total: 800 },
        { externalJobId: BLANTON_PRICED_JOB, sku: "TILE", kind: "material", total: 50 },
      ],
      actuals: [
        {
          externalJobId: BLANTON_CLOSED_JOB,
          technicianId: "tech-casey",
          hours: 6,
          laborAmount: 900,
          burdenAmount: 180,
          burdenUnset: false,
        },
      ],
      rates: [{ technicianId: "tech-casey", burdenRate: 12 }],
      billableRate: 188,
    });
    expect(result.hours).toBe(180);
    expect(result.hours).not.toBe(196);
    expect(result.jobs.map((job) => job.jobId).sort()).toEqual([BLANTON_OPEN_JOB, BLANTON_PRICED_JOB]);
    expect(result.revenue).toBe(23360);
    expect(result.revenue).not.toBe(27560);
    expect(result.cost).toBe(7712);
    expect(result.actualJobIds).toEqual([BLANTON_CLOSED_JOB]);
    expect(result.actualHours).toBe(6);
    expect(result.actualCost).toBe(1080);
    expect(result.revenueEstimated).toBe(true);
    const open = result.jobs.find((job) => job.jobId === BLANTON_OPEN_JOB);
    const priced = result.jobs.find((job) => job.jobId === BLANTON_PRICED_JOB);
    expect(open?.hours).toBe(120);
    expect(open?.revenueSource).toBe("estimated");
    expect(priced?.revenue).toBe(800);
    expect(priced?.revenueSource).toBe("invoice");
    expect(priced?.flags).toEqual(expect.arrayContaining([FLAG_UNASSIGNED, FLAG_BURDEN]));
    expect(priced?.technicians).toEqual(expect.arrayContaining([BLANTON_CASEY.name, BLANTON_RILEY.name, "Unassigned"]));
  });
});

describe("committed labor on the financials summary", () => {
  let h: Harness;
  let t: TenantFixture;
  let projectId: string;

  beforeAll(async () => {
    h = await startHarness(SCHEMA_FILES);
    t = await createTenant(h, { slug: "committed-labor" });
    projectId = (
      await h.as(t.staff.owner!.token).post("/api/v1/projects/projects").send(projectBody({ name: "Blanton", project_number: "321612166" }))
    ).body.data.id;
    await h.db.withTenant(t.id, async (db) => {
      await db.query(
        `UPDATE projects.projects
            SET business_unit_id = NULL, budgeted_labor_hours = 400, contract_value = 62000
          WHERE id = $1`,
        [projectId],
      );
      const code = await db.query<{ id: string }>(
        `SELECT id FROM projects.cost_codes WHERE tenant_id = $1 LIMIT 1`,
        [t.id],
      );
      await db.query(
        `INSERT INTO projects.budget_lines (tenant_id, project_id, cost_code_id, cost_type, budget_amount)
         VALUES ($1,$2,$3,'L',20000)`,
        [t.id, projectId, code.rows[0]!.id],
      );
      const system = await db.query<{ id: string }>(
        `INSERT INTO projects.external_systems (tenant_id, adapter_key, display_name)
         VALUES ($1,'servicetitan','ServiceTitan') RETURNING id`,
        [t.id],
      );
      const systemId = system.rows[0]!.id;
      await db.query(
        `INSERT INTO projects.project_job_links
           (tenant_id, project_id, external_system_id, external_job_id, title, source_active, source_job_number, source_job_status)
         VALUES
           ($1,$2,$3,'260260','Blanton closed', true, '260260', 'Completed'),
           ($1,$2,$3,'261001','Blanton scheduled', true, '261001', 'Scheduled'),
           ($1,$2,$3,'261002','Blanton in progress', true, '261002', 'InProgress')`,
        [t.id, projectId, systemId],
      );
      for (const visit of blantonCommittedAppointments()) {
        await db.query(
          `INSERT INTO projects.st_plan_appointments
             (tenant_id, project_id, external_job_id, external_appointment_id, job_number, appointment_number,
              job_status, starts_at, ends_at, status, active, technicians)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11::jsonb)`,
          [
            t.id,
            projectId,
            visit.externalJobId,
            visit.externalAppointmentId,
            visit.jobNumber,
            visit.appointmentNumber,
            visit.jobStatus,
            visit.startsAt,
            visit.endsAt,
            visit.status,
            JSON.stringify(visit.technicians),
          ],
        );
      }
      await db.query(
        `INSERT INTO projects.st_invoice_lines
           (tenant_id, project_id, external_invoice_id, external_job_id, line_key, sku, kind, quantity, total)
         VALUES
           ($1,$2,'closed-inv','260260','labor','MHM.25PLFE','labor',6,4200),
           ($1,$2,'open-inv','261002','labor','MHM.25PLFE','labor',8,800),
           ($1,$2,'open-inv','261002','materials','TILE','material',1,50)`,
        [t.id, projectId],
      );
      await db.query(
        `INSERT INTO projects.labor_actuals
           (tenant_id, project_id, external_job_id, external_timesheet_id, external_technician_id,
            technician_name, work_date, hours, source, labor_amount, burden_amount, pay_basis, burden_unset)
         VALUES ($1,$2,'260260','blanton-ts','tech-casey','Casey Nguyen','2026-11-16',6,'timesheet',900,180,'hourly',false)`,
        [t.id, projectId],
      );
      await db.query(
        `INSERT INTO projects.technician_labor_rates
           (tenant_id, external_technician_id, technician_name, active, burden_rate, pay_basis, burden_unset, is_field_tech)
         VALUES ($1,'tech-casey','Casey Nguyen',true,12,'commission',false,true)`,
        [t.id],
      );
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  it("reads the null-business-unit project from stored appointments and does not double count", async () => {
    const stored = await h.db.withTenant(t.id, (db) =>
      db.query<{ n: string; scheduled: string; done: string; unit: string | null; starts: Date; ends: Date }>(
        `SELECT count(*)::text AS n,
                count(*) FILTER (WHERE status = 'Scheduled')::text AS scheduled,
                count(*) FILTER (WHERE status = 'Done')::text AS done,
                (SELECT business_unit_id::text FROM projects.projects WHERE id = $1) AS unit,
                min(starts_at) AS starts,
                max(ends_at) AS ends
           FROM projects.st_plan_appointments
          WHERE project_id = $1`,
        [projectId],
      ),
    );
    const row = stored.rows[0]!;
    expect(row.n).toBe("40");
    expect(row.scheduled).toBe("36");
    expect(row.done).toBe("4");
    expect(row.unit).toBeNull();
    expect(row.starts.toISOString()).toContain("2026-10-29");
    expect(row.ends.toISOString()).toContain("2026-11-25");

    const res = await h.as(t.staff.owner!.token).get(`/api/v1/projects/projects/${projectId}/financials/summary`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const committed = res.body.data.committedLabor;
    expect(committed.hours).toBe(180);
    expect(committed.cost).toBe(7712);
    expect(res.body.data.committedCost.value).toBe(committed.cost);
    expect(res.body.data.projectedCost.value).toBe(
      Math.round((res.body.data.actualExpense.value + committed.cost) * 100) / 100,
    );
    expect(res.body.data.costToComplete.value).toBe(
      Math.round(
        (res.body.data.totalBudgetedExpense.value - res.body.data.actualExpense.value - committed.cost) * 100,
      ) / 100,
    );
    expect(committed.revenue).toBe(23360);
    expect(committed.actualHours).toBe(6);
    expect(committed.actualCost).toBe(1080);
    expect(committed.actualJobIds).toEqual(["260260"]);
    expect(committed.jobs.map((job: { jobId: string }) => job.jobId).sort()).toEqual(["261001", "261002"]);
    expect(committed.method).toContain("25%");
    expect(committed.method).toContain("MHM.25PLFE");
    expect(res.body.data.budgetedLaborExpense.value).toBe(20000);
    expect(res.body.data.budgetedLaborHours.value).toBe(400);

    const html = financialsDashboardHtml(res.body.data);
    expect(html).toContain("Labor commitment");
    expect(html).toContain("fin-bar-committed");
    expect(html).toContain("261001");
    expect(html).toContain("261002");
    expect(html).not.toContain(">260260<");
    expect(html).toContain("No technician assigned");
    expect(html).toContain("estimated");
    expect(html).toContain("$7,712.00");
    expect(html).toContain("$1,080.00");
    expect(html).not.toContain('type="date"');
    expect(html).not.toContain('type="datetime');
    const remaining = 20000 - 1080 - 7712;
    expect(html).toContain(remaining.toLocaleString("en-US", { style: "currency", currency: "USD" }));
  });

  it("renders the commitment card only when committed labor was read", () => {
    const dashboard = buildFinancialsDashboard({ actuals: null, serviceTitan: null, budget: null });
    expect(dashboard.committedLabor).toBeUndefined();
    const html = financialsDashboardHtml(dashboard);
    expect(html).not.toContain("Labor commitment");
    expect(html).not.toContain("$0");
  });
});
