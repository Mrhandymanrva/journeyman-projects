import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { laborCardHtml } from "../client/laborCard.js";

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );

const RATE_WARNING =
  /Active technicians missing a ServiceTitan rate|id="labor-rate-gaps"|Missing from ServiceTitan|hourly rate is 0|burden rate is 0|No active technician is missing an hourly rate/;

const segretoLabor = {
  hours: 6.5,
  uncoded_hours: 0,
  source: "auto-hourly",
  hours_source: "timesheet",
  observed_at: "2026-10-26T15:00:00.000Z",
  labor_wage: 0,
  labor_burden: 0,
  total: 0,
  missing: [
    "Missing from ServiceTitan: hourly rate is 0 for Wesley M",
    "Missing from ServiceTitan: burden rate is 0 for Wesley M",
  ],
  rate_gaps: [
    {
      technician_name: "Wesley M",
      messages: ["Missing from ServiceTitan: hourly rate is 0 for Wesley M"],
    },
    {
      technician_name: "Mason",
      messages: ["Missing from ServiceTitan: hourly rate for Mason"],
    },
    {
      technician_name: "Office Notes",
      messages: ["Missing from ServiceTitan: burden rate is 0 for Office Notes"],
    },
    {
      technician_name: "Project Requirements",
      messages: ["Missing from ServiceTitan: hourly rate for Project Requirements"],
    },
    {
      technician_name: "Subcontractor",
      messages: ["Missing from ServiceTitan: hourly rate for Subcontractor"],
    },
  ],
  technicians: [
    {
      external_technician_id: "11000041",
      technician_name: "Wesley M",
      hours: 6.5,
      hourly_rate: 0,
      burden_rate: 0,
      wage: null,
      burden: null,
      missing: [
        "Missing from ServiceTitan: hourly rate is 0 for Wesley M",
        "Missing from ServiceTitan: burden rate is 0 for Wesley M",
      ],
    },
  ],
  st_labor_code: { code: "MHM.25PLFE", name: "Project Labor From Estimate" },
};

describe("project labor card", () => {
  it("shows hours and does not render missing-rate warnings or rate lists", () => {
    const html = laborCardHtml(segretoLabor, {
      esc,
      stamp: () => "Oct 26, 2026, 11:00 AM",
    });
    expect(html).toContain("Wesley M");
    expect(html).toContain("6.5 hours");
    expect(html).toContain("Labor code: MHM.25PLFE Project Labor From Estimate");
    expect(html).toContain("Labor $0.00");
    expect(html).toContain("Labor burden $0.00");
    expect(html).not.toMatch(RATE_WARNING);
    expect(html).not.toContain("Mason");
    expect(html).not.toContain("Office Notes");
    expect(html).not.toContain("Project Requirements");
    expect(html).not.toContain("Subcontractor");
    expect(html).not.toContain("11000041");
  });

  it("still shows a priced technician's wage and burden", () => {
    const html = laborCardHtml(
      {
        hours: 6.5,
        labor_wage: 260,
        labor_burden: 78,
        total: 338,
        technicians: [
          {
            technician_name: "Casey Nguyen",
            hours: 6.5,
            pay_basis: "hourly",
            hourly_rate: 40,
            burden_rate: 12,
            wage: 260,
            burden: 78,
            missing: [],
          },
        ],
        missing: [],
        rate_gaps: [],
        st_labor_code: null,
      },
      { esc, stamp: () => "Not recorded" },
    );
    expect(html).toContain("Casey Nguyen");
    expect(html).toContain("Labor $260.00");
    expect(html).toContain("timesheet hours × hourly rate");
    expect(html).toContain("Labor burden $78.00");
    expect(html).toContain("timesheet hours × burden rate");
    expect(html).toContain("Labor code: unavailable");
    expect(html).not.toMatch(RATE_WARNING);
  });

  it("ignores a project-level missing list when nobody is on the card", () => {
    const html = laborCardHtml(
      {
        hours: 0,
        technicians: [],
        missing: ["Missing from ServiceTitan: hourly rate is 0 for Wesley M"],
        rate_gaps: [],
      },
      { esc, stamp: () => "Not recorded" },
    );
    expect(html).toContain("0 hours");
    expect(html).not.toMatch(RATE_WARNING);
  });
});

describe("project pages", () => {
  it("do not render technician rate lists or missing-rate warnings", () => {
    const files = readdirSync("client").filter(
      (name) => name.endsWith(".js") && name !== "accounting.js",
    );
    expect(files).toContain("laborCard.js");
    expect(files).toContain("console.js");
    expect(files).toContain("precon.js");
    expect(files).toContain("workspace.js");
    for (const file of files) {
      const src = readFileSync(`client/${file}`, "utf8");
      expect(src, file).not.toMatch(RATE_WARNING);
    }
  });
});

describe("Setup labor list", () => {
  it("describes commission labor and flags only real field-technician gaps", () => {
    const settings = readFileSync("client/accounting.js", "utf8");
    expect(settings).toContain(
      "Labor cost is billed labor times the technician's commission percent, plus burden. Burden is payroll timesheet hours times the burden rate. Hourly technicians use those hours times their hourly rate.",
    );
    expect(settings).toContain(
      "Field technicians missing a commission percent and an hourly rate",
    );
    expect(settings).toContain("neither a commission percent nor an hourly rate");
    expect(settings).toContain("<h4>Burden not set</h4>");
    expect(settings).toContain(": not set");
    expect(settings).not.toContain("Active technicians missing a ServiceTitan rate");
    expect(settings).not.toContain("left out of actual cost");
    expect(settings).not.toContain("TODO: Exclude non-technicians");
    const gaps = readFileSync("src/domain/laborActuals.ts", "utf8");
    expect(gaps).toContain("AND is_field_tech");
    expect(gaps).toContain("pay_basis = 'missing'");
    expect(gaps).not.toContain("TODO: Exclude non-technicians");
    expect(readFileSync("src/domain/commissionLabor.ts", "utf8")).toContain(
      "tech.isManagedTech !== false",
    );
  });
});
