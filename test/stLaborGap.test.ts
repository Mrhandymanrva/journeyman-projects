import { readFileSync } from "node:fs";
import express from "express";
import supertest from "supertest";
import { describe, expect, it } from "vitest";
import type { GrossPayItem } from "../src/adapters/serviceTitan.js";
import { readPaidLabor } from "../src/domain/laborActuals.js";
import {
  billedLaborCommission,
  burdenFromArrivedDone,
  chooseLaborCostSource,
  chooseStLaborBurden,
  laborEstimateFromBilled,
  nonPtoGrossPayOnJobs,
  projectPayrollAge,
  stLaborTotal,
} from "../src/domain/stLabor.js";
import { buildStLaborDiagnostic, readStLaborDiagnostic } from "../src/domain/stLaborDiagnostic.js";
import { errorHandler } from "../src/http/envelope.js";
import { stLaborDiagnosticRoutes } from "../src/routes/stLaborDiagnostic.js";
import { classifyInvoiceItem, DALTON_FINANCIALS, financialsFromReads } from "../src/domain/projectFinancials.js";
import { laborCardHtml } from "../client/laborCard.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";

const fixture = JSON.parse(readFileSync("test/fixtures/st-payroll/labor-gap-diagnostic.json", "utf8")) as {
  stProjectId: string;
  jobs: Array<{ id: string; jobStatus: string; createdOn: string }>;
  timesheetTimeWithoutJob: { count: number; withPaidHours: number };
  grossPayItems: GrossPayItem[];
  timesheets: Array<{
    id: string;
    jobId: string;
    technicianId: string;
    technicianName: string;
    dispatchedOn?: string | null;
    arrivedOn?: string | null;
    doneOn?: string | null;
    canceledOn?: string | null;
    paidDurationHours?: number | null;
  }>;
  burdenRates: Record<string, number>;
  adjustments: Array<{
    id: string;
    employeeId: string;
    amount: number;
    jobId: string | null;
    invoiceId: string | null;
    postedOn: string;
    memo: string;
  }>;
  invoiceIds: string[];
};

const grossDoc = JSON.parse(readFileSync("test/fixtures/st-payroll/gross-pay-items-doc.json", "utf8")) as {
  pages: Array<{ data: Array<Record<string, unknown>> }>;
};

function docItems(): GrossPayItem[] {
  return grossDoc.pages.flatMap((page) =>
    page.data.map((row) => ({
      id: row.id == null ? null : String(row.id),
      technicianId: row.employeeId == null ? null : String(row.employeeId),
      date: (row.date as string) ?? null,
      activity: (row.activity as string) ?? null,
      amount: (row.amount as number) ?? null,
      amountAdjustment: (row.amountAdjustment as number) ?? null,
      type: (row.grossPayItemType as string) ?? null,
      paidDurationHours: (row.paidDurationHours as number) ?? null,
      paidTimeType: (row.paidTimeType as string) ?? null,
      jobId: row.jobId == null ? null : String(row.jobId),
      projectId: row.projectId == null ? null : String(row.projectId),
    })),
  );
}

describe("payroll hours stay on gross pay", () => {
  it("does not turn job timesheets into labor hours when gross pay has none", async () => {
    let timesheetsRead = false;
    const paid = await readPaidLabor(
      ["100", "200"],
      {
        readGrossPayItems: async () => ({ forbidden: false, items: [] }),
        readJobTimesheets: async () => {
          timesheetsRead = true;
          return { forbidden: false, timesheets: [] };
        },
        readJob: async () => ({ appointments: [], assignments: [] }),
      },
      { dateOnOrAfter: "2026-01-01T00:00:00.000Z" },
    );
    expect(timesheetsRead).toBe(false);
    expect(paid.stamp).toBe(false);
    expect(paid.hoursSource).toBeNull();
    expect(paid.grossPay).toEqual([]);
    expect(paid.results.every((row) => row.outcome === "keep" && row.drafts.length === 0)).toBe(true);
    expect(paid.warnings.join(" ")).toMatch(/no paid timesheet hours/);
  });

  it("keeps gross-pay paid hours when they match the project's jobs", async () => {
    const items = docItems().filter(
      (item) => item.jobId === "100" && item.type === "TimesheetTime" && item.paidTimeType !== "PaidTimeOff",
    );
    const paid = await readPaidLabor(
      ["100", "200"],
      {
        readGrossPayItems: async () => ({ forbidden: false, items }),
        readJobTimesheets: async () => {
          throw new Error("timesheets must not be read for labor hours");
        },
        readJob: async () => ({ appointments: [], assignments: [] }),
      },
      { dateOnOrAfter: "2026-01-01T00:00:00.000Z" },
    );
    expect(paid.hoursSource).toBe("gross-pay");
    expect(paid.stamp).toBe(true);
    expect(paid.results.find((row) => row.jobId === "100")?.drafts.map((draft) => draft.hours).sort()).toEqual([2, 4.75]);
    expect(paid.results.find((row) => row.jobId === "200")?.outcome).toBe("keep");
  });
});

