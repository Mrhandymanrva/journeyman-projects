import { describe, expect, it } from "vitest";
import { classifyTechnician } from "../src/domain/commissionLabor.js";
import {
  FRANCISCO_JOB_ID,
  OTHER_JOB_COUNT,
  OTHER_MISSING_JOB,
  OTHER_PROJECT_ID,
  SEGRETO_FINANCIALS,
  SEGRETO_JOB_COUNT,
  SEGRETO_LINKED_JOB,
  SEGRETO_PROJECT_ID,
  commissionDollars,
  financialsFromReads,
  otherProjectJobList,
  payrollHours,
  reconcileFinancials,
  segretoJobList,
  splitBilledLabor,
  unionProjectJobs,
} from "../src/domain/projectFinancials.js";
import {
  missedOvernightCatchUp,
  mostRecentOvernight,
  nextOvernight,
  zonedClock,
} from "../src/domain/overnightSchedule.js";

describe("project job lists", () => {
  it("keeps all 33 Segreto jobs, not only 144898, including Francisco's 145416", () => {
    const listed = segretoJobList();
    expect(listed).toHaveLength(SEGRETO_JOB_COUNT);
    expect(listed.some((job) => job.id === FRANCISCO_JOB_ID)).toBe(true);
    const saved = unionProjectJobs([SEGRETO_LINKED_JOB], listed);
    expect(saved).toHaveLength(33);
    expect(saved.map((job) => job.id)).toContain(SEGRETO_LINKED_JOB);
    expect(saved.map((job) => job.id)).toContain(FRANCISCO_JOB_ID);
    expect(saved.filter((job) => job.jobStatus === "Scheduled").length).toBeGreaterThan(0);
    expect(saved.filter((job) => /cancel/i.test(job.jobStatus))).toHaveLength(0);
    expect(SEGRETO_PROJECT_ID).toBe("321586598");
  });

  it("keeps 12 jobs on 321293715, including 145583 which jobIds omitted", () => {
    const known = ["145100", "145101"];
    const listed = otherProjectJobList(known);
    expect(listed).toHaveLength(OTHER_JOB_COUNT);
    expect(OTHER_PROJECT_ID).toBe("321293715");
    const saved = unionProjectJobs(known, listed);
    expect(saved).toHaveLength(12);
    expect(saved.map((job) => job.id)).toContain(OTHER_MISSING_JOB);
    expect(saved.map((job) => job.id)).toEqual(expect.arrayContaining(known));
  });
});

describe("Segreto project financials", () => {
  it("matches ServiceTitan to the cent from payroll hours, invoice items, and purchase orders", () => {
    const lines = [
      { kind: "labor" as const, total: 10000 },
      { kind: "labor" as const, total: 5096.4, technicianId: "francisco" },
      { kind: "material" as const, total: 9263.2 },
      { kind: "other" as const, total: 50 },
    ];
    const money = financialsFromReads({
      invoiceLines: lines,
      timesheets: [
        { technicianId: "a", hours: 40, burdenRate: 30 },
        { technicianId: "b", hours: 40.3, burdenRate: 30.78 },
      ],
      purchaseOrders: [
        { total: 5239.21 },
        { total: 100, canceled: true },
      ],
    });
    expect(money).toEqual(SEGRETO_FINANCIALS);
    const shares = splitBilledLabor(lines, new Map([["francisco", 40.3], ["a", 40]]));
    expect(shares.get("francisco")).toBe(roundCheck(5096.4 + 10000 * (40.3 / 80.3)));
    expect(commissionDollars(shares.get("francisco") ?? 0, 0.1)).toBe(
      Math.round((shares.get("francisco") ?? 0) * 0.1 * 100) / 100,
    );
    const recon = reconcileFinancials(money, SEGRETO_FINANCIALS);
    expect(recon.every((line) => line.delta === 0)).toBe(true);
    expect(recon.find((line) => line.key === "laborBurden")).toMatchObject({
      jp: 2440.43,
      st: 2440.43,
      delta: 0,
    });
  });

  it("ignores dispatch and arrive clocks and keeps a payroll duration", () => {
    expect(
      payrollHours({
        arrivedOn: "2026-10-01T13:00:00Z",
        doneOn: "2026-10-01T21:00:00Z",
        paidDurationHours: 1.25,
      } as { paidDurationHours: number }),
    ).toBe(1.25);
    expect(
      payrollHours({
        canceledOn: null,
        paidDurationHours: null,
        paidHours: null,
        hours: null,
      }),
    ).toBeNull();
    expect(payrollHours({ canceledOn: "2026-10-01T18:00:00Z", paidDurationHours: 4 })).toBeNull();
  });
});

