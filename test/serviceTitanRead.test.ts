import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { retryAfterMs, ServiceTitanReadAdapter } from "../src/adapters/serviceTitan.js";
const config = {
  environment: "integration" as const,
  tenantId: "10",
  clientId: "client",
  clientSecret: "secret",
  appKey: "app",
};
const job = {
  id: 1,
  jobNumber: "100",
  customerId: 2,
  locationId: 3,
  jobStatus: "Scheduled",
  modifiedOn: "2026-09-15T12:00:00Z",
};
const appointment = {
  id: 4,
  jobId: 1,
  appointmentNumber: "100-1",
  start: "2026-09-15T12:00:00Z",
  end: "2026-09-15T15:00:00Z",
  status: "Scheduled",
  active: true,
  isConfirmed: true,
  modifiedOn: "2026-09-15T12:00:00Z",
};
const assignment = {
  id: 5,
  jobId: 1,
  appointmentId: 4,
  technicianId: 6,
  technicianName: "Alex",
  active: true,
  status: "Scheduled",
  modifiedOn: "2026-09-15T12:00:00Z",
};
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status });
function setup(pages: unknown[]) {
  const f = vi.fn<typeof fetch>();
  f.mockResolvedValueOnce(
    json({ access_token: "test-token", expires_in: 900 }),
  );
  for (const p of pages)
    f.mockResolvedValueOnce(p instanceof Response ? p : json(p));
  return { client: new ServiceTitanReadAdapter(config, f), fetcher: f };
}
describe("read-only ServiceTitan client", () => {
  it("excludes Enterprise Hub role sources across employee and technician pages", async () => {
    const person = (id: number, roles: number[], active = true) => ({
      id,
      name: "Person " + id,
      active,
      email: "person@test.test",
      phoneNumber: "555",
      roleIds: roles,
      permissions: { secret: true },
      hourlyRate: 100,
    });
    const { client } = setup([
      { data: [{ id: 1, roleSource: "ServiceTitan" }], hasMore: true },
      {
        data: [
          { id: 2, roleSource: "EnterpriseHub" },
          { id: 3, roleSource: "Enterprise Hub" },
        ],
        hasMore: false,
      },
      {
        data: [person(11, [1]), person(12, [2]), person(13, [1, 2])],
        hasMore: true,
      },
      { data: [person(14, [3]), person(15, [1], false)], hasMore: false },
      { data: [person(21, [1]), person(22, [3])], hasMore: false },
    ]);
    const rows = await client.readEmployees();
    expect(rows.map((p) => p.id)).toEqual(["11", "21"]);
    expect(rows[0]).not.toHaveProperty("permissions");
    expect(rows[0]).not.toHaveProperty("hourlyRate");
  });
  it("does not offer employee imports when role sources cannot be verified", async () => {
    const { client } = setup([{ data: [{ id: 1 }], hasMore: false }]);
    await expect(client.readEmployees()).rejects.toThrow(/role sources/);
  });
  it("reads a job with several appointments and all technician assignments without sensitive technician fields", async () => {
    const { client, fetcher } = setup([
      job,
      { data: [appointment], hasMore: true },
      { data: [{ ...appointment, id: 7 }], hasMore: false },
      {
        data: [
          { ...assignment, email: "private@example.test", hourlyRate: 100 },
        ],
        hasMore: false,
      },
    ]);
    const result = await client.readJob("1");
    expect(result.appointments).toHaveLength(2);
    expect(result.assignments[0]?.technicianId).toBe("6");
    expect(result.assignments[0]).not.toHaveProperty("hourlyRate");
    expect(result.assignments[0]).not.toHaveProperty("email");
    const calls = fetcher.mock.calls;
    expect(calls.filter((c) => c[1]?.method === "POST")).toHaveLength(1);
    expect(String(calls[0]?.[0])).toBe(
      "https://auth-integration.servicetitan.io/connect/token",
    );
    expect(
      calls
        .slice(1)
        .every((c) => c[1]?.method === "GET" && c[1]?.redirect === "error"),
    ).toBe(true);
    expect(String(calls[3]?.[0])).toContain("page=2");
  });
  it("fails closed if the upstream ignores the job filter", async () => {
    const { client } = setup([
      job,
      { data: [{ ...appointment, jobId: 99 }], hasMore: false },
      { data: [], hasMore: false },
    ]);
    await expect(client.readJob("1")).rejects.toThrow(
      "outside the requested job",
    );
  });
  it("does not expose vendor response bodies on authorization failure", async () => {
    const { client } = setup([json({ secret: "must not escape" }, 403)]);
    await expect(client.readJob("1")).rejects.toThrow("HTTP 403");
  });
  it("rejects duplicate pages and incomplete pagination", async () => {
    const { client } = setup([
      job,
      { data: [appointment, appointment], hasMore: false },
      { data: [], hasMore: false },
    ]);
    await expect(client.readJob("1")).rejects.toThrow("duplicate");
    const missing = setup([job, { data: [appointment] }]);
    await expect(missing.client.readJob("1")).rejects.toThrow("Unexpected");
  });
  it("refuses malformed IDs and invalid tenant configurations before network access", async () => {
    const { client, fetcher } = setup([]);
    await expect(client.readJob("../other")).rejects.toThrow("numeric");
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      () => new ServiceTitanReadAdapter({ ...config, tenantId: "../other" }),
    ).toThrow("settings");
  });
  it("refuses an inverted appointment window", async () => {
    const { client } = setup([
      job,
      {
        data: [{ ...appointment, end: "2026-09-15T11:00:00Z" }],
        hasMore: false,
      },
      { data: [], hasMore: false },
    ]);
    await expect(client.readJob("1")).rejects.toThrow(
      "invalid appointment dates",
    );
  });
});

