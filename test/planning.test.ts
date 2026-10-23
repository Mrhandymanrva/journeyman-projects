import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import {
  startHarness,
  createTenant,
  projectBody,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

let h: Harness,
  t: TenantFixture,
  other: TenantFixture,
  project: string,
  foreignProject: string;
let sequence = 0;
const base = "/api/v1/projects";
const owner = () => h.as(t.staff.owner!.token);
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  t = await createTenant(h, { slug: `planning-${sequence++}` });
  other = await createTenant(h, { slug: `planning-${sequence++}` });
  project = (
    await owner()
      .post(base + "/projects")
      .send(projectBody())
  ).body.data.id;
  foreignProject = (
    await h
      .as(other.staff.owner!.token)
      .post(base + "/projects")
      .send(projectBody())
  ).body.data.id;
});
async function resource(name = "Alex") {
  const r = await owner()
    .post(base + "/resources")
    .send({ name, kind: "employee" });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
}
async function activity(
  body: Record<string, unknown> = {},
  projectId = project,
) {
  const r = await owner()
    .post(`${base}/projects/${projectId}/schedule`)
    .send({
      title: "Demo",
      window_start: "2026-09-15",
      window_end: "2026-09-16",
      ...body,
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
}
async function schedule() {
  const r = await owner().get(`${base}/projects/${project}/schedule`);
  expect(r.status).toBe(200);
  return r.body.data as any[];
}

describe("project planning", () => {
  it("assigns several independent resources and preserves date windows", async () => {
    const ids = [await resource("Alex"), await resource("Taylor")];
    const id = await activity({ resource_ids: ids, phase: "Demolition" });
    const row = (await schedule()).find((r) => r.id === id);
    expect(row.resources.map((r: any) => r.id).sort()).toEqual(ids.sort());
    expect(row.phase).toBe("Demolition");
    expect(row.window_start).toBe("2026-09-15");
    expect(
      (await owner().patch(`${base}/schedule/${id}`).send({ resource_ids: [] }))
        .status,
    ).toBe(200);
    expect((await schedule())[0].resources).toHaveLength(0);
  });
  it("rejects foreign resources and keeps the failed activity out of the database", async () => {
    const foreign = await h
      .as(other.staff.owner!.token)
      .post(base + "/resources")
      .send({ name: "Hidden", kind: "employee" });
    const r = await owner()
      .post(`${base}/projects/${project}/schedule`)
      .send({
        title: "Invalid",
        window_start: "2026-09-15",
        window_end: "2026-09-16",
        resource_ids: [foreign.body.data.id],
      });
    expect(r.status).toBe(404);
    expect(await schedule()).toHaveLength(0);
    expect((await owner().get(base + "/resources")).body.data).toHaveLength(0);
  });
  it("rejects duplicate assignments", async () => {
    const id = await resource();
    const item = await activity();
    expect(
      (
        await owner()
          .patch(`${base}/schedule/${item}`)
          .send({ resource_ids: [id, id] })
      ).status,
    ).toBe(400);
  });
  it("detects multi-step cycles and self-dependencies", async () => {
    const a = await activity();
    const b = await activity({ dependencies: [{ predecessor_id: a }] });
    const c = await activity({ dependencies: [{ predecessor_id: b }] });
    expect(
      (
        await owner()
          .patch(`${base}/schedule/${a}`)
          .send({ dependencies: [{ predecessor_id: c }] })
      ).status,
    ).toBe(409);
    expect(
      (
        await owner()
          .patch(`${base}/schedule/${a}`)
          .send({ dependencies: [{ predecessor_id: a }] })
      ).status,
    ).toBe(409);
    expect(
      (await schedule()).find((r) => r.id === a).dependencies,
    ).toHaveLength(0);
  });
  it("rejects predecessors from another project, including legacy depends_on", async () => {
    const second = (
      await owner()
        .post(base + "/projects")
        .send(projectBody())
    ).body.data.id;
    const pred = await activity({}, second);
    const a = await activity();
    expect(
      (
        await owner()
          .patch(`${base}/schedule/${a}`)
          .send({ dependencies: [{ predecessor_id: pred }] })
      ).status,
    ).toBe(404);
    expect(
      (
        await owner().post(`${base}/projects/${project}/schedule`).send({
          title: "No",
          window_start: "2026-09-15",
          window_end: "2026-09-16",
          depends_on: pred,
        })
      ).status,
    ).toBe(404);
  });
  it("reports lag violations and predecessor readiness separately", async () => {
    const a = await activity({ status: "complete" });
    const b = await activity({
      window_start: "2026-09-18",
      window_end: "2026-09-18",
      dependencies: [{ predecessor_id: a, lag_days: 2 }],
    });
    const d = (await schedule()).find((r) => r.id === b).dependencies[0];
    expect(d.status).toBe("complete");
    expect(d.date_conflict).toBe(true);
    expect(
      (
        await owner()
          .patch(`${base}/schedule/${b}`)
          .send({ window_start: "2026-09-19", window_end: "2026-09-19" })
      ).status,
    ).toBe(200);
    expect(
      (await schedule()).find((r) => r.id === b).dependencies[0].date_conflict,
    ).toBe(false);
  });
  it("warns for inclusive resource overlaps and clears warnings for canceled activities", async () => {
    const id = await resource();
    const a = await activity({ resource_ids: [id] });
    const second = (
      await owner()
        .post(base + "/projects")
        .send(projectBody())
    ).body.data.id;
    const b = await activity(
      {
        resource_ids: [id],
        window_start: "2026-09-16",
        window_end: "2026-09-18",
      },
      second,
    );
    expect(
      (await schedule()).find((r) => r.id === a).conflicting_resource_ids,
    ).toEqual([id]);
    await owner().patch(`${base}/schedule/${b}`).send({ status: "cancelled" });
    expect(
      (await schedule()).find((r) => r.id === a).conflicting_resource_ids,
    ).toEqual([]);
  });
  it("blocks noncompliant subcontractors on creation, assignment and confirmation", async () => {
    const v = await owner()
      .post(base + "/vendors")
      .send({ legal_name: "Tile Co", email: "tile@example.test" });
    expect(v.status).toBe(201);
    const r = await owner()
      .post(base + "/resources")
      .send({
        name: "Tile crew",
        kind: "subcontractor",
        vendor_id: v.body.data.id,
      });
    expect(r.status).toBe(201);
    const rid = r.body.data.id;
    const a = await activity({ resource_ids: [rid] });
    const confirm = await owner()
      .patch(`${base}/schedule/${a}`)
      .send({ status: "confirmed" });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(409);
    expect(confirm.body.error.code).toBe("compliance_blocked");
    const firm = await activity({ status: "confirmed" });
    expect(
      (
        await owner()
          .patch(`${base}/schedule/${firm}`)
          .send({ resource_ids: [rid] })
      ).status,
    ).toBe(409);
    const create = await owner()
      .post(`${base}/projects/${project}/schedule`)
      .send({
        title: "Invalid firm",
        window_start: "2026-09-15",
        window_end: "2026-09-16",
        status: "confirmed",
        resource_ids: [rid],
      });
    expect(create.status).toBe(409);
    expect(await schedule()).toHaveLength(2);
  });
  it("supports several job links and prevents assigning another project job", async () => {
    const system = (await owner().get(base + "/external-systems")).body.data[0]
      .id;
    const first = await owner().post(`${base}/projects/${project}/jobs`).send({
      title: "Demo job",
      external_system_id: system,
      external_job_id: "101",
    });
    expect(first.status).toBe(201);
    expect(
      (
        await owner().post(`${base}/projects/${project}/jobs`).send({
          title: "Finish job",
          external_system_id: system,
          external_job_id: "102",
        })
      ).status,
    ).toBe(201);
    const second = (
      await owner()
        .post(base + "/projects")
        .send(projectBody())
    ).body.data.id;
    const outside = await owner().post(`${base}/projects/${second}/jobs`).send({
      title: "Other",
      external_system_id: system,
      external_job_id: "103",
    });
    const a = await activity({ job_link_id: first.body.data.id });
    expect(
      (
        await owner()
          .patch(`${base}/schedule/${a}`)
          .send({ job_link_id: outside.body.data.id })
      ).status,
    ).toBe(404);
    expect(
      (
        await owner().del(
          `${base}/projects/${project}/jobs/${first.body.data.id}`,
        )
      ).status,
    ).toBe(409);
    await owner().patch(`${base}/schedule/${a}`).send({ job_link_id: null });
    expect(
      (
        await owner().del(
          `${base}/projects/${project}/jobs/${first.body.data.id}`,
        )
      ).status,
    ).toBe(200);
  });
  it("does not let foreign job IDs or vendors cross the tenant boundary", async () => {
    const foreignSystem = (
      await h.as(other.staff.owner!.token).get(base + "/external-systems")
    ).body.data[0].id;
    expect(
      (
        await owner().post(`${base}/projects/${project}/jobs`).send({
          title: "Hidden",
          external_system_id: foreignSystem,
          external_job_id: "1",
        })
      ).status,
    ).toBe(400);
    const f = await h
      .as(other.staff.owner!.token)
      .post(`${base}/projects/${foreignProject}/jobs`)
      .send({
        title: "Hidden",
        external_system_id: foreignSystem,
        external_job_id: "2",
      });
    expect(
      (await owner().del(`${base}/projects/${project}/jobs/${f.body.data.id}`))
        .status,
    ).toBe(404);
  });
  it("bounds lookahead dates and respects tenant and business-unit visibility", async () => {
    await activity();
    await h
      .as(other.staff.owner!.token)
      .post(`${base}/projects/${foreignProject}/schedule`)
      .send({
        title: "Hidden",
        window_start: "2026-09-15",
        window_end: "2026-09-16",
      });
    const r = await owner().get(
      base + "/schedule-lookahead?from=2026-09-15&to=2026-09-28",
    );
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].project_id).toBe(project);
    expect(
      (
        await owner().get(
          base + "/schedule-lookahead?from=2026-09-15&to=2027-09-28",
        )
      ).status,
    ).toBe(400);
    await h.db.withTenant(t.id, async (c) => {
      await c.query(
        "UPDATE projects.tenant_settings SET enforce_business_unit_scoping=true",
      );
      await c.query(
        `UPDATE projects.staff SET business_unit_id=(SELECT id FROM projects.business_units LIMIT 1) WHERE id=$1`,
        [t.staff.owner!.id],
      );
      const unit = await c.query<{ id: string }>(
        "INSERT INTO projects.business_units(tenant_id,name) VALUES ($1,'Private unit') RETURNING id",
        [t.id],
      );
      await c.query(
        "UPDATE projects.projects SET business_unit_id=$1 WHERE id=$2",
        [unit.rows[0]!.id, project],
      );
    });
    expect(
      (
        await owner().get(
          base + "/schedule-lookahead?from=2026-09-15&to=2026-09-28",
        )
      ).body.data,
    ).toHaveLength(0);
  });
  it("enforces write capabilities", async () => {
    const reader = h.as(t.staff.bookkeeper!.token);
    expect(
      (
        await reader
          .post(base + "/resources")
          .send({ name: "No", kind: "employee" })
      ).status,
    ).toBe(403);
    expect(
      (await reader.post(`${base}/projects/${project}/jobs`).send({})).status,
    ).toBe(403);
  });
  it("uses composite database constraints to reject cross-tenant assignments", async () => {
    const a = await activity();
    const f = await h
      .as(other.staff.owner!.token)
      .post(base + "/resources")
      .send({ name: "Foreign", kind: "employee" });
    await expect(
      h.db.withTenant(t.id, (c) =>
        c.query(
          `INSERT INTO projects.schedule_assignments(tenant_id,project_id,schedule_item_id,resource_id) VALUES ($1,$2,$3,$4)`,
          [t.id, project, a, f.body.data.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

it("edits, removes and restores resources while retaining existing assignments", async () => {
  const id = await resource("Editable crew");
  const item = await activity({ resource_ids: [id] });
  expect(
    (
      await owner()
        .patch(base + "/resources/" + id)
        .send({ name: "Renamed crew", trade: "Painting" })
    ).status,
  ).toBe(200);
  expect(
    (
      await h
        .as(other.staff.owner!.token)
        .patch(base + "/resources/" + id)
        .send({ active: false })
    ).status,
  ).toBe(404);
  expect(
    (
      await owner()
        .patch(base + "/resources/" + id)
        .send({ active: false })
    ).status,
  ).toBe(200);
  expect(
    (await owner().get(base + "/resources")).body.data.some(
      (r: any) => r.id === id,
    ),
  ).toBe(false);
  expect(
    (await schedule()).find((r: any) => r.id === item).resources[0].id,
  ).toBe(id);
  expect(
    (
      await owner().get(base + "/resources?include_inactive=true")
    ).body.data.find((r: any) => r.id === id).active,
  ).toBe(false);
  expect(
    (
      await owner()
        .patch(base + "/resources/" + id)
        .send({ active: true })
    ).status,
  ).toBe(200);
  expect(
    (await owner().get(base + "/resources")).body.data.find(
      (r: any) => r.id === id,
    ).name,
  ).toBe("Renamed crew");
});
it("archives companies and their crews reversibly without deleting profiles", async () => {
  const vendor = (
    await owner()
      .post(base + "/vendors")
      .send({ legal_name: "Supply company", email: "supply@example.test" })
  ).body.data;
  const crew = (
    await owner()
      .post(base + "/resources")
      .send({
        name: "Supply crew",
        kind: "subcontractor",
        vendor_id: vendor.id,
      })
  ).body.data;
  expect(
    (
      await owner()
        .patch(base + "/vendors/" + vendor.id)
        .send({ archived: true })
    ).status,
  ).toBe(200);
  expect(
    (await owner().get(base + "/vendors")).body.data.some(
      (v: any) => v.id === vendor.id,
    ),
  ).toBe(false);
  expect(
    (await owner().get(base + "/vendors?include_archived=true")).body.data.find(
      (v: any) => v.id === vendor.id,
    ).archived,
  ).toBe(true);
  expect((await owner().get(base + "/vendors/" + vendor.id)).status).toBe(200);
  expect(
    (await owner().get(base + "/resources")).body.data.some(
      (r: any) => r.id === crew.id,
    ),
  ).toBe(false);
  expect(
    (
      await owner()
        .patch(base + "/resources/" + crew.id)
        .send({ active: true })
    ).status,
  ).toBe(409);
  expect(
    (
      await owner()
        .post(base + "/vendors/" + vendor.id + "/activate")
        .send({})
    ).status,
  ).toBe(409);
  expect(
    (
      await owner()
        .patch(base + "/vendors/" + vendor.id)
        .send({ archived: false })
    ).status,
  ).toBe(200);
  expect(
    (
      await owner()
        .patch(base + "/resources/" + crew.id)
        .send({ active: true })
    ).status,
  ).toBe(200);
});

it('moves successors in both directions and rejects a stale drag atomically',async()=>{
 const a=await activity({title:'Demo',window_start:'2026-09-01',window_end:'2026-09-02'});
 const b=await activity({title:'Framing',window_start:'2026-09-04',window_end:'2026-09-06',dependencies:[{predecessor_id:a}]});
 const c=await activity({title:'Finish',window_start:'2026-09-07',window_end:'2026-09-08',dependencies:[{predecessor_id:b}]});
 const moved=await owner().patch(base+'/schedule/'+a).send({window_start:'2026-09-04',window_end:'2026-09-05',expected_window_start:'2026-09-01',expected_window_end:'2026-09-02'});
 expect(moved.status,JSON.stringify(moved.body)).toBe(200);
 expect((await schedule()).find(r=>r.id===b)).toMatchObject({window_start:'2026-09-07',window_end:'2026-09-09'});
 expect((await schedule()).find(r=>r.id===c)).toMatchObject({window_start:'2026-09-10',window_end:'2026-09-11'});
 expect((await owner().patch(base+'/schedule/'+a).send({window_start:'2026-09-01',expected_window_start:'2026-09-01'})).status).toBe(409);
 expect((await owner().patch(base+'/schedule/'+a).send({window_start:'2026-09-01',window_end:'2026-09-02'})).status).toBe(200);
 expect((await schedule()).find(r=>r.id===c)).toMatchObject({window_start:'2026-09-07',window_end:'2026-09-08'});
});