describe("no-payroll labor cost", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");

  it("treats Dalton as older and Segreto as recent", () => {
    expect(
      projectPayrollAge(
        [
          { jobStatus: "Completed", createdOn: "2024-12-19T00:00:00Z" },
          { jobStatus: "Completed", createdOn: "2026-09-11T00:00:00Z" },
        ],
        now,
      ),
    ).toBe("older");
    expect(
      projectPayrollAge([{ jobStatus: "Completed", createdOn: "2026-10-02T00:00:00Z" }], now),
    ).toBe("recent");
    expect(projectPayrollAge([{ jobStatus: "Completed", createdOn: null }], now)).toBe("recent");
    expect(
      chooseLaborCostSource({ payrollReadSucceeded: true, matchingPaidHourRows: 0, age: "older" }),
    ).toBe("billed_labor_25pct");
    expect(
      chooseLaborCostSource({ payrollReadSucceeded: true, matchingPaidHourRows: 0, age: "recent" }),
    ).toBe("none_recent_payroll_missing");
    expect(
      chooseLaborCostSource({ payrollReadSucceeded: true, matchingPaidHourRows: 2, age: "older" }),
    ).toBe("payroll");
    expect(
      chooseLaborCostSource({ payrollReadSucceeded: false, matchingPaidHourRows: 0, age: "older" }),
    ).toBeNull();
  });

  it("prices commission from the reconciled billed labor, excluding MHM 250.Labor", () => {
    const raw = [
      { sku: "MHM.25PLFE", accountName: "Labor Revenue", type: "Service", total: 50000 },
      { sku: "Labor", accountName: "Labor Revenue - Install", type: "Service", total: 16410 },
      { sku: "MHM 250.Labor", accountName: "Labor Revenue", type: "Service", total: 895, invoiceId: "315824798" },
      { sku: "MHM.25LFCO", accountName: "Labor Revenue", type: "Service", total: 120 },
    ];
    const money = financialsFromReads({
      invoiceLines: raw.map((line) => ({ kind: classifyInvoiceItem(line), total: line.total })),
      timesheets: [],
      purchaseOrders: [],
    });
    expect(money.billedLabor).toBe(66410);
    expect(money.billedLabor).not.toBe(DALTON_FINANCIALS.billedLabor);
    const burden = burdenFromArrivedDone(
      [
        {
          id: "ts-1",
          technicianId: "6",
          dispatchedOn: "2026-10-20T11:00:00Z",
          arrivedOn: "2026-10-20T12:00:00Z",
          doneOn: "2026-10-20T16:00:00Z",
        },
        {
          id: "drive-only",
          technicianId: "6",
          dispatchedOn: "2026-10-20T10:00:00Z",
          arrivedOn: "2026-10-20T11:00:00Z",
          doneOn: null,
        },
        {
          id: "ts-long",
          technicianId: "7",
          arrivedOn: "2026-10-21T06:00:00Z",
          doneOn: "2026-10-22T02:00:00Z",
        },
      ],
      new Map([
        ["6", 10],
        ["7", 20],
      ]),
    );
    expect(burden).toEqual({ hours: 18, burden: 320, techsMissingRate: 0 });
    const estimate = laborEstimateFromBilled({
      billedLabor: money.billedLabor,
      burden: burden.burden,
      burdenHours: burden.hours,
    });
    expect(estimate.billed_labor).toBe(66410);
    expect(estimate.commission).toBe(16602.5);
    expect(billedLaborCommission(estimate.billed_labor)).toBe(16602.5);
    expect(estimate.burden).toBe(320);
    expect(estimate.total).toBe(16922.5);
    expect(estimate.label).toBe("Labor at 25% of billed labor (no payroll data)");
    expect(estimate.commission_label).toBe("Commission (25% of billed labor)");
    const html = laborCardHtml(
      {
        hours: 0,
        labor_source: "billed_labor_25pct",
        labor_label: estimate.label,
        commission_label: estimate.commission_label,
        burden_label: estimate.burden_label,
        labor_wage: estimate.commission,
        labor_burden: estimate.burden,
        total: estimate.total,
        observed_at: "2026-10-27T12:00:00.000Z",
      },
      { esc: (value: unknown) => String(value ?? ""), stamp: () => "Oct 27" },
    );
    expect(html).toContain("Commission (25% of billed labor) $16,602.50");
    expect(html).toContain("Labor burden $320.00");
    expect(html).toContain("Total $16,922.50");
    expect(html).not.toContain("MHM.25PLFE only");
    expect(html).not.toContain("drive");
  });
});