it("reads technician hourly and burden rates and drops contact fields", async () => {
  const { client, fetcher } = setup([
    {
      data: [
        {
          id: 6,
          name: "Alex",
          active: true,
          hourlyRate: 40,
          burdenRate: 12,
          email: "private",
          phoneNumber: "555-0100",
        },
      ],
      hasMore: false,
    },
  ]);
  const rows = await client.readTechnicians();
  expect(rows).toEqual([
    { id: "6", name: "Alex", active: true, hourlyRate: 40, burdenRate: 12, commissionRate: null, isManagedTech: null },
  ]);
  expect(rows[0]).not.toHaveProperty("email");
  expect(rows[0]).not.toHaveProperty("phoneNumber");
  expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("active=Any");
});
it("reads Wesley M from the page after a full first page with hasMore false", async () => {
  const filler = (id: number) => ({
    id,
    name: `Tech ${id}`,
    active: true,
    hourlyRate: 0,
    burdenRate: 0,
    commissionRate: 0,
  });
  const { client, fetcher } = setup([
    {
      page: 1,
      pageSize: 50,
      hasMore: false,
      data: Array.from({ length: 50 }, (_, index) => filler(index + 1)),
    },
    {
      page: 2,
      pageSize: 50,
      hasMore: false,
      data: [
        {
          id: 11000041,
          name: "Wesley M",
          active: true,
          isManagedTech: true,
          businessUnitId: 910001,
          hourlyRate: 0,
          burdenRate: 0,
          commissionRate: 0.28,
        },
      ],
    },
  ]);
  const rows = await client.readTechnicians();
  const wesley = rows.find((row) => row.id === "11000041");
  expect(wesley).toEqual({
    id: "11000041",
    name: "Wesley M",
    active: true,
    hourlyRate: 0,
    burdenRate: 0,
    commissionRate: 0.28,
    isManagedTech: true,
  });
  const calls = fetcher.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes("/technicians"));
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("/settings/v2/tenant/10/technicians?");
  expect(calls[0]).toContain("active=Any");
  expect(calls[0]).not.toContain("active=True");
  expect(calls[1]).toContain("page=2");
  expect(calls.every((url) => fetcher.mock.calls.find((call) => String(call[0]) === url)?.[1]?.method === "GET")).toBe(
    true,
  );
});
it("looks up a nameless timesheet id on technicians then employees", async () => {
  const seen: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    seen.push(url);
    expect((init?.method ?? "GET") === "GET" || url.includes("/connect/token")).toBe(true);
    if (url.includes("/connect/token")) {
      return Response.json({ access_token: "test-token", expires_in: 900 });
    }
    expect(init?.method).toBe("GET");
    if (url.endsWith("/technicians/11000041")) {
      return Response.json({
        id: 11000041,
        name: "Wesley M",
        active: true,
        isManagedTech: true,
        businessUnitId: 910001,
      });
    }
    if (url.endsWith("/technicians/22000042") || url.endsWith("/technicians/33000043")) {
      return new Response("{}", { status: 404 });
    }
    if (url.endsWith("/employees/22000042")) {
      return Response.json({ id: 22000042, name: "Pat Lee", active: false });
    }
    if (url.endsWith("/employees/33000043")) return new Response("{}", { status: 404 });
    return new Response("no", { status: 404 });
  });
  const client = new ServiceTitanReadAdapter(config, fetcher);
  expect(await client.readStaffName("11000041")).toBe("Wesley M");
  expect(seen.some((url) => url.includes("/employees/11000041"))).toBe(false);
  expect(await client.readStaffName("22000042")).toBe("Pat Lee");
  expect(await client.readStaffName("33000043")).toBeNull();
});
it("keeps a missing technician rate as missing instead of inventing one", async () => {
  const { client } = setup([
    {
      data: [{ id: 6, name: "Alex", active: true, hourlyRate: 0 }],
      hasMore: false,
    },
  ]);
  expect(await client.readTechnicians()).toEqual([
    { id: "6", name: "Alex", active: true, hourlyRate: 0, burdenRate: null, commissionRate: null, isManagedTech: null },
  ]);
});
it("rejects changed appointments without a business write", async () => {
  const { client, fetcher } = setup([
    job,
    { data: [appointment], hasMore: false },
    { data: [assignment], hasMore: false },
  ]);
  await expect(
    client.rescheduleAppointment("1", "4", "stale", {
      start: "2026-09-16T12:00:00Z",
      end: "2026-09-16T15:00:00Z",
      arrivalWindowStart: null,
      arrivalWindowEnd: null,
    }),
  ).rejects.toThrow("changed");
  expect(fetcher.mock.calls.some((c) => c[1]?.method === "PATCH")).toBe(false);
});
it("reschedules only after conflict checks and verifies the persisted appointment", async () => {
  const change = {
    start: "2026-09-16T12:00:00Z",
    end: "2026-09-16T15:00:00Z",
    arrivalWindowStart: null,
    arrivalWindowEnd: null,
  };
  const { client, fetcher } = setup([
    job,
    { data: [appointment], hasMore: false },
    { data: [assignment], hasMore: false },
    { data: [appointment], hasMore: false },
    { ...appointment, ...change },
    job,
    { data: [{ ...appointment, ...change }], hasMore: false },
    { data: [assignment], hasMore: false },
  ]);
  const saved = await client.rescheduleAppointment(
    "1",
    "4",
    appointment.modifiedOn,
    change,
  );
  expect(saved.appointments[0]!.start).toBe(change.start);
  expect(
    fetcher.mock.calls.filter((c) => c[1]?.method === "PATCH"),
  ).toHaveLength(1);
  expect(
    JSON.parse(
      String(
        fetcher.mock.calls.find((c) => c[1]?.method === "PATCH")![1]!.body,
      ),
    ),
  ).toEqual(change);
});
it("publishes technician changes using ST assignment endpoints and verifies the crew", async () => {
  const change = {
    start: "2026-09-16T12:00:00Z",
    end: "2026-09-16T15:00:00Z",
    arrivalWindowStart: null,
    arrivalWindowEnd: null,
    technicianIds: ["7"],
  };
  const { client, fetcher } = setup([
    job,
    { data: [appointment], hasMore: false },
    { data: [assignment], hasMore: false },
    { data: [{ id: 7, name: "Blair", active: true }], hasMore: false },
    { data: [], hasMore: false },
    {},
    {},
    {},
    job,
    { data: [{ ...appointment, ...change }], hasMore: false },
    { data: [{ ...assignment, technicianId: 7 }], hasMore: false },
  ]);
  await client.rescheduleAppointment("1", "4", appointment.modifiedOn, change);
  const assignments = fetcher.mock.calls.filter(
    (c) => String(c[0]).includes("technicians") && c[1]?.method === "POST",
  );
  expect(assignments).toHaveLength(2);
  expect(JSON.parse(String(assignments[0]![1]!.body))).toEqual({
    jobAppointmentId: 4,
    technicianIds: [7],
  });
  expect(JSON.parse(String(assignments[1]![1]!.body))).toEqual({
    jobAppointmentId: 4,
    technicianIds: [6],
  });
});
it("treats failed assignment after rescheduling as uncertain, preventing blind retry", async () => {
  const { client } = setup([
    job,
    { data: [appointment], hasMore: false },
    { data: [assignment], hasMore: false },
    { data: [], hasMore: false },
    {},
    json({}, 403),
  ]);
  await expect(
    client.rescheduleAppointment("1", "4", appointment.modifiedOn, {
      start: "2026-09-16T12:00:00Z",
      end: "2026-09-16T15:00:00Z",
      arrivalWindowStart: null,
      arrivalWindowEnd: null,
      technicianIds: [],
    }),
  ).rejects.toThrow("technician updates were not confirmed");
});
it("reads ST project identities and related jobs, filtering unrelated source fields", async () => {
  const p = {
    id: 20,
    number: "P20",
    name: "Bath",
    customerId: 30,
    locationId: 40,
    jobIds: [50, 51],
    internalCost: 9000,
  };
  const { client } = setup([{ data: [p], hasMore: false }, p]);
  const rows = await client.listProjects(1, "P20");
  expect(rows.data[0]).not.toHaveProperty("internalCost");
  expect(rows.data[0]!.jobIds).toEqual(["50", "51"]);
  expect((await client.readProject("20")).project.id).toBe("20");
});
it("rejects incorrect ST project identity and duplicate membership", async () => {
  const p = {
    id: 20,
    number: "P20",
    customerId: 30,
    locationId: 40,
    jobIds: [50, 50],
  };
  const { client } = setup([p, p]);
  await expect(client.readProject("21")).rejects.toThrow("Unexpected");
  await expect(client.readProject("20")).rejects.toThrow("Duplicate");
});

