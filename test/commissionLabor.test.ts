import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ServiceTitanReadAdapter } from "../src/adapters/serviceTitan.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import {
  commissionFraction,
  priceTechnicianHours,
  rescaleCommissionLabor,
  resolvePayForTechnicians,
  resolveTechCommission,
  type TechPaySource,
} from "../src/domain/commissionLabor.js";
import {
  allowlistedGet,
  formatCommissionProbe,
  summarizeGrossPayCommission,
} from "../src/domain/commissionProbe.js";
import {
  listActiveRateGaps,
  resolveTechnicianNames,
  storeJobLabor,
  storeTechnicianRates,
  technicianLabel,
} from "../src/domain/laborActuals.js";
import {
  createTenant,
  estimatePayload,
  projectBody,
  SCHEMA_FILES,
  startHarness,
  type Harness,
} from "./support/harness.js";

const tech = (overrides: Partial<TechPaySource> & Pick<TechPaySource, "id" | "name">): TechPaySource => ({
  active: true,
  hourlyRate: null,
  burdenRate: null,
  commissionRate: null,
  ...overrides,
});

describe("commission labor formula", () => {
  it("prices a commission technician as hours times the billable rate times the percent", () => {
    const priced = priceTechnicianHours(
      tech({
        id: "casey",
        name: "Casey Nguyen",
        hourlyRate: 0,
        burdenRate: 12,
        commissionRate: 0.25,
      }),
      4,
      188,
    );
    expect(priced.payBasis).toBe("commission");
    expect(priced.laborAmount).toBe(188);
    expect(priced.burdenAmount).toBe(48);
    expect(priced.errors).toEqual([]);
    expect(priced.notices).toEqual([]);
  });

  it("prices an hourly technician from the hourly rate and keeps burden on its own line", () => {
    const priced = priceTechnicianHours(
      tech({
        id: "justin",
        name: "Justin M.",
        hourlyRate: 36,
        burdenRate: 0,
        commissionRate: 0,
      }),
      2,
      188,
    );
    expect(priced.payBasis).toBe("hourly");
    expect(priced.laborAmount).toBe(72);
    expect(priced.laborAmount).not.toBe(2 * 188);
    expect(priced.burdenAmount).toBeNull();
    expect(priced.burdenUnset).toBe(true);
    expect(priced.errors).toEqual([]);
    expect(priced.notices).toEqual(["burden not set for Justin M."]);
  });

  it("does not treat a zero hourly rate as missing when commission is set", () => {
    const priced = priceTechnicianHours(
      tech({ id: "jarrod", name: "Jarrod S", hourlyRate: 0, burdenRate: 0, commissionRate: 0.28 }),
      1,
      188,
    );
    expect(priced.payBasis).toBe("commission");
    expect(priced.laborAmount).toBe(52.64);
    expect(priced.errors).toEqual([]);
  });

  it("flags a technician only when neither commission nor an hourly rate is readable", () => {
    const priced = priceTechnicianHours(
      tech({ id: "riley", name: "Riley Cho", hourlyRate: 0, burdenRate: 0, commissionRate: 0 }),
      3,
      188,
    );
    expect(priced.payBasis).toBe("missing");
    expect(priced.laborAmount).toBeNull();
    expect(priced.errors).toEqual(["No ServiceTitan commission percent or hourly rate for Riley Cho"]);
  });

  it("excludes placeholder technician records from cost, flags, and notices", () => {
    for (const name of [
      "Office Notes",
      " Project Requirements ",
      "subcontractor",
      "Subcontractor - East",
      "Office Notes (old)",
      "Placeholder",
    ]) {
      const priced = priceTechnicianHours(
        tech({ id: name, name, hourlyRate: 40, burdenRate: 0, commissionRate: 0.25 }),
        5,
        188,
      );
      expect(priced.excluded, name).toBe(true);
      expect(priced.laborAmount).toBeNull();
      expect(priced.errors).toEqual([]);
      expect(priced.notices).toEqual([]);
    }
    const real = priceTechnicianHours(
      tech({ id: "jordan", name: "Jordan Hale", hourlyRate: 40, burdenRate: 8, commissionRate: 0 }),
      1,
      188,
    );
    expect(real.excluded).toBe(false);
    expect(real.payBasis).toBe("hourly");
    expect(real.laborAmount).toBe(40);
  });

  it("rescales commission labor when the company billable rate changes", () => {
    expect(rescaleCommissionLabor(188, 188, 200)).toBe(200);
    expect(rescaleCommissionLabor(52.64, 188, 200)).toBe(56);
  });

  it("reads payroll commission first, then a positive technician commissionRate", async () => {
    expect(
      resolveTechCommission({
        payrollSettings: { commissionRate: 0.22, hourlyRate: 40 },
        technicianCommissionRate: 0,
      }),
    ).toMatchObject({ fraction: 0.22, source: "payroll-settings", path: "commissionRate" });

    expect(
      resolveTechCommission({
        payrollSettings: { hourlyRate: 40, burdenRate: 12 },
        technicianCommissionRate: 0.28,
      }),
    ).toMatchObject({ fraction: 0.28, source: "technician.commissionRate" });

    expect(
      resolveTechCommission({
        payrollSettings: { commissionRate: 0, soldByRate: 0.4 },
        technicianCommissionRate: 0.25,
      }),
    ).toMatchObject({ fraction: 0.25, source: "technician.commissionRate" });

    expect(
      resolveTechCommission({
        payrollSettings: { commissionPercent: 25 },
        technicianCommissionRate: 0,
      }).fraction,
    ).toBe(0.25);
    expect(commissionFraction(28)).toBe(0.28);
    expect(commissionFraction(0.28)).toBe(0.28);

    expect(
      resolveTechCommission({
        payrollSettings: { commissionRate: 0, percentageOfInvoice: 22 },
        technicianCommissionRate: 0,
      }).fraction,
    ).toBe(0.22);

    expect(
      resolveTechCommission({
        payrollSettings: {
          percentageOfInvoice: 10,
          commissionRate: 0.22,
        },
        technicianCommissionRate: 0.5,
      }),
    ).toMatchObject({ fraction: 0.22, path: "commissionRate" });

    expect(
      resolveTechCommission({
        payrollSettings: { customFields: [{ name: "Commission percent", value: "25" }] },
        technicianCommissionRate: 0,
      }),
    ).toMatchObject({ fraction: 0.25, source: "payroll-settings" });

    expect(
      resolveTechCommission({
        payrollSettings: null,
        technicianCommissionRate: 0,
      }),
    ).toEqual({ fraction: null, source: null, path: null });

    const [fromExport] = await resolvePayForTechnicians(
      [tech({ id: "322339504", name: "Chris Voight", hourlyRate: 0, commissionRate: 0 })],
      {
        readTechnicianPayrollSettings: async () => {
          throw new Error("HTTP 403");
        },
        readPayrollSettingsPage: async () => ({ ok: false, status: 403, body: null }),
        readPayrollSettingsExport: async () => ({
          ok: true,
          status: 200,
          body: {
            data: [{ employeeId: "322339504", commissionPercentage: 28 }],
            hasMore: false,
          },
        }),
      },
    );
    expect(fromExport?.payBasis).toBe("commission");
    expect(fromExport?.commissionFraction).toBe(0.28);
    expect(fromExport?.commissionSource).toBe("payroll-settings");
  });

  it("matches numeric technician id 11000041 to Wesley M and leaves a missing id unlabeled", async () => {
    const reads: string[] = [];
    const names = await resolveTechnicianNames(
      ["11000041", "22000042", "33000043"],
      [{ id: 11000041 as unknown as string, name: "Wesley M" }],
      async (id) => {
        reads.push(id);
        return id === "22000042" ? "Pat Lee" : null;
      },
    );
    expect(names.get("11000041")).toBe("Wesley M");
    expect(reads).not.toContain("11000041");
    expect(names.get("22000042")).toBe("Pat Lee");
    expect(names.has("33000043")).toBe(false);
    expect(technicianLabel("Wesley M", "11000041")).toBe("Wesley M");
    expect(technicianLabel(null, "33000043")).toBe("Former tech #33000043");
  });
});