describe("ServiceTitan labor reconciliation breakdown", () => {
  it("adds burden, every non-PTO gross-pay type on the project's jobs, and adjustments", () => {
    const items = docItems();
    const gross = nonPtoGrossPayOnJobs(["100", "200"], items);
    expect(gross).toBe(382.5);
    const total = stLaborTotal(87.5, gross, 0);
    expect(total).toBe(470);
    const breakdown = {
      burden: 87.5,
      workHours: 6.75,
      driveHours: 0,
      grossPay: gross,
      adjustments: 0,
      adjustmentsAvailable: true,
      total,
      hoursSource: "gross-pay" as const,
    };
    expect(
      chooseStLaborBurden({
        breakdown,
        projectGrossPayRows: 4,
        previouslyStamped: false,
        priorBurden: 0,
      }),
    ).toEqual({ laborBurden: 470, carriedPrior: false, breakdown });
  });

  it("does not carry a prior 0 for a project that was never stamped", () => {
    expect(
      chooseStLaborBurden({
        breakdown: null,
        projectGrossPayRows: 0,
        previouslyStamped: false,
        priorBurden: 0,
      }),
    ).toEqual({ laborBurden: null, carriedPrior: false, breakdown: null });
    expect(
      chooseStLaborBurden({
        breakdown: null,
        projectGrossPayRows: 0,
        previouslyStamped: true,
        priorBurden: 12,
      }).carriedPrior,
    ).toBe(true);
  });
});

