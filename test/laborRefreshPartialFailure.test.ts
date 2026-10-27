import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GrossPayItem } from "../src/adapters/serviceTitan.js";
import {
  draftsFromGrossPay,
  draftsFromTimesheets,
  readLaborJobs,
  readPaidLabor,
} from "../src/domain/laborActuals.js";
import { readStoredProjectMoney, readStoredReconciliation } from "../src/domain/projectSync.js";
import { refreshLinkedProject } from "../src/workers/laborRefresh.js";
import {
  createTenant,
  projectBody,
  SCHEMA_FILES,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

// The documented GrossPayItemResponse, mapped the way the adapter maps it.
const doc = JSON.parse(readFileSync("test/fixtures/st-payroll/gross-pay-items-doc.json", "utf8")) as {
  pages: Array<{ data: Array<Record<string, any>> }>;
};
const grossPay: GrossPayItem[] = doc.pages.flatMap((page) =>
  page.data.map((row) => ({
    id: String(row.id),
    technicianId: row.employeeId == null ? null : String(row.employeeId),
    date: row.date ?? null,
    activity: row.activity ?? null,
    amount: row.amount ?? null,
    type: row.grossPayItemType ?? null,
    paidDurationHours: row.paidDurationHours ?? null,
    paidTimeType: row.paidTimeType ?? null,
    jobId: row.jobId == null ? null : String(row.jobId),
  })),
);

// Live payroll/v2 jobs/{job}/timesheets row (the endpoint #37 used): punch
// stamps only, no paid duration.
const punchRow = {
  id: "1",
  appointmentId: "4",
  technicianId: "6",
  technicianName: null,
  dispatchedOn: "2026-10-20T11:30:00Z",
  arrivedOn: "2026-10-20T12:00:00Z",
  doneOn: "2026-10-20T16:30:00Z",
  canceledOn: null,
  paidDurationHours: null,
};

describe("labor hours come from ServiceTitan payroll paid time only", () => {
  it("never turns dispatch or arrive clicks into hours", () => {
    expect(draftsFromTimesheets([punchRow])).toEqual([]);
  });

  it("sums TimesheetTime paid hours per technician per job and skips bonuses, PTO, zero, and other jobs", () => {
    const byJob = draftsFromGrossPay(["100", "200"], grossPay);
    expect([...byJob.keys()]).toEqual(["100"]);
    expect(byJob.get("100")!.map((d) => [d.externalTechnicianId, d.hours, d.workDate])).toEqual([
      ["6", 4.75, "2026-10-20"],
      ["7", 2, "2026-10-19"],
    ]);
    expect(byJob.get("100")!.every((d) => d.source === "timesheet")).toBe(true);
  });

  it.each([
    ["throws", async () => { throw new Error("ServiceTitan read failed (HTTP 500)."); }, /HTTP 500/],
    ["is denied", async () => ({ forbidden: true, items: [] }), /HTTP 403/],
    ["has no paid hours", async () => ({ forbidden: false, items: grossPay.filter((i) => i.jobId === "999") }), /no paid timesheet hours/],
  ] as const)("keeps every job's hours and the stamp when gross pay %s", async (_label, read, warning) => {
    const paid = await readPaidLabor(
      ["100", "200"],
      {
        readGrossPayItems: read as any,
        readJobTimesheets: async () => { throw new Error("timesheets must not be read"); },
        readJob: async () => ({ appointments: [], assignments: [] }),
      },
      { dateOnOrAfter: "2026-09-16T00:00:00Z" },
    );
    expect(paid.stamp).toBe(false);
    expect(paid.results.map((r) => r.outcome)).toEqual(["keep", "keep"]);
    expect(paid.warnings.join("; ")).toMatch(warning);
    expect(paid.warnings.join("; ")).toMatch(/Stored hours kept/);
  });

  it("keeps stored hours when the gross pay read hits the 200-page cap", async () => {
    const paid = await readPaidLabor(
      ["100"],
      {
        readGrossPayItems: async () => ({ forbidden: false, items: grossPay, capped: true }),
        readJobTimesheets: async () => {
          throw new Error("timesheets must not be read");
        },
        readJob: async () => ({ appointments: [], assignments: [] }),
      },
      { dateOnOrAfter: "2025-01-01T00:00:00.000Z" },
    );
    expect(paid.stamp).toBe(false);
    expect(paid.payroll).toBe("failed");
    expect(paid.grossPay).toBeNull();
    expect(paid.results.map((result) => result.outcome)).toEqual(["keep"]);
    expect(paid.warnings.join(" ")).toMatch(/200 pages/);
    expect(paid.warnings.join(" ")).toMatch(/Stored hours kept/);
  });

  it("replaces hours only on jobs that have paid time and moves the stamp", async () => {
    const paid = await readPaidLabor(
      ["100", "200"],
      {
        readGrossPayItems: async () => ({ forbidden: false, items: grossPay }),
        readJobTimesheets: async () => ({ forbidden: false, timesheets: [] }),
        readJob: async () => ({ appointments: [], assignments: [] }),
      },
      { dateOnOrAfter: "2026-09-16T00:00:00Z" },
    );
    expect(paid.stamp).toBe(true);
    expect(paid.warnings).toEqual([]);
    expect(paid.results.map((r) => [r.jobId, r.outcome, r.drafts.length])).toEqual([
      ["100", "timesheet", 2],
      ["200", "keep", 0],
    ]);
  });

  it("treats a payroll timesheet 403 as a failed read: keep, warn, no stamp", async () => {
    const results = await readLaborJobs(["1", "2"], {
      readJobTimesheets: async (jobId) => {
        if (jobId === "1") throw new Error("ServiceTitan read failed (HTTP 500).");
        return { forbidden: true, timesheets: [] };
      },
      readJob: async () => ({ appointments: [], assignments: [] }),
    });
    expect(results.map((r) => [r.outcome, r.failed])).toEqual([
      ["keep", true],
      ["keep", true],
    ]);
    expect(results[1]?.warning).toMatch(/HTTP 403/);
  });
});

describe("manual refresh with partial ServiceTitan failures", () => {
  let h: Harness;
  let t: TenantFixture;
  const SYSTEM_ID = "22222222-2222-4222-8222-222222222222";
  let projectId = "";
  let payroll: "error" | "denied" | "empty" | "paid" = "error";
  const conn: any = {
    tenantId: "",
    externalSystemId: SYSTEM_ID,
    key: "st:test",
    client: {
      sourceTenantId: "st-test",
      readProjectJobs: async () => [
        { id: "100", jobNumber: "100", jobStatus: "Completed", createdOn: "2026-09-17T16:00:00Z", completedOn: null },
        { id: "200", jobNumber: "200", jobStatus: "Completed", createdOn: "2026-10-01T16:00:00Z", completedOn: null },
      ],
      readJob: async (id: string) => ({
        job: { id, jobNumber: id, jobStatus: "Completed" },
        appointments: [],
        assignments: [],
      }),
      readJobInvoiceLines: async (jobId: string) => {
        if (jobId === "200") throw new Error("Unexpected ServiceTitan invoice items.");
        return [
          { invoiceId: "1", lineKey: "1", sku: "MHM.25PLFE", kind: "labor", quantity: 1, total: 1000, technicianId: "6" },
        ];
      },
      readJobPurchaseOrders: async () => [],
      readJobTimesheets: async () => ({ forbidden: false, timesheets: [] }),
      windows: [] as string[],
      readGrossPayItems: async (query: { dateOnOrAfter: string }) => {
        conn.client.windows.push(query.dateOnOrAfter);
        if (payroll === "error") throw new Error("ServiceTitan read failed (HTTP 500).");
        if (payroll === "denied") return { forbidden: true, items: [] };
        if (payroll === "empty") return { forbidden: false, items: [] };
        return { forbidden: false, items: grossPay };
      },
    },
  };
  const laborCode = { ok: false, reason: "missing", message: "test" } as const;

  beforeAll(async () => {
    h = await startHarness(SCHEMA_FILES, { serviceTitan: conn });
    t = await createTenant(h, { slug: "partial", displayName: "Partial" });
    conn.tenantId = t.id;
    const created = await h.as(t.staff.owner!.token).post("/api/v1/projects/projects").send(
      projectBody({ project_number: "P-1", name: "Partial failure project" }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    projectId = created.body.data.id;
    await h.db.withTenant(t.id, async (db) => {
      await db.query(
        `INSERT INTO projects.external_systems (id, tenant_id, adapter_key, display_name)
         VALUES ($1, $2, 'servicetitan', 'ServiceTitan')`,
        [SYSTEM_ID, t.id],
      );
      await db.query(
        `INSERT INTO projects.st_project_connections
           (project_id, tenant_id, external_system_id, external_project_id, connection_key, snapshot, observed_at, linked_by)
         VALUES ($1, $2, $3, '1', 'st:test', '{}'::jsonb, now(), $4)`,
        [projectId, t.id, SYSTEM_ID, t.staff.owner!.id],
      );
      // What production held before the bad refresh: 6.5 h on job 100, an
      // invoice line on job 200, and a labor stamp.
      await db.query(
        `INSERT INTO projects.labor_actuals
           (tenant_id, project_id, external_job_id, external_timesheet_id, external_technician_id,
            technician_name, work_date, hours, source)
         VALUES ($1, $2, '100', 'old-1', '6', 'Tech A', '2026-10-01', 6.5, 'timesheet')`,
        [t.id, projectId],
      );
      await db.query(
        `INSERT INTO projects.st_invoice_lines
           (tenant_id, project_id, external_invoice_id, external_job_id, line_key, sku, kind, quantity, total, technician_id, observed_at)
         VALUES ($1, $2, '9', '200', '1', 'MAT', 'material', 1, 250, null, now())`,
        [t.id, projectId],
      );
      await db.query(
        `UPDATE projects.projects SET labor_refreshed_at = '2026-10-26T06:00:00Z', labor_refresh_source = 'scheduled' WHERE id = $1`,
        [projectId],
      );
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  const state = () =>
    h.db.withTenant(t.id, async (db) => {
      const r = await db.query<{ hours: string }>(
        `SELECT COALESCE(SUM(hours), 0)::text AS hours FROM projects.labor_actuals WHERE project_id = $1`,
        [projectId],
      );
      const p = await db.query<{ at: Date; source: string }>(
        `SELECT labor_refreshed_at AS at, labor_refresh_source AS source FROM projects.projects WHERE id = $1`,
        [projectId],
      );
      return {
        hours: Number(r.rows[0]?.hours),
        stamp: new Date(p.rows[0]!.at).toISOString(),
        source: p.rows[0]!.source,
      };
    });

  it.each(["error", "denied", "empty"] as const)(
    "payroll %s: hours, stamp, and the other job's invoice lines survive; the warning is recorded",
    async (mode) => {
      payroll = mode;
      const { warnings } = await refreshLinkedProject(h.db, conn, t.id, projectId, new Date(), laborCode, "manual");
      expect(await state()).toEqual({ hours: 6.5, stamp: "2026-10-26T06:00:00.000Z", source: "scheduled" });
      const money = await h.db.withTenant(t.id, (db) => readStoredProjectMoney(db, projectId));
      expect(money.billedLabor).toBe(1000);
      expect(money.billedMaterials).toBe(250);
      const rec = await h.db.withTenant(t.id, (db) => readStoredReconciliation(db, projectId));
      expect(rec?.error).toMatch(/Job 200 invoices: Unexpected ServiceTitan invoice items/);
      expect(rec?.error).toMatch(/Payroll gross pay items: .*Stored hours kept/);
      expect(warnings.join("; ")).toMatch(
        mode === "error" ? /HTTP 500/ : mode === "denied" ? /HTTP 403/ : /no paid timesheet hours/,
      );
      // Window starts a day before the project's first job.
      expect(conn.client.windows.at(-1)).toBe("2026-09-16T16:00:00.000Z");
    },
  );

  it("a good payroll read replaces hours and burden that were wiped to 0", async () => {
    payroll = "paid";
    conn.client.readTechnicians = async () => [
      { id: "6", name: "Tech A", active: true, hourlyRate: 30, burdenRate: 10, commissionRate: null, isManagedTech: true },
      { id: "7", name: "Tech B", active: true, hourlyRate: 30, burdenRate: 20, commissionRate: null, isManagedTech: true },
    ];
    await h.db.withTenant(t.id, (db) =>
      db.query(
        `UPDATE projects.labor_actuals
            SET hours = 0, burden_amount = 0, labor_amount = 0, technician_name = NULL
          WHERE project_id = $1`,
        [projectId],
      ),
    );
    const at = new Date("2026-10-27T16:32:56Z");
    const { warnings } = await refreshLinkedProject(h.db, conn, t.id, projectId, at, laborCode, "manual");
    expect(warnings.some((warning) => /Stored hours kept/.test(warning))).toBe(false);
    const money = await h.db.withTenant(t.id, (db) => readStoredProjectMoney(db, projectId));
    expect(money.laborBurden).toBe(87.5);
    const rec = await h.db.withTenant(t.id, (db) => readStoredReconciliation(db, projectId));
    expect(rec?.error ?? "").not.toMatch(/Stored hours kept/);
    expect(rec?.technicians.map((tech) => [tech.technician_id, tech.hours])).toEqual(
      expect.arrayContaining([
        ["6", 4.75],
        ["7", 2],
      ]),
    );
    expect(rec?.lines.find((line) => line.key === "laborBurden")).toMatchObject({
      jp: 87.5,
      st: 470,
      delta: -382.5,
    });
    expect(rec?.st_labor).toMatchObject({
      burden: 87.5,
      grossPay: 382.5,
      adjustments: null,
      adjustmentsAvailable: false,
      total: 470,
      hoursSource: "gross-pay",
      driveHours: 0,
    });
    expect(await state()).toMatchObject({ hours: 6.75, source: "manual" });
  });

  it("paid gross pay hours replace stored hours per technician and move the stamp", async () => {
    payroll = "paid";
    const at = new Date("2026-10-27T13:00:00Z");
    const { warnings } = await refreshLinkedProject(h.db, conn, t.id, projectId, at, laborCode, "manual");
    expect(warnings.some((w) => /Payroll/.test(w))).toBe(false);
    expect(await state()).toEqual({ hours: 6.75, stamp: at.toISOString(), source: "manual" });
    const rec = await h.db.withTenant(t.id, (db) => readStoredReconciliation(db, projectId));
    expect(rec?.technicians.map((tech: any) => [tech.technician_id, tech.hours])).toEqual(
      expect.arrayContaining([["6", 4.75], ["7", 2]]),
    );
  });
});
