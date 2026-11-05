import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GANTT_ROW_HEIGHT, ganttLayout, renderGantt } from "../client/gantt.js";
import { createPlanning } from "../client/planning.js";
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/blantonPlanAppointments.json", import.meta.url),
    "utf8",
  ),
) as {
  data: {
    rows: Array<{
      external_job_id: string;
      external_appointment_id: string;
      job_number: string;
      appointment_number: string;
      starts_at: string;
      ends_at: string;
      status: string;
      job_status: string;
      active: boolean;
      observed_at: string;
    }>;
  };
};

const FROM = "2026-10-29";
const TO = "2026-11-25";
const base = "/api/v1/projects";

/**
 * A 70vh panel is about seven 96px rows on a normal laptop. Phased work fills
 * that panel, and unphased ServiceTitan visits are drawn after it, so the
 * visits sit in the clipped overflow instead of on the page.
 */
function unphasedVisitsAreClipped(
  rows: Array<{
    id: string;
    source?: string;
    phase?: string | null;
    window_start: string;
    window_end: string;
    title: string;
    status: string;
    project_id: string;
  }>,
): boolean {
  const css = readFileSync("client/workspace.css", "utf8");
  const rule = css.match(/\.gantt-scroll\{[^}]*\}/)?.[0] ?? "";
  if (!/max-height\s*:\s*70vh/.test(rule)) return false;
  const visual = ganttLayout(rows, new Set()).visual;
  const fold = Math.floor((0.7 * 1000) / GANTT_ROW_HEIGHT);
  const shown = visual.slice(0, fold);
  const stShown = shown.some(
    (row) => row.kind === "task" && row.task.source === "servicetitan",
  );
  const stBelow = visual
    .slice(fold)
    .some((row) => row.kind === "task" && row.task.source === "servicetitan");
  return stBelow && !stShown;
}

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );

let h: Harness;
let t: TenantFixture;
let projectId: string;

beforeAll(async () => {
  h = await startHarness();
  t = await createTenant(h, { slug: "blanton-plan" });
  const created = await h
    .as(t.staff.owner!.token)
    .post(base + "/projects")
    .send(projectBody({ name: "Blanton", project_number: "BLANTON" }));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  projectId = created.body.data.id as string;
  await h.db.withTenant(t.id, async (db) => {
    await db.query(
      `UPDATE projects.projects SET business_unit_id = NULL WHERE id = $1`,
      [projectId],
    );
    const system = await db.query<{ id: string }>(
      `INSERT INTO projects.external_systems (tenant_id, adapter_key, display_name)
       VALUES ($1, 'servicetitan', 'ServiceTitan') RETURNING id`,
      [t.id],
    );
    const systemId = system.rows[0]!.id;
    await db.query(
      `INSERT INTO projects.st_project_connections
         (project_id, tenant_id, external_system_id, external_project_id, connection_key, snapshot, observed_at, linked_by)
       VALUES ($1,$2,$3,'321612166','test','{}','2026-10-29T18:48:00.857Z',$4)`,
      [projectId, t.id, systemId, t.staff.owner!.id],
    );
    for (const row of fixture.data.rows) {
      await db.query(
        `INSERT INTO projects.project_job_links
           (tenant_id, project_id, external_system_id, external_job_id, title, source_active, source_job_number, source_job_status)
         VALUES ($1,$2,$3,$4,$5,true,$6,$7)`,
        [
          t.id,
          projectId,
          systemId,
          row.external_job_id,
          "Job " + row.job_number,
          row.job_number,
          row.job_status,
        ],
      );
      await db.query(
        `INSERT INTO projects.st_plan_appointments
           (tenant_id, project_id, external_job_id, external_appointment_id, job_number, appointment_number,
            job_status, starts_at, ends_at, status, active, technicians, observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]'::jsonb,$12)`,
        [
          t.id,
          projectId,
          row.external_job_id,
          row.external_appointment_id,
          row.job_number,
          row.appointment_number,
          row.job_status,
          row.starts_at,
          row.ends_at,
          row.status,
          row.active,
          row.observed_at,
        ],
      );
    }
    await db.query(
      `INSERT INTO projects.st_plan_appointment_reads (tenant_id, project_id, read_at, skipped, failed_jobs, error)
       VALUES ($1,$2,'2026-10-30T10:11:16Z',0,'[]'::jsonb,NULL)`,
      [t.id, projectId],
    );
  });
});

afterAll(async () => {
  await h?.close();
});