describe("st labor diagnostic", () => {
  const diagnostic = () =>
    buildStLaborDiagnostic({
      stProjectId: fixture.stProjectId,
      windowStart: "2026-01-01T00:00:00.000Z",
      jobs: fixture.jobs,
      grossPay: {
        pagesRead: 2,
        capped: false,
        forbidden: false,
        skipped: 0,
        omitted: 0,
        items: fixture.grossPayItems,
        timesheetTimeWithoutJob: fixture.timesheetTimeWithoutJob,
      },
      timesheets: fixture.timesheets,
      timesheetsForbidden: false,
      burdenRateByTechnician: new Map(Object.entries(fixture.burdenRates)),
      adjustments: { available: true, items: fixture.adjustments },
      invoiceIds: fixture.invoiceIds,
      invoicesUnread: false,
    }, new Date("2026-10-27T12:00:00Z"));

  it("returns aggregates and no personal data", () => {
    const body = diagnostic();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("SECRET");
    expect(raw).not.toContain("Quinlan");
    expect(raw).not.toContain("MEMO");
    expect(raw).not.toContain("13.37");
    expect(raw).not.toMatch(/technicianName|hourlyRate|burdenRate|employeeId|memo/);
    expect(body.known_service_titan_labor).toBe(DALTON_FINANCIALS.laborBurden);
    expect(body.gross_pay.by_type).toEqual([
      expect.objectContaining({
        gross_pay_item_type: "InvoiceRelatedBonus",
        count: 1,
        with_paid_hours: 0,
        sum_amount: 85,
        paid_time_off_count: 0,
      }),
      expect.objectContaining({
        gross_pay_item_type: "TimesheetTime",
        count: 2,
        with_paid_hours: 2,
        sum_paid_hours: 10,
        sum_amount: 90,
        paid_time_off_count: 1,
        paid_time_off_amount: 40,
      }),
    ]);
    expect(body.gross_pay.per_job).toEqual([
      { job_id: "100", count: 3 },
      { job_id: "101", count: 0 },
    ]);
    expect(body.gross_pay.rows_with_job_id).toBe(4);
    expect(body.gross_pay.rows_without_job_id).toBe(1);
    expect(body.gross_pay.matching_paid_hour_rows).toBe(1);
    expect(body.gross_pay.project_tech_rows_on_other_jobs).toBe(1);
    expect(body.gross_pay.project_tech_rows_without_job).toBe(1);
    expect(body.gross_pay.date_range.earliest).toBe("2026-10-20T00:00:00Z");
    expect(body.gross_pay.payroll_ids).toEqual([]);
    expect(body.project_age).toBe("older");
    expect(body.labor_source).toBe("payroll");
    expect(body.gross_pay.project_rows_job_not_in_list).toBe(1);
    expect(body.gross_pay.timesheet_time_without_job_id).toEqual({ count: 3, with_paid_hours: 1 });
    expect(body.job_timesheets.skipped_canceled_jobs).toBe(1);
    expect(body.job_timesheets.arrived_done_hours).toBe(18);
    expect(body.job_timesheets.jobs).toEqual([
      expect.objectContaining({ job_id: "100", row_count: 4, canceled_rows: 1, arrived_done_hours: 18 }),
    ]);
    expect(body.project_labor_expense).toMatchObject({ available: false, endpoint: null, amount: null, delta: null });
    expect(body.timesheet_burden).toMatchObject({
      hours: 18,
      amount: 333.48,
      included_in_labor_hours: false,
      service_titan_labor: 21883.04,
      delta: -21549.56,
    });
    expect(body.payroll_adjustments).toMatchObject({ available: true, count: 2, sum: 15, tied_by: "job-or-invoice", untied: 1 });
    expect(body.timesheet_burden.note).toMatch(/not a match/);
    expect(body.timesheet_burden.included_in_labor_hours).toBe(false);
  });

  it("does not request timesheets for a canceled job", async () => {
    const asked: string[][] = [];
    const app = express();
    app.use(
      "/api/v1/diagnostics",
      stLaborDiagnosticRoutes(
        { tenantId: "00000000-0000-4000-8000-000000000001", token: "portfolio-feed-token-for-tests-0001" },
        {
          serviceTitan: {
            tenantId: "00000000-0000-4000-8000-000000000001",
            externalSystemId: "00000000-0000-4000-8000-000000000002",
            key: "st:test",
            client: {
              readJob: async () => ({ job: { id: "1" }, appointments: [], assignments: [], observedAt: "" }),
              readProjectJobs: async () => fixture.jobs.map((job) => ({ ...job, jobNumber: job.id, completedOn: null })),
              readGrossPayItems: async () => ({
                forbidden: false,
                items: fixture.grossPayItems,
                skipped: 0,
                omitted: 0,
                capped: false,
                pagesRead: 1,
                timesheetTimeWithoutJob: fixture.timesheetTimeWithoutJob,
              }),
              readJobTimesheetsForJobs: async (jobIds: readonly string[]) => {
                asked.push([...jobIds]);
                return { forbidden: false, timesheets: fixture.timesheets };
              },
              readTechnicians: async () =>
                Object.entries(fixture.burdenRates).map(([id, burdenRate]) => ({
                  id,
                  name: "Quinlan Placeholder",
                  burdenRate,
                })),
              readPayrollAdjustments: async () => ({
                forbidden: false,
                unavailable: false,
                capped: false,
                items: fixture.adjustments,
              }),
              readInvoicesForJobs: async () => ({
                forbidden: false,
                invoices: fixture.invoiceIds.map((id) => ({ externalInvoiceId: id })),
              }),
            } as unknown as NonNullable<SourceConnections["serviceTitan"]>["client"],
          },
        },
      ),
    );
    app.use(errorHandler);
    const http = supertest(app);
    expect((await http.get("/api/v1/diagnostics/st-labor?stProjectId=290588725")).status).toBe(401);
    expect((await http.get("/api/v1/diagnostics/st-labor").set("Authorization", "Bearer portfolio-feed-token-for-tests-0001")).status).toBe(400);
    const ok = await http
      .get("/api/v1/diagnostics/st-labor?stProjectId=290588725")
      .set("Authorization", "Bearer portfolio-feed-token-for-tests-0001");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(asked).toEqual([["100"]]);
    expect(JSON.stringify(ok.body)).not.toContain("Quinlan");
    expect(ok.body.data.labor_source).toBe("payroll");
    expect(ok.body.data.timesheet_burden.included_in_labor_hours).toBe(false);
    expect(ok.body.data.project_labor_expense.available).toBe(false);
    const report = await readStLaborDiagnostic(
      {
        readProjectJobs: async () => [],
        readGrossPayItems: async () => ({ forbidden: false, items: [] }),
      },
      "nope",
    ).catch((err: unknown) => err);
    expect(report).toBeInstanceOf(Error);
  });
});
