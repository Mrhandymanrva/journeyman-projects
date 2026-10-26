import { beforeAll, afterAll, it, expect } from "vitest";
import {
  startHarness,
  createTenant,
  projectBody,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";
import { today, nextCommunicationDate } from "../src/domain/projectControls.js";
let h: Harness, t: TenantFixture, other: TenantFixture, p: string, q: string;
const prefix = "/api/v1/projects/projects/";
const owner = () => h.as(t.staff.owner!.token);
const url = () => prefix + p + "/controls";
const task = (title: string) => ({ title, start_on: today(), due_on: today() });
async function create(kind: string, data: any) {
  const r = await owner().post(url()).send({ kind, data });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data;
}
beforeAll(async () => {
  h = await startHarness();
  t = await createTenant(h, { slug: "controls" });
  other = await createTenant(h, { slug: "other-controls" });
  p = (await owner().post(prefix.slice(0, -1)).send(projectBody())).body.data
    .id;
  q = (
    await h
      .as(other.staff.owner!.token)
      .post(prefix.slice(0, -1))
      .send(projectBody())
  ).body.data.id;
});
afterAll(async () => {
  await h?.close();
});
it("maintains task completion dates, WBS leaves, dependency checks and immutable baseline target", async () => {
  const parent = await create("task", task("Work package")),
    a = await create("task", { ...task("Demolition"), parent_id: parent.id }),
    b = await create("task", {
      ...task("Rough-in"),
      parent_id: parent.id,
      dependency_ids: [a.id],
    });
  expect(
    (
      await owner()
        .patch(url() + "/" + b.id)
        .send({ version: 1, data: { ...b.data, state: "complete" } })
    ).status,
  ).toBe(400);
  const baseline = await owner()
    .post(url() + "/baseline")
    .send({ finish_on: "2099-01-01" });
  expect(baseline.status).toBe(201);
  expect(
    (
      await owner()
        .patch(url() + "/" + a.id)
        .send({ version: 1, data: { ...a.data, state: "complete" } })
    ).status,
  ).toBe(200);
  const d = (await owner().get(url())).body.data;
  expect(d.baseline.total).toBe(2);
  expect(d.history.at(-1)).toMatchObject({ total: 2, remaining: 1 });
  expect(d.records.find((r: any) => r.id === a.id).data.completed_on).toBe(
    today(),
  );
  await create("task", task("Added scope"));
  const next = (await owner().get(url())).body.data;
  expect(next.baseline.total).toBe(2);
  expect(next.history.at(-1)).toMatchObject({ total: 3, remaining: 2 });
  expect(
    (
      await owner()
        .patch(url() + "/" + a.id)
        .send({ version: 1, data: a.data })
    ).status,
  ).toBe(409);
  expect(
    (
      await owner()
        .patch(url() + "/" + parent.id)
        .send({ version: 1, active: false, data: parent.data })
    ).status,
  ).toBe(409);
});
it("rejects hierarchy cycles, foreign task references and invalid completion dates", async () => {
  const a = await create("task", task("Parent A")),
    b = await create("task", { ...task("Child B"), parent_id: a.id });
  expect(
    (
      await owner()
        .patch(url() + "/" + a.id)
        .send({ version: 1, data: { ...a.data, parent_id: b.id } })
    ).status,
  ).toBe(400);
  expect(
    (
      await owner()
        .post(url())
        .send({
          kind: "task",
          data: { ...task("Foreign"), parent_id: other.staff.owner!.id },
        })
    ).status,
  ).toBe(400);
  expect(
    (
      await owner()
        .post(url())
        .send({
          kind: "task",
          data: {
            ...task("Future complete"),
            state: "complete",
            completed_on: "2099-01-01",
          },
        })
    ).status,
  ).toBe(400);
});
it("enforces tenant, project and role boundaries for records and files", async () => {
  const d = await create("document", {
    title: "Permit document",
    folder: "permits",
  });
  expect((await h.as(other.staff.owner!.token).get(url())).status).toBe(404);
  expect(
    (
      await h
        .as(other.staff.owner!.token)
        .get(prefix + q + "/controls/" + d.id + "/file")
    ).status,
  ).toBe(404);
  expect(
    (
      await h
        .as(t.staff.office!.token)
        .post(url())
        .send({ kind: "task", data: task("Office task") })
    ).status,
  ).toBe(403);
  expect(
    (
      await h
        .as(t.staff.office!.token)
        .post(url())
        .send({
          kind: "document",
          data: { title: "Office upload", folder: "other" },
        })
    ).status,
  ).toBe(201);
  const file = {
    file_name: "permit.txt",
    media_type: "text/plain",
    content: Buffer.from("Permit approval example").toString("base64"),
  };
  expect(
    (
      await owner()
        .post(url() + "/" + d.id + "/file")
        .send(file)
    ).status,
  ).toBe(201);
  expect(
    (await owner().get(url() + "/" + d.id + "/file")).body.data.content.replace(
      /\s/g,
      "",
    ),
  ).toBe(file.content);
  expect(
    (
      await owner()
        .post(url() + "/" + d.id + "/file")
        .send(file)
    ).status,
  ).toBe(409);
  const invalid = await create("document", {
    title: "Invalid attachment",
    folder: "other",
  });
  expect(
    (
      await owner()
        .post(url() + "/" + invalid.id + "/file")
        .send({ ...file, media_type: "application/pdf" })
    ).status,
  ).toBe(400);
});
it("tracks reserves without changing budget and hides allocations from roles without financial access", async () => {
  const before = await owner().get(prefix + p + "/budget");
  const r = await create("reserve", {
    title: "Permit contingency",
    category: "contingency",
    allocated: 1000,
    drawn: 250,
  });
  expect(
    (
      await owner()
        .patch(url() + "/" + r.id)
        .send({ version: 1, data: { ...r.data, drawn: 1001 } })
    ).status,
  ).toBe(400);
  expect(
    (
      await h
        .as(t.staff.pm!.token)
        .post(url())
        .send({ kind: "reserve", data: r.data })
    ).status,
  ).toBe(403);
  expect(
    (await h.as(t.staff.office!.token).get(url())).body.data.records.some(
      (x: any) => x.kind === "reserve",
    ),
  ).toBe(false);
  expect(
    (await h.as(t.staff.office!.token).get(url() + "/" + r.id + "/history"))
      .status,
  ).toBe(403);
  expect((await owner().get(prefix + p + "/budget")).body).toEqual(before.body);
});
it("rolls milestone status up from tasks and goal percent up from milestones", async () => {
  const goal = await create("goal", {
    title: "Roll-up goal",
    due_on: "2099-01-01",
    key_results: [],
    state: "complete",
  });
  expect(goal.data.key_results).toEqual([]);
  expect(goal.data.state).toBe("not_started");
  const none = await create("milestone", {
    title: "Roll-up with no tasks",
    due_on: "2099-01-01",
    goal_id: goal.id,
    state: "complete",
  });
  expect(none.data.state).toBe("not_started");
  const partial = await create("milestone", {
    title: "Roll-up partial",
    due_on: "2099-01-01",
    goal_id: goal.id,
  });
  await create("task", {
    ...task("Roll-up finished piece"),
    due_on: "2099-01-01",
    state: "complete",
    milestone_id: partial.id,
  });
  await create("task", {
    ...task("Roll-up open piece"),
    due_on: "2099-01-01",
    state: "in_progress",
    milestone_id: partial.id,
  });
  const finished = await create("milestone", {
    title: "Roll-up all done",
    due_on: "2099-01-01",
    goal_id: goal.id,
  });
  await create("task", {
    ...task("Roll-up done A"),
    due_on: "2099-01-01",
    state: "complete",
    milestone_id: finished.id,
  });
  await create("task", {
    ...task("Roll-up done B"),
    due_on: "2099-01-01",
    state: "complete",
    milestone_id: finished.id,
  });
  const late = await create("milestone", {
    title: "Roll-up late",
    due_on: "2099-01-01",
    goal_id: goal.id,
  });
  await create("task", {
    title: "Roll-up overdue piece",
    start_on: "2020-01-01",
    due_on: "2020-01-02",
    milestone_id: late.id,
  });
  const rows = (await owner().get(url())).body.data.records;
  const byTitle = (title: string) =>
    rows.find((row: { data: { title: string } }) => row.data.title === title);
  expect(byTitle("Roll-up with no tasks").rollup).toMatchObject({
    status: "on_track",
    total: 0,
    done: 0,
  });
  expect(byTitle("Roll-up with no tasks").data.state).toBe("not_started");
  expect(byTitle("Roll-up partial").rollup).toMatchObject({
    status: "on_track",
    done: 1,
    total: 2,
  });
  expect(byTitle("Roll-up all done").data.state).toBe("not_started");
  expect(byTitle("Roll-up all done").rollup.status).toBe("done");
  expect(byTitle("Roll-up late").rollup.status).toBe("late");
  expect(byTitle("Roll-up goal").data.key_results).toEqual([]);
  expect(byTitle("Roll-up goal").data.state).toBe("not_started");
  expect(byTitle("Roll-up goal").rollup).toEqual({
    status: "late",
    percent: 25,
    done: 1,
    total: 4,
  });
  const kept = await owner()
    .patch(url() + "/" + none.id)
    .send({
      version: none.version,
      data: { ...none.data, state: "complete", completed_on: today() },
    });
  expect(kept.status, JSON.stringify(kept.body)).toBe(200);
  expect(kept.body.data.data.state).toBe("not_started");
  expect(kept.body.data.data.completed_on).toBeNull();
});

it("saves a goal with no key results", async () => {
  const goal = await create("goal", {
    title: "Room is ready to use",
    description: "The customer can use the room",
    due_on: today(),
    key_results: [],
  });
  expect(goal.data.key_results).toEqual([]);
  const omitted = await owner()
    .post(url())
    .send({ kind: "goal", data: { title: "No measure yet", due_on: today() } });
  expect(omitted.status, JSON.stringify(omitted.body)).toBe(201);
  expect(omitted.body.data.data.key_results).toEqual([]);
  const same = await owner()
    .post(url())
    .send({
      kind: "goal",
      data: {
        title: "Bad measure",
        due_on: today(),
        key_results: [
          { name: "Inspections", start: 1, target: 1, current: 1, unit: "inspections" },
        ],
      },
    });
  expect(same.status).toBe(400);
});

it("records goals, linked milestones, RAG reports, ROAM risks and delivery history", async () => {
  const goal = await create("goal", {
    title: "Ready for handover",
    due_on: today(),
    key_results: [
      {
        name: "Punch-list closed",
        start: 0,
        target: 10,
        current: 3,
        unit: "items",
      },
    ],
  });
  await create("milestone", {
    title: "Customer walkthrough",
    due_on: today(),
    goal_id: goal.id,
  });
  expect(
    (
      await owner()
        .post(url())
        .send({
          kind: "risk",
          data: {
            title: "Unowned risk",
            likelihood: 3,
            impact: 4,
            roam: "owned",
            review_on: today(),
          },
        })
    ).status,
  ).toBe(400);
  await create("risk", {
    title: "Hidden water damage",
    likelihood: 3,
    impact: 4,
    roam: "mitigated",
    review_on: today(),
    response: "Inspect wall cavity before finishes",
  });
  await create("report", {
    title: "Weekly review",
    overall: "amber",
    scope: "green",
    schedule: "amber",
    cost: "green",
    quality: "not_assessed",
  });
  const c = await create("communication", {
    title: "Customer update",
    audience: "Customer",
    channel: "email",
    cadence: "weekly",
    next_on: today(),
  });
  const logged = await owner()
    .post(url() + "/" + c.id + "/deliver")
    .send({ version: 1, notes: "Progress and next inspection shared." });
  expect(logged.status).toBe(200);
  expect(logged.body.data.data.last_delivered_on).toBe(today());
  expect(logged.body.data.data.next_on).toBe(
    nextCommunicationDate("weekly", today()),
  );
  const history = await owner().get(url() + "/" + c.id + "/history");
  expect(
    history.body.data.some((r: any) => r.action === "communication_delivered"),
  ).toBe(true);
  expect(nextCommunicationDate("monthly", "2026-01-31")).toBe("2026-02-28");
});

it("deletes a milestone without deleting its tasks, checks versions and allows restoration", async()=>{
 const milestone=await create("milestone",{title:"Temporary milestone",due_on:today()});
 const linked=await create("task",{...task("Keep this work"),milestone_id:milestone.id});
 expect((await h.as(t.staff.office!.token).del(url()+"/"+milestone.id).send({version:1})).status).toBe(403);
 expect((await owner().del(url()+"/"+milestone.id).send({version:99})).status).toBe(409);
 const deleted=await owner().del(url()+"/"+milestone.id).send({version:1});
 expect(deleted.status,JSON.stringify(deleted.body)).toBe(200);
 expect(deleted.body.data).toMatchObject({active:false,version:2,unlinked_tasks:1});
 const rows=(await owner().get(url())).body.data.records;
 const kept=rows.find((x:any)=>x.id===linked.id);
 expect(kept.active).toBe(true);expect(kept.data).toEqual({...linked.data,milestone_id:null});expect(kept.version).toBe(2);
 expect((await owner().patch(url()+"/"+linked.id).send({version:1,data:linked.data})).status).toBe(409);
 expect((await owner().patch(url()+"/"+milestone.id).send({version:2,data:milestone.data,active:true})).status).toBe(200);
 expect((await owner().del(url()+"/"+linked.id).send({version:2})).status).toBe(400);
});