it("reads project service address, customer and real job details atomically", async () => {
  const p = {
    id: 20,
    number: "P20",
    name: "Renovation",
    customerId: 2,
    locationId: 3,
    jobIds: [1],
    modifiedOn: "2026-09-15",
  };
  const customer = { id: 2, name: "Customer", balance: 999 };
  const location = {
    id: 3,
    customerId: 2,
    name: "Service location",
    address: {
      street: "100 Main",
      city: "Richmond",
      state: "VA",
      zip: "23220",
    },
  };
  const { client, fetcher } = setup([
    p,
    customer,
    location,
    { ...job, projectId: 20 },
    p,
  ]);
  const result = await client.readProjectDetails("20");
  expect(result.jobs[0]?.jobNumber).toBe("100");
  expect(result.customer).not.toHaveProperty("balance");
  expect(result.location.address.street).toBe("100 Main");
  expect(
    fetcher.mock.calls.some((c) =>
      String(c[0]).includes("/crm/v2/tenant/10/locations/3"),
    ),
  ).toBe(true);
  const drift = setup([
    p,
    customer,
    location,
    { ...job, projectId: 20 },
    { ...p, jobIds: [] },
  ]);
  await expect(drift.client.readProjectDetails("20")).rejects.toThrow(
    "changed",
  );
  const wrong = setup([p, customer, { ...location, customerId: 9 }]);
  await expect(wrong.client.readProjectDetails("20")).rejects.toThrow(
    "did not match",
  );
});