it("shows Blanton's stored ServiceTitan visits for 2026-10-29 through 2026-11-25", async () => {
  const owner = () => h.as(t.staff.owner!.token);
  const response = await owner().get(
    `${base}/projects/${projectId}/plan-appointments?from=${FROM}&to=${TO}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const data = response.body.data;
  expect(data.linkedProjects).toBe(1);
  expect(data.configured).toBe(true);
  expect(data.rows).toHaveLength(26);
  expect(data.message).toMatch(
    /^Linked · 26 ST appointments in this range · last read /,
  );
  expect(data.message).not.toMatch(
    /Refresh failed|Connect this project|not configured|could not refresh/i,
  );
  const nov9 = data.rows.find(
    (row: { appointment_id: string }) => row.appointment_id === "323387418",
  );
  expect(nov9).toMatchObject({
    source: "servicetitan",
    title: "ST job 146012 · 146012-1",
    window_start: "2026-11-09",
    window_end: "2026-11-09",
    status: "confirmed",
    source_status: "Scheduled",
    phase: null,
    project_id: projectId,
  });
  expect(
    data.rows.filter((row: { status: string }) => row.status === "confirmed"),
  ).toHaveLength(26);
  expect(
    data.rows.some(
      (row: { window_start: string }) =>
        row.window_start < FROM || row.window_start > TO,
    ),
  ).toBe(false);

  const unit = Object.values(t.businessUnits)[0];
  await h.db.withTenant(t.id, async (db) => {
    await db.query(
      `UPDATE projects.tenant_settings SET enforce_business_unit_scoping = true WHERE tenant_id = $1`,
      [t.id],
    );
    await db.query(
      `UPDATE projects.staff SET business_unit_id = $2 WHERE id = $1`,
      [t.staff.owner!.id, unit],
    );
  });
  const scoped = await owner().get(
    `${base}/projects/${projectId}/plan-appointments?from=${FROM}&to=${TO}`,
  );
  expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
  expect(scoped.body.data.rows).toHaveLength(26);

  const pm = ["Rough-in", "Waterproofing and finishes", "Closeout"].flatMap(
    (phase, phaseIndex) =>
      [0, 1].map((n) => ({
        id: `pm-${phaseIndex}-${n}`,
        title: phase + " " + n,
        phase,
        window_start: "2026-10-30",
        window_end: "2026-11-02",
        status: "confirmed",
        project_id: projectId,
        source: "plan",
        resources: [{ id: "crew", name: "Crew", schedulable: true }],
        dependencies: [],
      })),
  );
  const dom = new JSDOM(
    `<!doctype html><body>
      <div id="planning-summary"></div>
      <select id="planning-view"><option value="timeline">Gantt timeline</option></select>
      <select id="planning-phase"><option value="">All phases</option></select>
      <select id="planning-filter"><option value="all">All work</option><option value="attention">Needs attention</option><option value="unassigned">Unassigned</option></select>
      <input id="planning-all" type="checkbox">
      <span id="planning-range"></span>
      <input id="planning-from" type="date">
      <select id="planning-zoom"><option value="28" selected>4 weeks</option></select>
      <div id="planning-rows"></div>
      <button id="planning-new"></button><button id="planning-resource"></button>
      <button id="planning-job"></button><button id="planning-vendors"></button>
      <button id="planning-prev"></button><button id="planning-next"></button><button id="planning-today"></button>
      <div id="plan-scheduled-work"></div>
    </body>`,
    { url: "http://localhost/" },
  );
  const document = dom.window.document;
  const el = (id: string) => document.getElementById(id);
  const planning = createPlanning({
    api: async (path: string) => {
      if (String(path).includes("plan-appointments")) return data;
      return [];
    },
    el,
    esc,
    can: () => true,
    current: () => ({ id: projectId }),
    openDrawer: () => {},
    submit: async () => {},
    field: () => "",
    messageSlot: "",
    refresh: async () => {},
  });
  await planning.render(pm);
  el("planning-from")!.value = FROM;
  el("planning-zoom")!.value = "28";
  el("planning-filter")!.value = "all";
  el("planning-phase")!.value = "";
  await planning.refresh();

  expect(el("planning-range")!.textContent).toBe(`${FROM} – ${TO}`);
  expect(el("planning-st-status")!.textContent).toBe(data.message);
  expect(el("planning-st-status")!.textContent).not.toMatch(/Refresh failed/);
  expect(el("planning-summary")!.textContent).toContain("26");
  expect(el("planning-summary")!.textContent).toContain("ST appointments");
  const html = el("planning-rows")!.innerHTML;
  expect(html).toContain("ST job 146012 · 146012-1");
  expect(html).toContain(`data-gantt-id="st:${projectId}:323387418"`);
  const painted = [...pm, ...data.rows];
  expect(
    renderGantt({
      rows: painted,
      from: FROM,
      days: 28,
      projectId,
      editable: true,
      esc,
      today: FROM,
    }),
  ).toContain("ST job 146012 · 146012-1");
  expect(unphasedVisitsAreClipped(painted)).toBe(false);
});
