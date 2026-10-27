import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyTechnician } from "../src/domain/commissionLabor.js";
import { burdenSlicesFromGrossPay, grossPayLaborDollars } from "../src/domain/laborActuals.js";
import type { GrossPayItem } from "../src/adapters/serviceTitan.js";
import {
  DALTON_FINANCIALS,
  DALTON_PROJECT_ID,
  FRANCISCO_JOB_ID,
  OTHER_JOB_COUNT,
  OTHER_MISSING_JOB,
  OTHER_PROJECT_ID,
  SEGRETO_FINANCIALS,
  SEGRETO_JOB_COUNT,
  SEGRETO_LINKED_JOB,
  SEGRETO_PROJECT_ID,
  classifyInvoiceItem,
  commissionDollars,
  neverLaborRevenueWarnings,
  financialsFromReads,
  otherProjectJobList,
  payrollHours,
  reconcileFinancials,
  segretoJobList,
  splitBilledLabor,
  unionProjectJobs,
  withBilled,
  withLaborBurden,
} from "../src/domain/projectFinancials.js";
import {
  missedOvernightCatchUp,
  mostRecentOvernight,
  nextOvernight,
  refreshBootAction,
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
    const drifted = { ...money, billedLabor: 15096.41 };
    expect(reconcileFinancials(drifted, money).find((line) => line.key === "billedLabor")).toMatchObject({
      jp: 15096.41,
      st: 15096.4,
      delta: 0.01,
    });
  });

  it("classifies Segreto and Willard invoice items from the general ledger account", () => {
    const segreto = billedFromFixture("segreto-321586598.json");
    expect(segreto.fixture.projectId).toBe(SEGRETO_PROJECT_ID);
    expect(segreto.fixture.invoiceCount).toBe(33);
    const laborLines = segreto.lines.filter((line) => line.kind === "labor" && line.total !== 0);
    expect(laborLines).toHaveLength(10);
    expect(laborLines.every((line) => line.sku === "MHM.25PLFE")).toBe(true);
    expect(laborLines.map((line) => line.invoice).sort()).toEqual([
      "145409",
      "145411",
      "145412",
      "145413",
      "145414",
      "145415",
      "145416",
      "145417",
      "145419",
      "145420",
    ]);
    expect(segreto.lines.filter((line) => line.sku === "MH.VS.700.002").every((line) => line.kind === "material")).toBe(true);
    expect(segreto.lines.filter((line) => line.sku === "MH.PO.700.003").reduce((sum, line) => sum + line.total, 0)).toBe(8382.73);
    expect(segreto.lines.filter((line) => line.sku === "MH.VS.700.002").reduce((sum, line) => roundCheck(sum + line.total), 0)).toBe(880.47);
    const money = financialsFromReads({
      invoiceLines: segreto.lines,
      timesheets: [
        { technicianId: "a", hours: 40, burdenRate: 30 },
        { technicianId: "b", hours: 40.3, burdenRate: 30.78 },
      ],
      purchaseOrders: [{ total: 5239.21 }, { total: 100, canceled: true }],
    });
    expect(money).toEqual(SEGRETO_FINANCIALS);

    const willard = billedFromFixture("willard-321293715.json");
    expect(willard.fixture.projectId).toBe(OTHER_PROJECT_ID);
    expect(willard.fixture.invoiceCount).toBe(13);
    const willardMoney = financialsFromReads({
      invoiceLines: willard.lines,
      timesheets: [],
      purchaseOrders: [],
    });
    expect(willardMoney.billedLabor).toBe(5395.77);
    expect(willardMoney.billedMaterials).toBe(4411.62);
    expect(willardMoney.billed).toBe(19026.14);
    expect(willard.lines.filter((line) => line.sku === "MHM 250.Labor").every((line) => line.kind === "other")).toBe(true);
    expect(willard.lines.filter((line) => line.sku === "MHM.25LFCO").every((line) => line.kind === "other")).toBe(true);
    expect(willard.lines.filter((line) => line.sku === "MH.VS.700.002").every((line) => line.kind === "material")).toBe(true);
  });

  it("uses the account prefix, and type only when the account is missing", () => {
    expect(classifyInvoiceItem({
      type: "PriceModifier",
      accountName: "Material Revenue:Material Billed",
    })).toBe("material");
    expect(classifyInvoiceItem({
      type: "Service",
      accountName: "Labor Revenue:Labor Revenue",
    })).toBe("labor");
    expect(classifyInvoiceItem({
      type: "Material",
      accountName: "Labor Revenue:Labor Revenue",
    })).toBe("labor");
    expect(classifyInvoiceItem({
      type: "Service",
      accountName: "Material Revenue:Material Billed",
    })).toBe("material");
    expect(classifyInvoiceItem({ type: "Service", accountName: "Expense:Labor" })).toBe("other");
    expect(classifyInvoiceItem({ type: "Service", accountName: null })).toBe("labor");
    expect(classifyInvoiceItem({ type: "Material", accountName: null })).toBe("material");
    expect(classifyInvoiceItem({ type: "PriceModifier", accountName: null })).toBe("material");
    expect(classifyInvoiceItem({ type: "Equipment", accountName: null })).toBe("other");
  });

  it("keeps MHM 250.Labor in billed as other when the label says Labor Revenue", () => {
    const kind = classifyInvoiceItem({
      sku: "MHM 250.Labor",
      type: "Service",
      accountName: "Labor Revenue:Labor Revenue",
    });
    expect(kind).toBe("other");
    expect(classifyInvoiceItem({
      sku: "MHM.25LFCO",
      type: "Service",
      accountName: "Labor Revenue:Labor Revenue",
    })).toBe("other");
    const money = financialsFromReads({
      invoiceLines: [
        { kind: "labor", total: 100 },
        { kind, total: 80 },
      ],
      timesheets: [],
      purchaseOrders: [],
    });
    expect(money.billedLabor).toBe(100);
    expect(money.billed).toBe(180);
    expect(neverLaborRevenueWarnings([{ sku: "MHM 250.Labor", invoiceId: "10" }])).toEqual([
      "MHM 250.Labor on invoice 10 is not labor revenue.",
    ]);
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

describe("ServiceTitan labor burden from gross pay items", () => {
  const item = (over: Partial<GrossPayItem>): GrossPayItem => ({
    id: null,
    technicianId: "a",
    date: "2026-10-01T00:00:00Z",
    activity: "Working",
    amount: 1,
    type: "TimesheetTime",
    paidDurationHours: 1,
    paidTimeType: "Regular",
    jobId: "1",
    projectId: SEGRETO_PROJECT_ID,
    ...over,
  });

  it("compares Segreto labor burden to the ServiceTitan Project Financials figure", () => {
    const slices = burdenSlicesFromGrossPay(
      ["1"],
      [
        item({ id: null, technicianId: "a", paidDurationHours: 40, amount: 9999 }),
        item({ id: "string-id", technicianId: "b", paidDurationHours: 40.3, amount: 1 }),
        item({ id: "pto", technicianId: "a", paidTimeType: "PaidTimeOff", paidDurationHours: 8, amount: 100 }),
        item({ id: "bonus", type: "InvoiceRelatedBonus", paidDurationHours: null, amount: 500 }),
        item({ id: "other-job", jobId: "999", technicianId: "a", paidDurationHours: 20 }),
      ],
      new Map([
        ["a", 30],
        ["b", 30.78],
      ]),
    );
    const st = financialsFromReads({
      invoiceLines: [
        { kind: "labor", total: 10000 },
        { kind: "labor", total: 5096.4 },
        { kind: "material", total: 9263.2 },
      ],
      timesheets: slices,
      purchaseOrders: [{ total: 5239.21 }],
    });
    expect(st.laborBurden).toBe(SEGRETO_FINANCIALS.laborBurden);
    expect(st).toEqual(SEGRETO_FINANCIALS);
    expect(reconcileFinancials(st, SEGRETO_FINANCIALS).find((line) => line.key === "laborBurden")).toMatchObject({
      jp: 2440.43,
      st: 2440.43,
      delta: 0,
    });
  });

  it("counts other invoice lines so Dalton billed equals the invoice total", () => {
    expect(DALTON_PROJECT_ID).toBe("290588725");
    const slices = burdenSlicesFromGrossPay(
      ["2901"],
      [
        item({ jobId: "2901", technicianId: "d1", paidDurationHours: 500, amount: 15000, projectId: DALTON_PROJECT_ID }),
        item({ id: "d2", jobId: "2901", technicianId: "d2", paidDurationHours: 200, amount: 6883.04, projectId: DALTON_PROJECT_ID }),
      ],
      new Map([
        ["d1", 30],
        ["d2", 34.4152],
      ]),
    );
    const lines = [
      { kind: "labor" as const, total: 67305 },
      { kind: "material" as const, total: 25101.79 },
      { kind: "other" as const, total: 20000 },
      { kind: "other" as const, total: 2500 },
      { kind: "other" as const, total: 2500 },
    ];
    const jp = financialsFromReads({
      invoiceLines: lines,
      timesheets: slices,
      purchaseOrders: [{ total: DALTON_FINANCIALS.materialsExpense }],
    });
    expect(jp).toEqual(DALTON_FINANCIALS);
    expect(jp.billed).toBe(117406.79);

    const dropped = financialsFromReads({
      invoiceLines: lines.filter((line) => line.kind !== "other"),
      timesheets: slices,
      purchaseOrders: [{ total: DALTON_FINANCIALS.materialsExpense }],
    });
    expect(dropped.billed).toBe(92406.79);
    const stBilled = withBilled(dropped, 117406.79);
    expect(reconcileFinancials(dropped, stBilled).find((line) => line.key === "billed")).toMatchObject({
      jp: 92406.79,
      st: 117406.79,
      delta: -25000,
    });
    expect(reconcileFinancials(jp, withBilled(jp, 117406.79)).find((line) => line.key === "billed")?.delta).toBe(0);

    const wageSum = grossPayLaborDollars(
      ["2901"],
      [
        item({ jobId: "2901", technicianId: "d1", paidDurationHours: 500, amount: 10000, projectId: DALTON_PROJECT_ID }),
        item({ id: "d2", jobId: "2901", technicianId: "d2", paidDurationHours: 200, amount: 5000, projectId: DALTON_PROJECT_ID }),
      ],
    );
    expect(wageSum).toBe(15000);
    const compared = reconcileFinancials(jp, withLaborBurden(jp, wageSum)).find((line) => line.key === "laborBurden");
    expect(compared).toMatchObject({ jp: 21883.04, st: 15000, delta: 6883.04 });
  });

  it("includes a non-labor non-material line in billed and leaves the labor and material buckets alone", () => {
    const money = financialsFromReads({
      invoiceLines: [
        { kind: "labor", total: 10000 },
        { kind: "labor", total: 5096.4 },
        { kind: "material", total: 9263.2 },
        { kind: "other", total: 50 },
      ],
      timesheets: [
        { technicianId: "a", hours: 40, burdenRate: 30 },
        { technicianId: "b", hours: 40.3, burdenRate: 30.78 },
      ],
      purchaseOrders: [{ total: 5239.21 }],
    });
    expect(money.billedLabor).toBe(SEGRETO_FINANCIALS.billedLabor);
    expect(money.billedMaterials).toBe(SEGRETO_FINANCIALS.billedMaterials);
    expect(money.billed).toBe(24409.6);
    expect(money.expenses).toBe(SEGRETO_FINANCIALS.expenses);
    expect(money.margin).toBe(16729.96);
    expect(money.marginPercent).toBe(68.54);
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
    expect(refreshBootAction(new Date("2026-01-15T06:59:00.000Z"), null, null)).toBe("wait");
    expect(refreshBootAction(new Date("2026-10-26T23:05:00.000Z"), null, null)).toBe("wait");
    expect(refreshBootAction(new Date("2026-10-27T09:43:00.000Z"), null, null)).toBe("catch-up");
    expect(refreshBootAction(
      new Date("2026-10-27T18:00:00.000Z"),
      new Date("2026-10-27T06:00:00.000Z"),
      null,
    )).toBe("catch-up");
    expect(refreshBootAction(
      new Date("2026-10-27T18:00:00.000Z"),
      new Date("2026-10-27T06:00:00.000Z"),
      new Date("2026-10-27T06:10:00.000Z"),
    )).toBe("wait");
    expect(refreshBootAction(
      after,
      null,
      new Date("2026-01-14T07:05:00.000Z"),
    )).toBe("catch-up");
  });
});

function billedFromFixture(name: string) {
  const fixture = JSON.parse(readFileSync(`test/fixtures/st-invoices/${name}`, "utf8")) as {
    projectId: string;
    invoiceCount: number;
    invoices: Array<{
      referenceNumber: string;
      items: Array<{
        skuName: string | null;
        type: string | null;
        total: string;
        generalLedgerAccount: { name: string } | null;
      }>;
    }>;
  };
  const lines = fixture.invoices.flatMap((invoice) =>
    invoice.items.map((item) => ({
      invoice: invoice.referenceNumber,
      sku: item.skuName,
      total: Number(item.total),
      kind: classifyInvoiceItem({
        sku: item.skuName,
        type: item.type,
        accountName: item.generalLedgerAccount?.name ?? null,
      }),
    })),
  );
  return { fixture, lines };
}

function roundCheck(value: number): number {
  return Math.round(value * 100) / 100;
}