describe("job timesheets", () => {
  it("reads timesheets with GET and drops wage fields", async () => {
    const { client, fetcher } = setup([
      {
        data: [
          {
            id: 9,
            jobId: 1,
            appointmentId: 4,
            technicianId: 6,
            technicianName: "Alex",
            arrivedOn: "2026-09-15T12:00:00Z",
            doneOn: "2026-09-15T15:00:00Z",
            canceledOn: null,
            paidDurationHours: 3,
            hourlyRate: 42,
            grossPay: 126,
          },
        ],
        hasMore: false,
      },
    ]);
    const read = await client.readJobTimesheets("1");
    expect(read.forbidden).toBe(false);
    expect(read.timesheets).toEqual([
      {
        id: "9",
        appointmentId: "4",
        technicianId: "6",
        technicianName: "Alex",
        arrivedOn: "2026-09-15T12:00:00Z",
        dispatchedOn: null,
        doneOn: "2026-09-15T15:00:00Z",
        canceledOn: null,
        paidDurationHours: 3,
      },
    ]);
    expect(read.timesheets[0]).not.toHaveProperty("hourlyRate");
    const sheetCalls = fetcher.mock.calls.filter((call) =>
      String(call[0]).includes("/payroll/"),
    );
    expect(sheetCalls.length).toBeGreaterThan(0);
    expect(sheetCalls.every((call) => call[1]?.method === "GET")).toBe(true);
    expect(fetcher.mock.calls.some((call) => call[1]?.method === "PUT" || call[1]?.method === "PATCH")).toBe(
      false,
    );
  });

  it("returns forbidden on payroll 403 instead of throwing", async () => {
    const { client } = setup([json({ secret: "must not escape" }, 403)]);
    const read = await client.readJobTimesheets("1");
    expect(read).toEqual({ jobId: "1", forbidden: true, timesheets: [] });
  });
});

