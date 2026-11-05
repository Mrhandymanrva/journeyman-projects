import { describe, expect, it } from "vitest";
import type { GrossPayItem } from "../src/adapters/serviceTitan.js";
import { DALTON_FINANCIALS, SEGRETO_FINANCIALS } from "../src/domain/projectFinancials.js";
import { buildStLaborDiagnostic, readStLaborDiagnostic } from "../src/domain/stLaborDiagnostic.js";
import {
  activityBurdenReport,
  classifyActivityEvent,
  commissionBreakdown,
  pausedGapHours,
  payrollFinalized,
  projectDateRange,
  splitProjectAdjustments,
  type ActivityEvent,
  type PayrollPeriodFact,
} from "../src/domain/stLaborDiagnosticDetail.js";

const DALTON_LABOR = DALTON_FINANCIALS.laborBurden;
const SEGRETO_LABOR = SEGRETO_FINANCIALS.laborBurden;
const DALTON_POSTED = 16788.54;
const SEGRETO_POSTED = 3142.42;

function bonus(overrides: Partial<GrossPayItem> & Pick<GrossPayItem, "id" | "amount">): GrossPayItem {
  return {
    technicianId: "tech-SECRET-77",
    date: "2026-10-20T00:00:00Z",
    activity: "Commission",
    type: "InvoiceRelatedBonus",
    paidDurationHours: null,
    paidTimeType: null,
    jobId: "100",
    ...overrides,
  };
}

function period(overrides: Partial<PayrollPeriodFact> & Pick<PayrollPeriodFact, "id">): PayrollPeriodFact {
  return {
    status: null,
    startedOn: null,
    endedOn: null,
    approvedOn: null,
    ...overrides,
  };
}