describe("field technician gaps", () => {
  const field = (
    name: string,
    extra: {
      payroll?: unknown;
      hourlyRate?: number;
      burdenRate?: number;
      commissionRate?: number;
      isManagedTech?: boolean;
    } = {},
  ) =>
    classifyTechnician(
      {
        id: name,
        name,
        active: true,
        hourlyRate: extra.hourlyRate ?? 0,
        burdenRate: extra.burdenRate ?? 12,
        commissionRate: extra.commissionRate ?? 0,
        isManagedTech: extra.isManagedTech ?? true,
      },
      extra.payroll ?? null,
    );

  it("flags only an active field technician with neither payroll commission nor an hourly rate", () => {
    const francisco = field("Francisco", { payroll: { commissionRate: 0.1 }, commissionRate: 0 });
    const jason = field("Jason G.", { payroll: { commissionPercent: 12 }, commissionRate: 0 });
    const aaron = field("Aaron P.", { payroll: { commission: { rate: 8 } }, commissionRate: 0 });
    const hourly = field("Justin M.", { hourlyRate: 36, burdenRate: 0, commissionRate: 0 });
    const gap = field("Riley Cho", { burdenRate: 0 });
    const mason = field("Mason", { isManagedTech: false, hourlyRate: 0, burdenRate: 0 });
    const office = classifyTechnician(
      {
        id: "office",
        name: "Office Notes",
        active: true,
        hourlyRate: 0,
        burdenRate: 0,
        commissionRate: 0,
        isManagedTech: false,
      },
      null,
    );
    expect(francisco.payBasis).toBe("commission");
    expect(francisco.commissionFraction).toBe(0.1);
    expect(francisco.commissionSource).toBe("payroll-settings");
    expect(jason.commissionFraction).toBe(0.12);
    expect(aaron.commissionFraction).toBe(0.08);
    expect(hourly.payBasis).toBe("hourly");
    expect(hourly.burdenUnset).toBe(true);
    expect(gap.payBasis).toBe("missing");
    expect(mason.excluded).toBe(true);
    expect(office.excluded).toBe(true);
    const shown = [francisco, jason, aaron, hourly, gap, mason, office].filter(
      (tech) => tech.active && !tech.excluded && tech.isFieldTech && tech.payBasis === "missing",
    );
    expect(shown.map((tech) => tech.name)).toEqual(["Riley Cho"]);
    const burden = [francisco, jason, aaron, hourly, gap].filter(
      (tech) => tech.active && !tech.excluded && tech.isFieldTech && tech.burdenUnset,
    );
    expect(burden.map((tech) => tech.name).sort()).toEqual(["Justin M.", "Riley Cho"]);
  });
});

describe("overnight schedule", () => {
  it("fires at 2:00 AM America/New_York and does not run on a first boot", () => {
    const winter = new Date("2026-01-15T07:00:00.000Z");
    expect(zonedClock(winter)).toMatchObject({ year: 2026, month: 1, day: 15, hour: 2, minute: 0 });
    const summer = new Date("2026-07-15T06:00:00.000Z");
    expect(zonedClock(summer)).toMatchObject({ hour: 2, minute: 0 });
    const before = new Date("2026-01-15T06:59:00.000Z");
    expect(nextOvernight(before).toISOString()).toBe("2026-01-15T07:00:00.000Z");
    const after = new Date("2026-01-15T07:01:00.000Z");
    expect(nextOvernight(after).toISOString()).toBe("2026-01-16T07:00:00.000Z");
    expect(mostRecentOvernight(after).toISOString()).toBe("2026-01-15T07:00:00.000Z");
    expect(missedOvernightCatchUp(after, null)).toBe(false);
    expect(missedOvernightCatchUp(after, new Date("2026-01-14T07:05:00.000Z"))).toBe(true);
    expect(missedOvernightCatchUp(after, new Date("2026-01-15T07:05:00.000Z"))).toBe(false);
  });
});

function roundCheck(value: number): number {
  return Math.round(value * 100) / 100;
}