describe("pricebook labor service", () => {
  const service = (id: number, code: string, active: boolean) => ({
    id,
    code,
    displayName: "Project Labor From Estimate",
    active,
    description: "must not be kept",
    hourlyRate: 40,
  });

  it("reads MHM.25PLFE with GET and keeps the documented fields", async () => {
    const { client, fetcher } = setup([
      { data: [service(1, "MHM.25PLFE", true)], hasMore: true },
      { data: [service(2, "mhm.25plfe", false)], hasMore: false },
    ]);
    const read = await client.readLaborService();
    expect(read.services).toEqual([
      { id: "1", code: "MHM.25PLFE", name: "Project Labor From Estimate", active: true },
      { id: "2", code: "mhm.25plfe", name: "Project Labor From Estimate", active: false },
    ]);
    expect(read.services[0]).not.toHaveProperty("hourlyRate");
    expect(read.services[0]).not.toHaveProperty("description");
    const calls = fetcher.mock.calls.filter((call) => String(call[0]).includes("/services"));
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call[1]?.method === "GET")).toBe(true);
    expect(String(calls[0]?.[0])).toContain("/pricebook/v2/tenant/10/services");
    expect(String(calls[0]?.[0])).toContain("code=MHM.25PLFE");
    expect(String(calls[0]?.[0])).toContain("active=Any");
    expect(String(calls[0]?.[0])).toContain("pageSize=50");
    expect(String(calls[1]?.[0])).toContain("page=2");
    expect(
      fetcher.mock.calls.some(
        (call) => call[1]?.method && call[1].method !== "GET" && call[1].method !== "POST",
      ),
    ).toBe(false);
  });

  it("throws on a pricebook 403", async () => {
    const { client } = setup([json({ secret: "must not escape" }, 403)]);
    await expect(client.readLaborService()).rejects.toThrow(/HTTP 403/);
  });
});