describe("commission row breakdown", () => {
  const periods = [
    period({
      id: "11",
      status: "Approved",
      startedOn: "2026-09-01T00:00:00Z",
      endedOn: "2026-09-30T00:00:00Z",
      approvedOn: "2026-10-05T00:00:00Z",
    }),
    period({
      id: "12",
      status: "Pending",
      startedOn: "2026-10-01T00:00:00Z",
      endedOn: "2026-10-31T00:00:00Z",
    }),
  ];
  const items = [
    bonus({ id: "before", amount: 10000, date: "2026-09-15T00:00:00Z", payrollId: "11" }),
    bonus({ id: "after", amount: 788.54, date: "2026-10-02T00:00:00Z", payrollId: "11" }),
    bonus({ id: "open", amount: 5000, date: "2026-10-20T00:00:00Z", payrollId: "12" }),
    bonus({ id: "unknown", amount: 1000, date: "2026-11-02T00:00:00Z", payrollId: "13" }),
    bonus({ id: "pto", amount: 40, paidTimeType: "PaidTimeOff", payrollId: "11" }),
    bonus({ id: "old", amount: 9, date: "2022-08-01T00:00:00Z", payrollId: "11" }),
    bonus({ id: "other-job", amount: 7, jobId: "999", payrollId: "11" }),
    bonus({ id: "time", amount: 50, type: "TimesheetTime", paidTimeType: "Regular", payrollId: "55" }),
  ];

  it("groups Dalton's posted commission and leaves the residual that matches 5,094.50", () => {
    const body = commissionBreakdown({
      jobIds: ["100", "101"],
      items,
      periods,
      payrollStatusAvailable: true,
      knownLabor: DALTON_LABOR,
    });
    expect(body.rows).toBe(4);
    expect(body.total).toBe(DALTON_POSTED);
    expect(body.earliest).toBe("2026-09-15T00:00:00Z");
    expect(body.latest).toBe("2026-11-02T00:00:00Z");
    expect(body.by_month).toEqual([
      { month: "2026-09", count: 1, total: 10000 },
      { month: "2026-10", count: 2, total: 5788.54 },
      { month: "2026-11", count: 1, total: 1000 },
    ]);
    expect(body.by_finalized).toEqual([
      { finalized: "yes", count: 2, total: 10788.54 },
      { finalized: "no", count: 1, total: 5000 },
      { finalized: "unknown", count: 1, total: 1000 },
    ]);
    const approved = body.by_payroll.find((row) => row.payroll_id === "11");
    expect(approved).toMatchObject({
      status: "Approved",
      finalized: "yes",
      close_at: "2026-09-30T00:00:00Z",
      count: 2,
      total: 10788.54,
      on_or_before_close: { count: 1, total: 10000 },
      after_close: { count: 1, total: 788.54 },
    });
    expect(body.by_payroll.find((row) => row.payroll_id === "12")).toMatchObject({
      finalized: "no",
      on_or_before_close: { count: 1, total: 5000 },
      after_close: { count: 0, total: 0 },
    });
    expect(body.by_payroll.find((row) => row.payroll_id === "13")).toMatchObject({
      finalized: "unknown",
      status: null,
      close_at: null,
      on_or_before_close: null,
      after_close: null,
    });
    expect(body.residuals.find((row) => row.subset === "all_posted")).toMatchObject({
      commission_total: DALTON_POSTED,
      basis: "st_labor_minus_posted_commission",
      burden_target: 5094.5,
    });
    expect(body.residuals.find((row) => row.subset === "finalized")).toMatchObject({
      commission_total: 10788.54,
      basis: "st_labor_minus_posted_commission",
      burden_target: 11094.5,
    });
    expect(body.residuals.find((row) => row.subset === "month:2026-09")).toMatchObject({
      burden_target: 11883.04,
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("SECRET");
    expect(raw).not.toMatch(/technicianName|hourlyRate|burdenRate|employeeId/);
  });

  it("treats Segreto's posted commission as above ServiceTitan labor, so the burden target stays 2,440.43", () => {
    const body = commissionBreakdown({
      jobIds: ["100"],
      items: [bonus({ id: "segreto", amount: SEGRETO_POSTED })],
      periods: [],
      payrollStatusAvailable: false,
      knownLabor: SEGRETO_LABOR,
    });
    expect(body.residuals.find((row) => row.subset === "all_posted")).toMatchObject({
      commission_total: SEGRETO_POSTED,
      basis: "st_labor_burden_only",
      burden_target: SEGRETO_LABOR,
    });
  });

  it("does not treat an unapproved payroll as finalized", () => {
    expect(payrollFinalized(period({ id: "1", status: "Unapproved" }))).toBe("no");
    expect(payrollFinalized(period({ id: "1", status: "Approved" }))).toBe("yes");
    expect(payrollFinalized(period({ id: "1", status: "Paid" }))).toBe("yes");
    expect(payrollFinalized(period({ id: "1", status: "Pending" }))).toBe("no");
    expect(payrollFinalized(period({ id: "1", status: "Weird" }))).toBe("unknown");
    expect(payrollFinalized(period({ id: "1", status: null, approvedOn: "2026-10-05T00:00:00Z" }))).toBe("yes");
    expect(payrollFinalized(period({ id: "1", status: null, approvedOn: "2022-08-01T00:00:00Z" }))).toBe("unknown");
    expect(payrollFinalized(undefined)).toBe("unknown");
  });
});

describe("arrive-to-done burden with pauses removed", () => {
  const active = new Set(["100"]);

  function event(overrides: Partial<ActivityEvent> & Pick<ActivityEvent, "at" | "kind">): ActivityEvent {
    return {
      jobId: "100",
      appointmentId: "7",
      technicianId: "tech-SECRET-77",
      ...overrides,
    };
  }

  it("ignores dispatch, removes the paused gap, and caps a span at 14 hours", () => {
    expect(classifyActivityEvent({ eventType: "Dispatched" })).toBeNull();
    expect(classifyActivityEvent({ eventType: "Note", memo: "Paused for parts" })).toBe("paused");
    expect(classifyActivityEvent({ status: "Done" })).toBe("done");

    const day = pausedGapHours(
      [
        event({ at: "2026-10-20T07:00:00Z", kind: "arrived" }),
        event({ at: "2026-10-20T08:00:00Z", kind: "arrived" }),
        event({ at: "2026-10-20T10:00:00Z", kind: "paused" }),
        event({ at: "2026-10-20T11:00:00Z", kind: "resumed" }),
        event({ at: "2026-10-20T15:00:00Z", kind: "done" }),
      ].slice(1),
      active,
    );
    expect(day.spanCount).toBe(2);
    expect(day.pausesRemoved).toBe(1);
    expect(day.slices.map((slice) => slice.hours)).toEqual([2, 4]);

    const resumedByWorking = pausedGapHours(
      [
        event({ at: "2026-10-20T08:00:00Z", kind: "arrived" }),
        event({ at: "2026-10-20T10:00:00Z", kind: "paused" }),
        event({ at: "2026-10-20T11:00:00Z", kind: "working" }),
        event({ at: "2026-10-20T15:00:00Z", kind: "done" }),
      ],
      active,
    );
    expect(resumedByWorking.slices.map((slice) => slice.hours)).toEqual([2, 4]);

    const capped = pausedGapHours(
      [
        event({ at: "2026-10-21T08:00:00Z", kind: "working" }),
        event({ at: "2026-10-22T04:00:00Z", kind: "done" }),
      ],
      active,
    );
    expect(capped.slices.map((slice) => slice.hours)).toEqual([14]);
    expect(capped.spansCapped).toBe(1);

    const open = pausedGapHours([event({ at: "2026-10-20T08:00:00Z", kind: "arrived" })], active);
    expect(open.slices).toEqual([]);
    expect(open.openIgnored).toBe(1);

    const skipped = pausedGapHours(
      [
        event({ at: "2022-08-01T08:00:00Z", kind: "arrived" }),
        event({ at: "2022-08-01T12:00:00Z", kind: "done" }),
        event({ jobId: "101", at: "2026-10-20T08:00:00Z", kind: "arrived" }),
        event({ jobId: "101", at: "2026-10-20T12:00:00Z", kind: "done" }),
      ],
      active,
    );
    expect(skipped.slices).toEqual([]);
  });

  it("prices the paused-gap hours at each burden rate and shows the gap to both targets", () => {
    const events = [
      event({ at: "2026-10-20T08:00:00Z", kind: "arrived" }),
      event({ at: "2026-10-20T10:00:00Z", kind: "paused" }),
      event({ at: "2026-10-20T11:00:00Z", kind: "resumed" }),
      event({ at: "2026-10-20T15:00:00Z", kind: "done" }),
    ];
    const dalton = commissionBreakdown({
      jobIds: ["100"],
      items: [bonus({ id: "posted", amount: DALTON_POSTED })],
      periods: [],
      payrollStatusAvailable: false,
      knownLabor: DALTON_LABOR,
    });
    const report = activityBurdenReport({
      available: true,
      events,
      activeJobIds: active,
      rates: new Map([["tech-SECRET-77", 13.37]]),
      residuals: dalton.residuals,
      note: null,
    });
    expect(report).toMatchObject({
      available: true,
      hours: 6,
      amount: 80.22,
      techs_missing_rate: 0,
      pause_gaps_removed: 1,
      cap_hours: 14,
      drive_included: false,
      included_in_burden: false,
    });
    expect(report.gaps.find((row) => row.subset === "all_posted")).toEqual({
      subset: "all_posted",
      burden_target: 5094.5,
      delta: -5014.28,
    });
    const segreto = commissionBreakdown({
      jobIds: ["100"],
      items: [bonus({ id: "posted", amount: SEGRETO_POSTED })],
      periods: [],
      payrollStatusAvailable: false,
      knownLabor: SEGRETO_LABOR,
    });
    const segretoReport = activityBurdenReport({
      available: true,
      events,
      activeJobIds: active,
      rates: new Map([["tech-SECRET-77", 13.37]]),
      residuals: segreto.residuals,
      note: null,
    });
    expect(segretoReport.gaps.find((row) => row.subset === "all_posted")).toEqual({
      subset: "all_posted",
      burden_target: SEGRETO_LABOR,
      delta: -2360.21,
    });
    const raw = JSON.stringify(report);
    expect(raw).not.toContain("SECRET");
    expect(raw).not.toContain("13.37");
    expect(raw).not.toMatch(/technicianName|hourlyRate|burdenRate|employeeId|memo/);
  });

  it("leaves the gap empty when job history was not read", () => {
    const report = activityBurdenReport({
      available: false,
      events: [],
      activeJobIds: active,
      rates: new Map(),
      residuals: [
        {
          subset: "all_posted",
          commission_count: 1,
          commission_total: DALTON_POSTED,
          basis: "st_labor_minus_posted_commission",
          burden_target: 5094.5,
          note: "residual",
        },
      ],
      note: "Job history was not found (HTTP 404).",
    });
    expect(report.hours).toBeNull();
    expect(report.amount).toBeNull();
    expect(report.gaps).toEqual([{ subset: "all_posted", burden_target: 5094.5, delta: null }]);
  });
});

describe("payroll adjustments for the project", () => {
  it("counts untied technician adjustments inside the project dates, and adjustments tied to its jobs", () => {
    const range = projectDateRange(
      [
        { jobStatus: "Completed", createdOn: "2026-01-02T00:00:00Z", completedOn: "2026-06-01T00:00:00Z" },
        { jobStatus: "Canceled", createdOn: "2026-01-01T00:00:00Z", completedOn: "2026-01-04T00:00:00Z" },
      ],
      "2026-10-27T12:00:00Z",
    );
    expect(range).toEqual({ start: "2026-01-02T00:00:00Z", end: "2026-10-27T12:00:00Z" });
    const untied = Array.from({ length: 30 }, (_, index) => ({
      id: `u-${index}`,
      employeeId: "tech-SECRET-77",
      amount: 1.5,
      jobId: null,
      invoiceId: index === 0 ? "inv-1" : null,
      postedOn: "2026-03-15T00:00:00Z",
    }));
    const report = splitProjectAdjustments({
      available: true,
      items: [
        ...untied,
        { id: "tied", employeeId: "tech-SECRET-77", amount: 12, jobId: "100", invoiceId: null, postedOn: "2026-12-01T00:00:00Z" },
        { id: "canceled-job", employeeId: "tech-SECRET-77", amount: 4, jobId: "101", invoiceId: null, postedOn: "2026-02-01T00:00:00Z" },
        { id: "other-job", employeeId: "tech-SECRET-77", amount: 9, jobId: "777", invoiceId: null, postedOn: "2026-03-15T00:00:00Z" },
        { id: "other-tech", employeeId: "tech-SECRET-88", amount: 8, jobId: null, invoiceId: null, postedOn: "2026-03-15T00:00:00Z" },
        { id: "early", employeeId: "tech-SECRET-77", amount: 6, jobId: null, invoiceId: null, postedOn: "2022-08-01T00:00:00Z" },
        { id: "outside", employeeId: "tech-SECRET-77", amount: 5, jobId: null, invoiceId: null, postedOn: "2025-12-01T00:00:00Z" },
      ],
      jobIds: new Set(["100", "101"]),
      technicianIds: new Set(["tech-SECRET-77"]),
      rangeStart: range.start,
      rangeEnd: range.end,
    });
    expect(report.tied_to_project_jobs).toEqual({ count: 2, total: 16 });
    expect(report.untied_for_project_techs).toEqual({ count: 30, total: 45 });
    const raw = JSON.stringify(report);
    expect(raw).not.toContain("SECRET");
    expect(raw).not.toMatch(/employeeId|memo/);
  });
});

describe("diagnostic sections stay off the labor card", () => {
  const jobs = [{ id: "100", jobStatus: "Completed", createdOn: "2026-01-02T00:00:00Z", completedOn: "2026-06-01T00:00:00Z" }];
  const events: ActivityEvent[] = [
    { jobId: "100", appointmentId: "7", technicianId: "tech-SECRET-77", at: "2026-10-20T08:00:00Z", kind: "arrived" },
    { jobId: "100", appointmentId: "7", technicianId: "tech-SECRET-77", at: "2026-10-20T14:00:00Z", kind: "done" },
  ];

  function diagnostic(stProjectId: string, posted: number) {
    return buildStLaborDiagnostic(
      {
        stProjectId,
        windowStart: "2026-01-01T00:00:00.000Z",
        jobs,
        grossPay: {
          pagesRead: 1,
          capped: false,
          forbidden: false,
          skipped: 0,
          omitted: 0,
          items: [bonus({ id: "posted", amount: posted, payrollId: "11" })],
          timesheetTimeWithoutJob: { count: 0, withPaidHours: 0 },
        },
        timesheets: [],
        timesheetsForbidden: false,
        burdenRateByTechnician: new Map([["tech-SECRET-77", 10]]),
        adjustments: { available: true, items: [] },
        invoiceIds: [],
        invoicesUnread: false,
        payrollPeriods: {
          available: true,
          periods: [period({ id: "11", status: "Approved", endedOn: "2026-10-31T00:00:00Z" })],
          note: null,
        },
        activityEvents: { available: true, events, note: null },
      },
      new Date("2026-10-27T12:00:00Z"),
    );
  }

  it("reports Dalton's activity dollars beside 5,094.50 and does not adopt them as burden", () => {
    const body = diagnostic("290588725", DALTON_POSTED);
    expect(body.labor_source).toBe("posted_commission");
    expect(body.posted_commission.amount).toBe(DALTON_POSTED);
    expect(body.live_burden).toMatchObject({ available: false, amount: null, included_in_total: false });
    expect(body.activity_burden).toMatchObject({
      hours: 6,
      amount: 60,
      included_in_burden: false,
      drive_included: false,
    });
    expect(body.activity_burden.gaps.find((row) => row.subset === "all_posted")).toEqual({
      subset: "all_posted",
      burden_target: 5094.5,
      delta: -5034.5,
    });
    expect(body.commission_breakdown.by_payroll[0]).toMatchObject({
      payroll_id: "11",
      finalized: "yes",
      on_or_before_close: { count: 1, total: DALTON_POSTED },
    });
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });

  it("reports Segreto's activity dollars beside 2,440.43", () => {
    const body = diagnostic("321586598", SEGRETO_POSTED);
    expect(body.live_burden.amount).toBeNull();
    expect(body.activity_burden.gaps.find((row) => row.subset === "all_posted")).toEqual({
      subset: "all_posted",
      burden_target: SEGRETO_LABOR,
      delta: -2380.43,
    });
  });

  it("still returns the diagnostic when the extra reads fail", async () => {
    const payrollIds: string[][] = [];
    const historyJobs: string[][] = [];
    const body = await readStLaborDiagnostic(
      {
        readProjectJobs: async () => [
          { id: "100", jobNumber: "100", jobStatus: "Completed", createdOn: "2026-01-02T00:00:00Z", completedOn: null },
          { id: "101", jobNumber: "101", jobStatus: "Canceled", createdOn: "2026-01-03T00:00:00Z", completedOn: null },
        ],
        readGrossPayItems: async () => ({
          forbidden: false,
          items: [
            bonus({ id: "posted", amount: 10, payrollId: "11" }),
            bonus({ id: "pto", amount: 4, paidTimeType: "PaidTimeOff", payrollId: "99" }),
            bonus({ id: "old", amount: 1, date: "2022-08-01T00:00:00Z", payrollId: "88" }),
            bonus({ id: "other", amount: 2, jobId: "999", payrollId: "77" }),
            bonus({ id: "time", amount: 3, type: "TimesheetTime", paidTimeType: "Regular", payrollId: "55" }),
          ],
        }),
        readPayrollPeriods: async (ids) => {
          payrollIds.push([...ids]);
          throw new Error("period down");
        },
        readJobActivity: async (jobIds) => {
          historyJobs.push([...jobIds]);
          throw new Error("history down");
        },
        readTechnicians: async () => [{ id: "tech-SECRET-77", burdenRate: 13.37 }],
      },
      "290588725",
      new Date("2026-10-27T12:00:00Z"),
    );
    expect(payrollIds).toEqual([["11"]]);
    expect(historyJobs).toEqual([["100"]]);
    expect(body.posted_commission.amount).toBe(10);
    expect(body.labor_source).toBe("posted_commission");
    expect(body.live_burden.amount).toBeNull();
    expect(body.commission_breakdown.payroll_status_available).toBe(false);
    expect(body.commission_breakdown.total).toBe(10);
    expect(body.activity_burden).toMatchObject({ available: false, hours: null, amount: null, included_in_burden: false });
    expect(body.activity_burden.note).toBe("history down");
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("SECRET");
    expect(raw).not.toContain("13.37");
  });
});