describe("commission probe reads", () => {
  const config = {
    environment: "integration" as const,
    tenantId: "10",
    clientId: "client",
    clientSecret: "secret",
    appKey: "app",
  };

  it("allows the payroll and settings GETs and rejects anything else before fetch", async () => {
    expect(allowlistedGet("payroll", "technicians/322339504/payroll-settings")).toBe(true);
    expect(allowlistedGet("payroll", "payroll-settings")).toBe(true);
    expect(allowlistedGet("payroll", "export/payroll-settings")).toBe(true);
    expect(allowlistedGet("payroll", "gross-pay-items")).toBe(true);
    expect(allowlistedGet("payroll", "jobs/splits")).toBe(true);
    expect(allowlistedGet("payroll", "jobs/55/splits")).toBe(true);
    expect(allowlistedGet("settings", "technicians/227070567")).toBe(true);
    expect(allowlistedGet("payroll", "timesheets")).toBe(false);
    expect(allowlistedGet("settings", "employees")).toBe(false);

    const fetcher = vi.fn<typeof fetch>();
    const client = new ServiceTitanReadAdapter(config, fetcher);
    await expect(client.readAllowlistedGet("payroll", "timesheets")).rejects.toThrow(/not allowed/);
    await expect(client.readAllowlistedGet("payroll", "technicians/1/../payroll-settings")).rejects.toThrow(
      /not allowed/,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("GETs one payroll-settings document and labels a gross-pay percent as derived", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/connect/token")) {
        return Response.json({ access_token: "test-token", expires_in: 900 });
      }
      expect(init?.method ?? "GET").toBe("GET");
      return Response.json({ commissionRate: 0.28, hourlyRate: 0 });
    });
    const client = new ServiceTitanReadAdapter(config, fetcher);
    const read = await client.readAllowlistedGet("payroll", "technicians/227070567/payroll-settings");
    expect(read).toMatchObject({ ok: true, status: 200 });
    const dataCalls = fetcher.mock.calls.filter((call) => !String(call[0]).includes("/connect/token"));
    expect(dataCalls).toHaveLength(1);
    expect(String(dataCalls[0]?.[0])).toContain(
      "/payroll/v2/tenant/10/technicians/227070567/payroll-settings",
    );
    expect(dataCalls[0]?.[1]).toMatchObject({ method: "GET" });

    const derived = summarizeGrossPayCommission("322339504", {
      data: [
        { activity: "Commission", amount: 70, invoiceTotal: 250, jobId: 55 },
        { activity: "Hourly", amount: 40, invoiceTotal: 250 },
      ],
    });
    expect(derived.label).toBe("derived");
    expect(derived.disclaimer).toMatch(/not a ServiceTitan commission setting/);
    expect(derived.commissionPay).toBe(70);
    expect(derived.invoiceTotal).toBe(500);
    expect(derived.effectivePercent).toBe(14);
    expect(formatCommissionProbe({
      readOnly: true,
      technicianIds: ["322339504"],
      endpoints: [],
      derived: [derived],
    })).toMatch(/Derived commission \(not a ServiceTitan setting\)/);
  });
});