describe("accounting and sales reads", () => {
  it("reads invoices, payments, and estimates with GET only", async () => {
    const { client, fetcher } = setup([
      {
        data: [
          {
            id: 44,
            referenceNumber: " ST-4401 ",
            total: "2400.00",
            balance: "2400.00",
            invoiceDate: "2026-10-20",
            job: { id: 900184 },
            customerBalance: 999,
          },
        ],
        hasMore: false,
      },
      {
        data: [
          {
            id: 7,
            date: "2026-10-12",
            memo: "secret",
            appliedTo: [{ appliedTo: 44, appliedAmount: "12540.00" }],
          },
        ],
        hasMore: false,
      },
      {
        data: [
          {
            id: 9,
            name: "Tile upgrade",
            jobId: 900184,
            status: { name: "Sold" },
            soldOn: "2026-10-18",
            subtotal: "2400.00",
            soldBy: "hidden",
          },
        ],
        hasMore: false,
      },
    ]);
    const invoices = await client.readInvoices(null);
    const payments = await client.readPayments("2026-10-01T00:00:00Z");
    const estimates = await client.readEstimates(null);
    expect(invoices.forbidden).toBe(false);
    expect(invoices.invoices[0]).toEqual({
      externalInvoiceId: "44",
      invoiceNumber: "ST-4401",
      externalJobId: "900184",
      total: 2400,
      balance: 2400,
      invoicedOn: "2026-10-20",
      paidOn: null,
    });
    expect(invoices.invoices[0]).not.toHaveProperty("customerBalance");
    expect(payments.payments).toEqual([
      {
        externalPaymentId: "7",
        externalInvoiceId: "44",
        amount: 12540,
        paidOn: "2026-10-12",
      },
    ]);
    expect(estimates.estimates[0]).toMatchObject({
      externalEstimateId: "9",
      name: "Tile upgrade",
      status: "Sold",
      customerAmount: 2400,
    });
    expect(estimates.estimates[0]).not.toHaveProperty("soldBy");
    const reads = fetcher.mock.calls.filter((call) => call[1]?.method === "GET");
    expect(reads.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("/accounting/v2/tenant/10/invoices?"),
      expect.stringContaining("/accounting/v2/tenant/10/payments?"),
      expect.stringContaining("/sales/v2/tenant/10/estimates?"),
    ]);
    expect(String(reads[1]?.[0])).toContain("modifiedOnOrAfter=2026-10-01");
    expect(fetcher.mock.calls.some((call) => call[1]?.method && call[1].method !== "GET" && call[1].method !== "POST")).toBe(
      false,
    );
  });

  it("returns forbidden on an accounting 403 instead of throwing", async () => {
    const { client } = setup([json({ title: "Forbidden" }, 403)]);
    await expect(client.readInvoices(null)).resolves.toEqual({ forbidden: true, invoices: [] });
  });
});

describe("job invoice lines", () => {
  it("reads each job, follows the general ledger account, and loads a list row that omitted items", async () => {
    const { client, fetcher } = setup([
      {
        data: [
          { id: 10, referenceNumber: "145409", job: { id: 500 } },
          {
            id: 11,
            job: { id: 999 },
            items: [
              {
                id: 1,
                type: "Service",
                skuName: "MHM.25PLFE",
                total: "50.00",
                generalLedgerAccount: { name: "Labor Revenue:Labor Revenue" },
              },
            ],
          },
          {
            id: 12,
            job: { id: 500 },
            items: [
              {
                id: 2,
                type: "PriceModifier",
                skuName: "MH.VS.700.002",
                total: "12.50",
                generalLedgerAccount: { name: "Material Revenue:Material Billed" },
              },
            ],
          },
        ],
        hasMore: false,
      },
      {
        id: 10,
        job: { id: 500 },
        items: [
          {
            id: 3,
            type: "Service",
            skuName: "MHM 250.Labor",
            total: "80.00",
            generalLedgerAccount: { name: "Labor Revenue:Labor Revenue" },
          },
        ],
      },
    ]);
    const lines = await client.readJobInvoiceLines("500");
    expect(lines).toEqual([
      expect.objectContaining({ invoiceId: "10", sku: "MHM 250.Labor", kind: "labor", total: 80 }),
      expect.objectContaining({ invoiceId: "12", sku: "MH.VS.700.002", kind: "material", total: 12.5 }),
    ]);
    const urls = fetcher.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("/invoices?") && url.includes("jobId=500") && !url.includes("projectId="))).toBe(true);
    expect(urls.some((url) => url.includes("/invoices/10"))).toBe(true);
    expect(fetcher.mock.calls.every((call) => (call[1]?.method ?? "GET") === "GET" || String(call[0]).includes("/connect/token"))).toBe(true);
  });

  // Raw GET accounting/v2/.../invoices?jobId= answers for one linked project's five
  // Estimate jobs, saved unedited on 2026-10-27. Each is a $0 invoice with
  // items: null. The older st-invoices fixtures were normalized (items: [],
  // wrapper dropped) and only fed classifyInvoiceItem, so the adapter's
  // parse never saw this shape.
  const rawEstimatePages = JSON.parse(
    readFileSync("test/fixtures/st-invoices/estimate-jobs-null-items-raw.json", "utf8"),
  ) as Record<string, { data: Array<{ id: number; items: unknown; total: string; job: { type: string } }> }>;

  it.each(Object.keys(rawEstimatePages))(
    "reads the raw live $0 Estimate invoice page for job %s without failing or fetching invoice detail",
    async (jobId) => {
      const page = rawEstimatePages[jobId]!;
      expect(page.data[0]?.items).toBeNull();
      expect(page.data[0]?.total).toBe("0.00");
      expect(page.data[0]?.job.type).toBe("Estimate");
      const { client, fetcher } = setup([page]);
      await expect(client.readJobInvoiceLines(jobId)).resolves.toEqual([]);
      const urls = fetcher.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => /\/invoices\/\d+/.test(url))).toBe(false);
      expect(
        fetcher.mock.calls.every(
          (call) => (call[1]?.method ?? "GET") === "GET" || String(call[0]).includes("/connect/token"),
        ),
      ).toBe(true);
    },
  );

  it("keeps billed lines from the same page when a $0 invoice with items: null sits beside them", async () => {
    const raw = rawEstimatePages["321578684"]!;
    const { client } = setup([
      {
        ...raw,
        data: [
          ...raw.data,
          {
            id: 21,
            job: { id: 321578684 },
            total: "100.00",
            items: [
              {
                id: 5,
                type: "Service",
                skuName: "MHM.25PLFE",
                total: "100.00",
                generalLedgerAccount: { name: "Labor Revenue:Labor Revenue" },
              },
            ],
          },
        ],
      },
    ]);
    const lines = await client.readJobInvoiceLines("321578684");
    expect(lines).toEqual([
      expect.objectContaining({ invoiceId: "21", sku: "MHM.25PLFE", kind: "labor", total: 100 }),
    ]);
  });

  it("names the rejected field when an invoice page does not parse", async () => {
    const { client } = setup([{ data: [{ id: 30, items: "nope" }], hasMore: false }]);
    await expect(client.readJobInvoiceLines("700")).rejects.toThrow(
      /Unexpected ServiceTitan invoice items \(data\.0\.items: /,
    );
  });
});