describe("stored commission labor", () => {
  let h: Harness;
  const reads: string[] = [];
  const sources: SourceConnections = {
    serviceTitan: {
      tenantId: "00000000-0000-4000-8000-0000000000c1",
      externalSystemId: "00000000-0000-4000-8000-0000000000c2",
      key: "st:commission",
      client: {
        sourceTenantId: "99887766",
        readJob: async () => {
          throw new Error("unused");
        },
        readAllowlistedGet: async (family, resource, query) => {
          reads.push(`${family}/${resource}`);
          const id = resource.match(/\d+/)?.[0];
          if (family === "payroll" && resource.endsWith("/payroll-settings") && id) {
            if (id === "322339504") {
              return { ok: true, status: 200, body: { employeeId: 322339504, commissionRate: 0.27 } };
            }
            return { ok: true, status: 200, body: { employeeId: Number(id), hourlyRate: 0 } };
          }
          if (family === "settings" && id === "227070567") {
            return { ok: true, status: 200, body: { id: 227070567, commissionRate: 0.28 } };
          }
          if (resource === "gross-pay-items" && query?.employeeId === "322339504") {
            return {
              ok: true,
              status: 200,
              body: {
                data: [{ activity: "Commission", amount: 70, invoiceTotal: 250, jobId: 55 }],
                hasMore: false,
              },
            };
          }
          if (resource === "jobs/splits" || resource.endsWith("/splits")) {
            return { ok: true, status: 200, body: { data: [{ splitRate: 0.5 }], hasMore: false } };
          }
          return { ok: true, status: 200, body: { data: [], hasMore: false } };
        },
      },
    },
  };

  beforeAll(async () => {
    h = await startHarness(SCHEMA_FILES, sources);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("prices hours, separates burden, hides placeholders, and rescales only commission labor", async () => {
    const tenant = await createTenant(h, { slug: `commission-${Math.random().toString(36).slice(2, 8)}` });
    const owner = h.as(tenant.staff.owner!.token);
    const imported = await owner.post("/api/v1/projects/estimate-imports").send(estimatePayload());
    const created = await owner.post("/api/v1/projects/projects").send(
      projectBody({
        estimate_import_id: imported.body.data.id,
        source_kind: "journeyman_estimate",
        contract_value: 41800,
      }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const projectId = created.body.data.id as string;
    const codes = await owner.get("/api/v1/projects/cost-codes");
    const codeId = (codes.body.data as Array<{ id: string; code: string }>).find((row) => row.code === "210")!.id;
    const budget = await owner.get(`/api/v1/projects/projects/${projectId}/budget`);
    const hasLabor = (budget.body.data.lines as Array<{ cost_code_id: string; cost_type: string }>).some(
      (line) => line.cost_code_id === codeId && line.cost_type === "L",
    );
    expect(hasLabor).toBe(false);

    await h.db.withTenant(tenant.id, async (db) => {
      await storeJobLabor(db, {
        tenantId: tenant.id,
        projectId,
        jobId: "900",
        jobLinkId: null,
        observedAt: new Date("2026-10-25T12:00:00Z"),
        result: {
          jobId: "900",
          outcome: "timesheet",
          drafts: [
            {
              externalTimesheetId: "ts-casey",
              externalAppointmentId: null,
              externalTechnicianId: "tech-casey",
              technicianName: "Casey Nguyen",
              workDate: "2026-10-23",
              hours: 4,
              source: "timesheet",
            },
            {
              externalTimesheetId: "ts-justin",
              externalAppointmentId: null,
              externalTechnicianId: "tech-justin",
              technicianName: "Justin M.",
              workDate: "2026-10-23",
              hours: 2,
              source: "timesheet",
            },
            {
              externalTimesheetId: "ts-office",
              externalAppointmentId: null,
              externalTechnicianId: "tech-office",
              technicianName: "Office Notes",
              workDate: "2026-10-23",
              hours: 3,
              source: "timesheet",
            },
          ],
        },
      });
      await db.query(
        `UPDATE projects.labor_actuals SET cost_code_id = $2 WHERE project_id = $1`,
        [projectId, codeId],
      );
      await storeTechnicianRates(
        db,
        tenant.id,
        [
          tech({ id: "tech-casey", name: "Casey Nguyen", hourlyRate: 0, burdenRate: 12, commissionRate: 0.25 }),
          tech({ id: "tech-justin", name: "Justin M.", hourlyRate: 36, burdenRate: 0, commissionRate: 0 }),
          tech({ id: "tech-riley", name: "Riley Cho", hourlyRate: 0, burdenRate: 0, commissionRate: 0 }),
          tech({ id: "tech-office", name: "Office Notes", hourlyRate: 40, burdenRate: 9, commissionRate: 0.3 }),
          tech({ id: "tech-req", name: "Project Requirements", hourlyRate: 40, burdenRate: 9, commissionRate: 0.3 }),
          tech({ id: "tech-sub", name: "Subcontractor", hourlyRate: 40, burdenRate: 9, commissionRate: 0.3 }),
        ],
        new Date("2026-10-25T12:00:00Z"),
      );
      await db.query(
        `INSERT INTO projects.technician_labor_rates
           (tenant_id, external_technician_id, technician_name, active, pay_basis, burden_unset)
         VALUES
           ($1, 'tech-office', 'Office Notes', true, 'missing', true),
           ($1, 'tech-req', 'Project Requirements', true, 'missing', true),
           ($1, 'tech-sub', 'Subcontractor', true, 'missing', true)
         ON CONFLICT (tenant_id, external_technician_id) DO UPDATE
           SET active = true, pay_basis = 'missing', burden_unset = true, hourly_rate = NULL, burden_rate = NULL`,
        [tenant.id],
      );
    });

    const gaps = await h.db.withTenant(tenant.id, (db) => listActiveRateGaps(db, tenant.id));
    expect(gaps.map((gap) => gap.technician_name)).toEqual(["Riley Cho"]);

    const labor = await owner.get(`/api/v1/projects/projects/${projectId}/labor`);
    expect(labor.status, JSON.stringify(labor.body)).toBe(200);
    const casey = labor.body.data.technicians.find(
      (row: { technician_name: string }) => row.technician_name === "Casey Nguyen",
    );
    expect(casey).toMatchObject({ pay_basis: "commission", wage: 188, burden: 48 });
    expect(casey).not.toHaveProperty("missing");
    const justin = labor.body.data.technicians.find(
      (row: { technician_name: string }) => row.technician_name === "Justin M.",
    );
    expect(justin).toMatchObject({
      pay_basis: "hourly",
      wage: 72,
      burden: null,
      burden_unset: true,
      notices: ["burden not set for Justin M."],
    });
    expect(
      labor.body.data.technicians.some((row: { technician_name: string }) =>
        ["Office Notes", "Project Requirements", "Subcontractor"].includes(row.technician_name),
      ),
    ).toBe(false);
    expect(labor.body.data).not.toHaveProperty("rate_gaps");
    expect(labor.body.data).not.toHaveProperty("burden_notices");
    const settings = await owner.get("/api/v1/projects/settings/labor");
    expect(settings.body.data.rate_gaps.map((gap: { technician_name: string }) => gap.technician_name)).toEqual([
      "Riley Cho",
    ]);
    expect(settings.body.data.burden_notices.map((gap: { technician_name: string }) => gap.technician_name)).toEqual([
      "Justin M.",
      "Riley Cho",
    ]);

    const position = await owner.get(`/api/v1/projects/projects/${projectId}/cost-position`);
    const unbudgeted = (position.body.data as Array<{ description: string; actual_cost: number; lines?: unknown }>).find(
      (row) => row.description === "Unbudgeted labor",
    );
    expect(unbudgeted).toMatchObject({
      description: "Unbudgeted labor",
      cost_type: "L",
      budget_amount: 0,
      actual_cost: 308,
      lines: [
        { description: "Labor", amount: 260 },
        { description: "Labor burden", amount: 48 },
      ],
    });

    const saved = await owner.put("/api/v1/projects/settings/labor/billable-rate").send({
      labor_billable_rate: 200,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.labor_billable_rate).toBe(200);

    const scaled = await owner.get(`/api/v1/projects/projects/${projectId}/labor`);
    expect(
      scaled.body.data.technicians.find((row: { technician_name: string }) => row.technician_name === "Casey Nguyen")
        .wage,
    ).toBe(200);
    expect(
      scaled.body.data.technicians.find((row: { technician_name: string }) => row.technician_name === "Justin M.").wage,
    ).toBe(72);
    const scaledPosition = await owner.get(`/api/v1/projects/projects/${projectId}/cost-position`);
    expect(
      (scaledPosition.body.data as Array<{ description: string; actual_cost: number; lines?: Array<{ description: string; amount: number }> }>)
        .find((row) => row.description === "Unbudgeted labor"),
    ).toMatchObject({
      actual_cost: 320,
      lines: [
        { description: "Labor", amount: 272 },
        { description: "Labor burden", amount: 48 },
      ],
    });

    const stored = await h.db.withTenant(tenant.id, (db) =>
      db.query<{
        hourly_rate: string | null;
        burden_rate: string | null;
        pay_basis: string | null;
      }>(
        `SELECT hourly_rate::text, burden_rate::text, pay_basis
           FROM projects.technician_labor_rates
          WHERE external_technician_id IN ('tech-casey', 'tech-justin')
          ORDER BY external_technician_id`,
      ),
    );
    expect(stored.rows).toEqual([
      { hourly_rate: null, burden_rate: null, pay_basis: "commission" },
      { hourly_rate: null, burden_rate: null, pay_basis: "hourly" },
    ]);
    const columns = await h.db.withTenant(tenant.id, (db) =>
      db.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'projects'
            AND table_name IN ('technician_labor_rates', 'labor_actuals', 'tenant_settings')
            AND column_name ILIKE '%commission%'`,
      ),
    );
    expect(columns.rows).toEqual([]);
  });

  it("runs the owner probe as GETs and rejects a non-numeric id before any read", async () => {
    const tenant = await createTenant(h, { slug: `probe-${Math.random().toString(36).slice(2, 8)}` });
    sources.serviceTitan!.tenantId = tenant.id;
    const owner = h.as(tenant.staff.owner!.token);
    const bad = await owner.get("/api/v1/projects/settings/labor/commission-probe").query({ technician_id: "chris" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("validation_failed");

    const denied = await h
      .as(tenant.staff.pm!.token)
      .get("/api/v1/projects/settings/labor/commission-probe");
    expect(denied.status).toBe(403);

    reads.length = 0;
    const report = await owner.get("/api/v1/projects/settings/labor/commission-probe");
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.data.readOnly).toBe(true);
    expect(report.body.data.technicianIds).toEqual(["322339504", "227070567"]);
    const payroll = (report.body.data.endpoints as Array<{ path: string; method: string; ratePaths: Array<{ path: string; value: number }> }>).find(
      (row) => row.path.endsWith("/technicians/322339504/payroll-settings"),
    );
    expect(payroll?.method).toBe("GET");
    expect(payroll?.ratePaths).toEqual(
      expect.arrayContaining([{ path: "commissionRate", value: 0.27 }]),
    );
    const legacy = (report.body.data.endpoints as Array<{ path: string; ratePaths: Array<{ path: string; value: number }> }>).find(
      (row) => row.path.endsWith("/settings/v2/tenant/99887766/technicians/227070567"),
    );
    expect(legacy?.ratePaths).toEqual(
      expect.arrayContaining([{ path: "commissionRate", value: 0.28 }]),
    );
    const derived = report.body.data.derived.find(
      (row: { technicianId: string }) => row.technicianId === "322339504",
    );
    expect(derived.label).toBe("derived");
    expect(derived.disclaimer).toMatch(/not a ServiceTitan commission setting/);
    expect(derived.commissionPay).toBe(70);
    expect(derived.invoiceTotal).toBe(250);
    expect(derived.effectivePercent).toBe(28);
    expect(reads.every((path) => path.startsWith("payroll/") || path.startsWith("settings/"))).toBe(true);
    expect(reads.some((path) => path.includes("payroll-settings"))).toBe(true);
    expect(reads.some((path) => path === "payroll/gross-pay-items")).toBe(true);
    expect(reads.some((path) => path === "payroll/jobs/splits")).toBe(true);
  });

  it("shows Wesley M for 11000041 when the timesheet name is blank", async () => {
    const tenant = await createTenant(h, { slug: `wesley-${Math.random().toString(36).slice(2, 8)}` });
    sources.serviceTitan!.tenantId = tenant.id;
    const staffReads: string[] = [];
    const client = sources.serviceTitan!.client;
    client.readJobTimesheets = async () => ({
      jobId: "321612166",
      forbidden: false,
      timesheets: [
        {
          id: "ts-wesley",
          appointmentId: null,
          technicianId: "11000041",
          technicianName: null,
          arrivedOn: "2026-10-25T13:00:00Z",
          dispatchedOn: null,
          doneOn: "2026-10-25T15:04:12Z",
          canceledOn: null,
        },
        {
          id: "ts-gone",
          appointmentId: null,
          technicianId: "33000043",
          technicianName: null,
          arrivedOn: "2026-10-25T13:00:00Z",
          dispatchedOn: null,
          doneOn: "2026-10-25T14:00:00Z",
          canceledOn: null,
        },
      ],
    });
    // The settings list returns the id as a JSON number. A string-only map misses him.
    client.readTechnicians = async () => [
      {
        id: 11000041 as unknown as string,
        name: "Wesley M",
        active: true,
        hourlyRate: 0,
        burdenRate: 0,
        commissionRate: 0.28,
      },
    ];
    client.readStaffName = async (id) => {
      staffReads.push(id);
      return null;
    };
    const owner = h.as(tenant.staff.owner!.token);
    const imported = await owner.post("/api/v1/projects/estimate-imports").send(estimatePayload());
    const created = await owner.post("/api/v1/projects/projects").send(
      projectBody({
        estimate_import_id: imported.body.data.id,
        source_kind: "journeyman_estimate",
        contract_value: 41800,
        project_number: "BLANTON",
        name: "Blanton",
      }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const projectId = created.body.data.id as string;
    await h.db.withTenant(tenant.id, async (db) => {
      await db.query(
        `INSERT INTO projects.external_systems (id, tenant_id, adapter_key, display_name)
         VALUES ($1, $2, 'servicetitan', 'ServiceTitan')`,
        [sources.serviceTitan!.externalSystemId, tenant.id],
      );
      await db.query(
        `INSERT INTO projects.project_job_links
           (tenant_id, project_id, external_system_id, external_job_id, title)
         VALUES ($1, $2, $3, '321612166', 'Blanton')`,
        [tenant.id, projectId, sources.serviceTitan!.externalSystemId],
      );
      await db.query(
        `INSERT INTO projects.technician_labor_rates
           (tenant_id, external_technician_id, technician_name, active, pay_basis, burden_unset)
         VALUES ($1, '11000041', 'Wesley M', true, NULL, false)`,
        [tenant.id],
      );
      await db.query(
        `INSERT INTO projects.labor_actuals
           (tenant_id, project_id, external_job_id, external_timesheet_id,
            external_technician_id, technician_name, work_date, hours, source)
         VALUES ($1, $2, '321612166', 'ts-stored', '11000041', NULL, CURRENT_DATE, 2.07, 'timesheet')`,
        [tenant.id, projectId],
      );
    });
    const before = await owner.get(`/api/v1/projects/projects/${projectId}/labor`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.data.technicians).toEqual([
      expect.objectContaining({ technician_name: "Wesley M", hours: 2.07, external_technician_id: "11000041" }),
    ]);
    expect(JSON.stringify(before.body.data)).not.toContain("Former tech");

    const refreshed = await owner.post(`/api/v1/projects/projects/${projectId}/labor/refresh`);
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    const names = (refreshed.body.data.technicians as Array<{ technician_name: string; hours: number }>).map(
      (row) => [row.technician_name, row.hours],
    );
    expect(names).toEqual(
      expect.arrayContaining([
        ["Wesley M", 2.07],
        ["Former tech #33000043", 1],
      ]),
    );
    expect(names.some((row) => String(row[0]).includes("Former tech #11000041"))).toBe(false);
    expect(refreshed.body.data).not.toHaveProperty("rate_gaps");
    expect(refreshed.body.data).not.toHaveProperty("burden_notices");
    expect(JSON.stringify(refreshed.body.data)).not.toContain("Missing from ServiceTitan");
    expect(staffReads).toEqual(["33000043"]);

    await h.db.withTenant(tenant.id, async (db) => {
      await db.query(
        `INSERT INTO projects.technician_labor_rates
           (tenant_id, external_technician_id, technician_name, active, pay_basis, burden_unset)
         VALUES ($1, 'tech-riley', 'Riley Cho', true, 'missing', true)`,
        [tenant.id],
      );
    });
    client.readTechnicians = async () => {
      throw new Error("Unexpected technician directory response.");
    };
    client.readStaffName = async (id) => (id === "11000041" ? "Wesley M" : null);
    const kept = await owner.post(`/api/v1/projects/projects/${projectId}/labor/refresh`);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.data.technicians).toEqual(
      expect.arrayContaining([expect.objectContaining({ technician_name: "Wesley M", hours: 2.07 })]),
    );
    expect(JSON.stringify(kept.body.data.technicians)).not.toContain("Former tech #11000041");
    const settings = await owner.get("/api/v1/projects/settings/labor");
    expect(settings.body.data.rate_gaps.map((gap: { technician_name: string }) => gap.technician_name)).toContain(
      "Riley Cho",
    );
  });
});