describe("payroll gross pay items", () => {
  const doc = JSON.parse(readFileSync("test/fixtures/st-payroll/gross-pay-items-doc.json", "utf8")) as {
    pages: unknown[];
  };

  it("reads every page of the documented response with GETs to payroll/v2 gross-pay-items", async () => {
    const { client, fetcher } = setup(doc.pages);
    const read = await client.readGrossPayItems({ dateOnOrAfter: "2026-09-16T00:00:00.000Z" });
    expect(read.forbidden).toBe(false);
    expect(read.items).toHaveLength(7);
    expect(read.items[0]).toEqual({
      id: "1",
      technicianId: "6",
      date: "2026-10-20T00:00:00Z",
      activity: "Working",
      amount: 97.5,
      type: "TimesheetTime",
      paidDurationHours: 3.25,
      paidTimeType: "Regular",
      jobId: "100",
    });
    expect(read.items[3]).toMatchObject({ type: "InvoiceRelatedBonus", paidDurationHours: null });
    const urls = fetcher.mock.calls.slice(1).map((call) => new URL(String(call[0])));
    expect(urls.map((url) => url.pathname)).toEqual([
      "/payroll/v2/tenant/10/gross-pay-items",
      "/payroll/v2/tenant/10/gross-pay-items",
    ]);
    expect(urls[0]?.searchParams.get("employeeType")).toBe("Technician");
    expect(urls[0]?.searchParams.get("dateOnOrAfter")).toBe("2026-09-16T00:00:00.000Z");
    expect(urls[1]?.searchParams.get("page")).toBe("2");
    expect(fetcher.mock.calls.slice(1).every((call) => call[1]?.method === "GET")).toBe(true);
  });

  it("reports a 403 as forbidden and rethrows any other failure", async () => {
    const denied = setup([new Response("{}", { status: 403 })]);
    await expect(denied.client.readGrossPayItems({ dateOnOrAfter: "2026-09-16T00:00:00Z" })).resolves.toEqual({
      forbidden: true,
      items: [],
    });
    const broken = setup([{ data: [{ id: 1, paidDurationHours: "x" }], hasMore: false }]);
    await expect(broken.client.readGrossPayItems({ dateOnOrAfter: "2026-09-16T00:00:00Z" })).rejects.toThrow(
      /Unexpected gross pay items \(data\.0\.paidDurationHours: /,
    );
  });
});

describe("ServiceTitan 429 backoff", () => {
  const technicianPage = {
    data: [{ id: 6, name: "Alex", active: true, hourlyRate: 40, burdenRate: 12 }],
    hasMore: false,
  };

  it("waits for Retry-After and reuses one token", async () => {
    const slept: number[] = [];
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(json({ access_token: "test-token", expires_in: 900 }));
    fetcher.mockResolvedValueOnce(
      new Response("{}", { status: 429, headers: { "Retry-After": "0" } }),
    );
    fetcher.mockResolvedValueOnce(json(technicianPage));
    fetcher.mockResolvedValueOnce(json(technicianPage));
    const client = new ServiceTitanReadAdapter(config, fetcher, async (ms) => {
      slept.push(ms);
    });
    expect((await client.readTechnicians())[0]?.name).toBe("Alex");
    expect(await client.readTechnicians()).toHaveLength(1);
    expect(slept).toEqual([0]);
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(fetcher.mock.calls.slice(1).every((call) => call[1]?.method === "GET")).toBe(true);
  });

  it("stops after repeated 429s and still posts the token once", async () => {
    const slept: number[] = [];
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(json({ access_token: "test-token", expires_in: 900 }));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      fetcher.mockResolvedValueOnce(
        new Response("{}", { status: 429, headers: { "Retry-After": "0" } }),
      );
    }
    const client = new ServiceTitanReadAdapter(config, fetcher, async (ms) => {
      slept.push(ms);
    });
    await expect(client.readTechnicians()).rejects.toThrow("HTTP 429");
    expect(slept).toEqual([0, 0, 0]);
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "GET")).toHaveLength(4);
  });

  it("reads Retry-After seconds and dates, and caps the wait", () => {
    const now = Date.parse("2026-10-25T15:00:00Z");
    expect(retryAfterMs("0", now)).toBe(0);
    expect(retryAfterMs("2", now)).toBe(2_000);
    expect(retryAfterMs("120", now)).toBe(60_000);
    expect(retryAfterMs(null, now)).toBe(1_000);
    expect(retryAfterMs("not-a-date", now)).toBe(1_000);
    expect(retryAfterMs(new Date(now + 5_000).toUTCString(), now)).toBe(5_000);
    expect(retryAfterMs(new Date(now + 120_000).toUTCString(), now)).toBe(60_000);
    expect(retryAfterMs(new Date(now - 1_000).toUTCString(), now)).toBe(0);
  });
});
