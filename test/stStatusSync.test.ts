import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import { ServiceTitanReadAdapter, ServiceTitanStatusWriteError } from "../src/adapters/serviceTitan.js";
import type { SourceConnections } from "../src/adapters/sourceConnections.js";
import {
  PROJECTS_WRITE_SCOPE,
  ST_STATUS_FALLBACK,
  ST_SUBSTATUS_FALLBACK,
  decideOutbound,
  gateWarningForInboundMove,
  inboundShouldApply,
  interpretInbound,
  resolveStatusIds,
  scopeNamesFromAuthBody,
  type StProjectStatus,
} from "../src/domain/stStatusMap.js";
import {
  applyInboundStatus,
  pushStageStatus,
  statusClientOf,
  syncLinkedProjectStatuses,
} from "../src/domain/stStatusSync.js";
import { runHourlyLaborRefresh } from "../src/workers/laborRefresh.js";
import {
  SCHEMA_FILES,
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

const resolved = resolveStatusIds(null);
const base = "/api/v1/projects";

function status(partial: Partial<StProjectStatus> = {}): StProjectStatus {
  return {
    statusId: null,
    statusName: null,
    subStatusId: null,
    subStatusName: null,
    modifiedOn: null,
    ...partial,
  };
}

describe("status mapping", () => {
  it("maps both directions and keeps a finer sub-status", () => {
    const pending = status({
      statusId: ST_STATUS_FALLBACK.pending.id,
      statusName: "Pending Scheduling",
      subStatusId: ST_SUBSTATUS_FALLBACK.permitReceived.id,
      subStatusName: "Permit received",
    });
    expect(decideOutbound("precon", pending, resolved)).toEqual({
      action: "skip",
      reason: "preserve-substatus",
    });
    expect(decideOutbound("precon", status({ statusId: ST_STATUS_FALLBACK.pending.id }), resolved)).toEqual({
      action: "patch",
      statusId: ST_STATUS_FALLBACK.pending.id,
      subStatusId: ST_SUBSTATUS_FALLBACK.plansOrdering.id,
    });
    expect(decideOutbound("handoff", status({ statusName: "Pending Scheduling" }), resolved).action).toBe("skip");
    const scheduled = status({
      statusId: ST_STATUS_FALLBACK.scheduled.id,
      subStatusId: ST_SUBSTATUS_FALLBACK.jobsScheduled.id,
      subStatusName: "Jobs Scheduled",
    });
    expect(decideOutbound("mobilization", scheduled, resolved)).toEqual({
      action: "skip",
      reason: "preserve-substatus",
    });
    expect(decideOutbound("mobilization", status({ statusName: "In Progress" }), resolved)).toEqual({
      action: "patch",
      statusId: ST_STATUS_FALLBACK.scheduled.id,
      subStatusId: null,
    });
    expect(
      decideOutbound("execution", status({ statusId: ST_STATUS_FALLBACK.inProgress.id, subStatusId: "999" }), resolved).action,
    ).toBe("skip");
    expect(decideOutbound("closeout", status({ statusName: "In Progress" }), resolved).action).toBe("skip");
    expect(decideOutbound("closeout", status({ statusName: "Scheduled" }), resolved)).toMatchObject({
      action: "patch",
      statusId: ST_STATUS_FALLBACK.inProgress.id,
      subStatusId: null,
    });
    expect(decideOutbound("complete", status(), resolved)).toMatchObject({
      statusId: ST_STATUS_FALLBACK.completed.id,
    });
    expect(decideOutbound("cancelled", status(), resolved)).toMatchObject({
      statusId: ST_STATUS_FALLBACK.canceled.id,
    });

    expect(interpretInbound("handoff", status({ statusName: "Pending Scheduling" }), resolved)).toEqual({
      kind: "stage",
      stage: "handoff",
    });
    expect(interpretInbound("handoff", pending, resolved)).toEqual({ kind: "stage", stage: "precon" });
    expect(interpretInbound("closeout", status({ statusName: "InProgress" }), resolved)).toEqual({
      kind: "stage",
      stage: "closeout",
    });
    expect(interpretInbound("handoff", status({ statusName: "In Progress" }), resolved)).toEqual({
      kind: "stage",
      stage: "execution",
    });
    expect(interpretInbound("execution", status({ statusName: "Completed" }), resolved)).toEqual({
      kind: "stage",
      stage: "complete",
    });
    expect(interpretInbound("complete", status({ statusName: "Canceled" }), resolved)).toEqual({
      kind: "stage",
      stage: "cancelled",
    });
    expect(interpretInbound("cancelled", status({ statusName: "Cancelled" }), resolved)).toEqual({
      kind: "stage",
      stage: "cancelled",
    });
    expect(interpretInbound("handoff", status(), resolved)).toEqual({ kind: "none" });
  });

  it("shows Hold and Bid as badges and never writes them", () => {
    expect(interpretInbound("execution", status({ statusId: ST_STATUS_FALLBACK.hold.id, statusName: "Hold" }), resolved)).toEqual({
      kind: "badge",
      badge: "Hold",
    });
    expect(interpretInbound("precon", status({ statusName: "Bid" }), resolved)).toEqual({ kind: "badge", badge: "Bid" });
    for (const stage of ["handoff", "precon", "mobilization", "execution", "closeout", "complete", "cancelled"] as const) {
      const decision = decideOutbound(stage, status(), resolved);
      expect(decision.action).toBe("patch");
      if (decision.action === "patch") {
        expect([ST_STATUS_FALLBACK.hold.id, ST_STATUS_FALLBACK.bid.id]).not.toContain(decision.statusId);
      }
    }
  });

  it("uses the catalog id for a known name and falls back when the name is absent", () => {
    const catalog = resolveStatusIds({
      statuses: [{ id: "42", name: "Pending Scheduling" }],
      substatuses: [{ id: "77", name: "Plans ordering" }],
    });
    expect(catalog.statusId.pending).toBe("42");
    expect(catalog.statusId.hold).toBe(ST_STATUS_FALLBACK.hold.id);
    expect(decideOutbound("precon", status(), catalog)).toMatchObject({
      statusId: "42",
      subStatusId: "77",
    });
  });

  it("lets the later timestamp win", () => {
    expect(inboundShouldApply("2026-10-02T00:00:00Z", "2026-10-01T00:00:00Z")).toBe(true);
    expect(inboundShouldApply("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z")).toBe(false);
    expect(inboundShouldApply(null, null)).toBe(true);
    expect(inboundShouldApply(null, "2026-10-01T00:00:00Z")).toBe(false);
    expect(inboundShouldApply("2026-10-01T00:00:00Z", null)).toBe(true);
  });

  it("warns when an inbound move skips gates and does not describe a legal cancel", () => {
    const gates = [{ gate_number: 0, title: "Qualification and handoff", status: "open" as const }];
    expect(gateWarningForInboundMove("handoff", "execution", gates)).toMatch(/outside the one-step/);
    expect(gateWarningForInboundMove("handoff", "precon", gates)).toMatch(/gate 0/);
    expect(gateWarningForInboundMove("cancelled", "handoff", gates)).toMatch(/from cancelled/);
    expect(gateWarningForInboundMove("precon", "cancelled", gates)).toBeNull();
  });

  it("reads scope names from the token response or the JWT and drops the token", () => {
    const token = "header.payload.signature-secret";
    expect(scopeNamesFromAuthBody({
      access_token: token,
      scope: "tn.jpm.jobs:r tn.jpm.projects:w",
    })).toEqual(["tn.jpm.jobs:r", "tn.jpm.projects:w"]);
    const payload = Buffer.from(JSON.stringify({ scope: ["tn.jpm.projects:w", "tn.jpm.jobs:r"] })).toString("base64url");
    const jwt = `aaa.${payload}.zzz`;
    const names = scopeNamesFromAuthBody({ access_token: jwt });
    expect(names).toEqual(["tn.jpm.jobs:r", "tn.jpm.projects:w"]);
    expect(JSON.stringify(names)).not.toContain(jwt);
    expect(names).not.toContain(token);
  });
});

describe("ServiceTitan status client", () => {
  const config = {
    environment: "integration" as const,
    tenantId: "10",
    clientId: "client",
    clientSecret: "secret",
    appKey: "app",
  };

  it("reports scope names and hasProjectsWrite without the access token", async () => {
    const payload = Buffer.from(JSON.stringify({ scope: "tn.jpm.projects:w tn.jpm.jobs:r" })).toString("base64url");
    const jwt = `hdr.${payload}.sig`;
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ access_token: jwt, expires_in: 900 }), { status: 200 }),
    );
    const client = new ServiceTitanReadAdapter(config, fetcher);
    const access = await client.grantedScopes();
    expect(access).toEqual({
      scopes: ["tn.jpm.jobs:r", PROJECTS_WRITE_SCOPE],
      hasProjectsWrite: true,
    });
    expect(JSON.stringify(access)).not.toContain(jwt);
  });

  it("patches status and sub-status and does not retry HTTP 403", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok", expires_in: 900, scope: PROJECTS_WRITE_SCOPE }), { status: 200 }),
    );
    fetcher.mockResolvedValueOnce(new Response("missing scope", { status: 403 }));
    const client = new ServiceTitanReadAdapter(config, fetcher);
    await expect(
      client.updateProjectStatus("200", {
        statusId: ST_STATUS_FALLBACK.pending.id,
        subStatusId: ST_SUBSTATUS_FALLBACK.plansOrdering.id,
      }),
    ).rejects.toMatchObject({ httpStatus: 403, retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const call = fetcher.mock.calls[1]!;
    expect(String(call[0])).toBe("https://api-integration.servicetitan.io/jpm/v2/tenant/10/projects/200");
    expect(call[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      statusId: Number(ST_STATUS_FALLBACK.pending.id),
      subStatusId: Number(ST_SUBSTATUS_FALLBACK.plansOrdering.id),
    });
    expect(fetcher.mock.calls[1]?.[1]?.headers).not.toHaveProperty("access_token");
  });
});

describe("project status sync", () => {
  let h: Harness;
  let t: TenantFixture;
  let sourceId: string;
  const sources: SourceConnections = {};
  const readProjectStatus = vi.fn<(id: string) => Promise<StProjectStatus>>();
  const updateProjectStatus = vi.fn();
  const readStatusCatalog = vi.fn(async () => ({ statuses: [], substatuses: [] }));
  const grantedScopes = vi.fn(async () => ({
    scopes: ["tn.jpm.jobs:r", PROJECTS_WRITE_SCOPE],
    hasProjectsWrite: true,
  }));
  const readProjectDetails = vi.fn();
  const TOKEN = "portfolio-feed-token-for-status-sync";

  beforeAll(async () => {
    h = await startHarness(SCHEMA_FILES, sources);
    t = await createTenant(h, { slug: "st-status-sync" });
    sourceId = await h.db.withTenant(t.id, async (db) => {
      const row = await db.query<{ id: string }>(
        `INSERT INTO projects.external_systems (tenant_id, adapter_key, display_name)
         VALUES ($1, 'servicetitan', 'ST') RETURNING id`,
        [t.id],
      );
      return row.rows[0]!.id;
    });
    sources.serviceTitan = {
      tenantId: t.id,
      externalSystemId: sourceId,
      key: "st:production:10",
      writesEnabled: false,
      client: {
        readJob: vi.fn(async () => {
          throw new Error("unused");
        }),
        readProjectStatus,
        updateProjectStatus,
        readStatusCatalog,
        grantedScopes,
        listProjects: vi.fn(async () => ({ data: [], hasMore: false, page: 1 })),
        readProjectDetails,
        readJobTimesheets: vi.fn(async (jobId: string) => ({
          jobId,
          forbidden: false,
          timesheets: [],
        })),
      },
    };
  });

  beforeEach(() => {
    readProjectStatus.mockReset();
    updateProjectStatus.mockReset();
    readProjectDetails.mockReset();
    readProjectStatus.mockResolvedValue(status());
    updateProjectStatus.mockImplementation(async (_id: string, patch: { statusId: string; subStatusId: string | null }) =>
      status({
        statusId: patch.statusId,
        subStatusId: patch.subStatusId,
        modifiedOn: "2026-10-27T12:00:00Z",
      }),
    );
  });

  afterAll(async () => {
    await h?.close();
  });

  const owner = () => h.as(t.staff.owner!.token);

  async function makeProject(): Promise<string> {
    const res = await owner().post(`${base}/projects`).send(projectBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data.id as string;
  }

  async function link(projectId: string, externalProjectId: string): Promise<void> {
    await h.db.withTenant(t.id, (db) =>
      db.query(
        `INSERT INTO projects.st_project_connections
           (project_id, tenant_id, external_system_id, external_project_id, connection_key, snapshot, observed_at, linked_by)
         VALUES ($1, $2, $3, $4, 'st:production:10', '{}', now(), $5)`,
        [projectId, t.id, sourceId, externalProjectId, t.staff.owner!.id],
      ),
    );
  }

  async function auditWrites(projectId: string) {
    return h.db.withTenant(t.id, (db) =>
      db.query<{
        action: string;
        actor_type: string;
        actor_id: string | null;
        after_data: Record<string, unknown>;
      }>(
        `SELECT action, actor_type, actor_id, after_data FROM projects.audit_log
          WHERE entity_id = $1 AND action = 'st_status_write'`,
        [projectId],
      ),
    );
  }

  it("writes the stage immediately, records an audit row, and still writes when PM_ST_WRITES_ENABLED is off", async () => {
    expect(sources.serviceTitan?.writesEnabled).toBe(false);
    const id = await makeProject();
    await link(id, "501");
    readProjectStatus.mockResolvedValue(status({ statusName: "Bid", statusId: ST_STATUS_FALLBACK.bid.id }));
    await owner().post(`${base}/projects/${id}/gates/0/approve`);
    const res = await owner().post(`${base}/projects/${id}/stage`).send({ stage: "precon" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.stage).toBe("precon");
    expect(res.body.data.st_status_sync).toMatchObject({ ok: true, result: "ok" });
    expect(updateProjectStatus).toHaveBeenCalledTimes(1);
    expect(updateProjectStatus).toHaveBeenCalledWith("501", {
      statusId: ST_STATUS_FALLBACK.pending.id,
      subStatusId: ST_SUBSTATUS_FALLBACK.plansOrdering.id,
    });
    const rows = await auditWrites(id);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      actor_type: "staff",
      actor_id: t.staff.owner!.id,
    });
    expect(rows.rows[0]!.after_data).toMatchObject({
      who: { type: "staff", id: t.staff.owner!.id },
      from_stage: "handoff",
      to_stage: "precon",
      result: "ok",
    });
    expect(rows.rows[0]!.after_data.st_before).toMatchObject({ statusId: ST_STATUS_FALLBACK.bid.id });
    expect(rows.rows[0]!.after_data.st_after).toBeTruthy();
    expect(rows.rows[0]!.after_data.started_at).toEqual(expect.any(String));
    expect(rows.rows[0]!.after_data.finished_at).toEqual(expect.any(String));
  });

  it("does not overwrite a precon sub-status that is already set", async () => {
    const id = await makeProject();
    await link(id, "502");
    readProjectStatus.mockResolvedValue(
      status({
        statusId: ST_STATUS_FALLBACK.pending.id,
        statusName: "Pending Scheduling",
        subStatusId: ST_SUBSTATUS_FALLBACK.permitSubmitted.id,
        subStatusName: "Permit submitted",
        modifiedOn: "2026-10-01T00:00:00Z",
      }),
    );
    await owner().post(`${base}/projects/${id}/gates/0/approve`);
    const res = await owner().post(`${base}/projects/${id}/stage`).send({ stage: "precon" });
    expect(res.status).toBe(200);
    expect(updateProjectStatus).not.toHaveBeenCalled();
    expect(res.body.data.st_status_sync.result).toBe("skipped");
    const rows = await auditWrites(id);
    expect(rows.rows[0]!.after_data.result).toBe("skipped");
  });

  it("surfaces HTTP 403 once and does not retry it", async () => {
    const id = await makeProject();
    await link(id, "503");
    updateProjectStatus.mockRejectedValue(
      new ServiceTitanStatusWriteError(403, "HTTP 403", false),
    );
    await owner().post(`${base}/projects/${id}/gates/0/approve`);
    const res = await owner().post(`${base}/projects/${id}/stage`).send({ stage: "precon" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.stage).toBe("precon");
    expect(updateProjectStatus).toHaveBeenCalledTimes(1);
    expect(res.body.data.st_status_sync).toMatchObject({
      ok: false,
      result: "rejected",
      http_status: 403,
    });
    expect(res.body.data.st_status_sync.message).toContain("HTTP 403");
    expect(res.body.data.st_status_sync.message).toContain(PROJECTS_WRITE_SCOPE);
    expect(res.body.data.st_status.write_result).toBe("rejected");
    const rows = await auditWrites(id);
    expect(rows.rows[0]!.after_data).toMatchObject({ result: "rejected", http_status: 403 });
  });

  it("retries a timeout after re-reading", async () => {
    const id = await makeProject();
    await link(id, "504");
    updateProjectStatus
      .mockRejectedValueOnce(new ServiceTitanStatusWriteError(null, "timed out", true))
      .mockImplementation(async (_id: string, patch: { statusId: string; subStatusId: string | null }) =>
        status({ statusId: patch.statusId, subStatusId: patch.subStatusId, modifiedOn: "2026-10-27T12:00:00Z" }),
      );
    await owner().post(`${base}/projects/${id}/gates/0/approve`);
    const res = await owner().post(`${base}/projects/${id}/stage`).send({ stage: "precon" });
    expect(res.body.data.st_status_sync.result).toBe("ok");
    expect(updateProjectStatus).toHaveBeenCalledTimes(2);
    expect(readProjectStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("applies a newer ServiceTitan status on open and leaves an older one", async () => {
    const id = await makeProject();
    await link(id, "505");
    await h.db.withTenant(t.id, (db) =>
      db.query(`UPDATE projects.projects SET stage_changed_at = '2026-10-20T00:00:00Z' WHERE id = $1`, [id]),
    );
    readProjectStatus.mockResolvedValue(
      status({
        statusId: ST_STATUS_FALLBACK.completed.id,
        statusName: "Completed",
        modifiedOn: "2026-10-01T00:00:00Z",
      }),
    );
    const older = await owner().get(`${base}/projects/${id}`);
    expect(older.body.data.stage).toBe("handoff");
    expect(updateProjectStatus).not.toHaveBeenCalled();

    readProjectStatus.mockResolvedValue(
      status({
        statusId: ST_STATUS_FALLBACK.completed.id,
        statusName: "Completed",
        modifiedOn: "2026-10-27T00:00:00Z",
      }),
    );
    const newer = await owner().get(`${base}/projects/${id}`);
    expect(newer.status, JSON.stringify(newer.body)).toBe(200);
    expect(newer.body.data.stage).toBe("complete");
    expect(newer.body.data.st_status.badge).toBeNull();
    expect(newer.body.data.st_status.gate_warning).toMatch(/outside the one-step/);
    const gates = await h.db.withTenant(t.id, (db) =>
      db.query<{ status: string }>(
        `SELECT status::text AS status FROM projects.stage_gates WHERE project_id = $1 AND gate_number = 0`,
        [id],
      ),
    );
    expect(gates.rows[0]!.status).toBe("open");
    expect(await auditWrites(id)).toMatchObject({ rows: [] });
    expect(updateProjectStatus).not.toHaveBeenCalled();
  });

  it("shows a Hold badge without moving the stage", async () => {
    const id = await makeProject();
    await link(id, "506");
    readProjectStatus.mockResolvedValue(
      status({ statusId: ST_STATUS_FALLBACK.hold.id, statusName: "Hold", modifiedOn: "2026-11-01T00:00:00Z" }),
    );
    const res = await owner().get(`${base}/projects/${id}`);
    expect(res.body.data.stage).toBe("handoff");
    expect(res.body.data.st_status.badge).toBe("Hold");
    expect(updateProjectStatus).not.toHaveBeenCalled();
  });

  it("can un-cancel from ServiceTitan without approving gates", async () => {
    const id = await makeProject();
    await link(id, "507");
    const cancel = await owner().post(`${base}/projects/${id}/stage`).send({ stage: "cancelled" });
    expect(cancel.status).toBe(200);
    updateProjectStatus.mockClear();
    readProjectStatus.mockResolvedValue(
      status({
        statusId: ST_STATUS_FALLBACK.pending.id,
        statusName: "Pending Scheduling",
        modifiedOn: "2099-01-01T00:00:00Z",
      }),
    );
    const res = await owner().get(`${base}/projects/${id}`);
    expect(res.body.data.stage).toBe("handoff");
    expect(res.body.data.st_status.gate_warning).toMatch(/from cancelled/);
    const gates = await h.db.withTenant(t.id, (db) =>
      db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.stage_gates WHERE project_id = $1 AND status = 'approved'`,
        [id],
      ),
    );
    expect(gates.rows[0]!.n).toBe("0");
    expect(updateProjectStatus).not.toHaveBeenCalled();
  });

  it("picks up a status when the project is refreshed", async () => {
    const id = await makeProject();
    readProjectDetails.mockResolvedValue({
      project: {
        id: "508",
        number: "P-508",
        name: "Refreshed",
        customerId: "300",
        locationId: "400",
        jobIds: [],
        status: "Completed",
        statusId: ST_STATUS_FALLBACK.completed.id,
        modifiedOn: "2026-10-27T15:00:00Z",
      },
      customer: { id: "300", name: "Ada" },
      location: {
        id: "400",
        customerId: "300",
        name: "Home",
        address: { street: "1 Main", city: "Richmond", state: "VA", zip: "23220" },
      },
      jobs: [],
      observedAt: "2026-10-27T15:00:01Z",
    });
    const res = await owner().post(`${base}/projects/${id}/servicetitan`).send({ external_project_id: "508" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const project = await owner().get(`${base}/projects/${id}`);
    expect(project.body.data.stage).toBe("complete");
    expect(project.body.data.st_status.gate_warning).toMatch(/Stage gates were not approved/);
    expect(updateProjectStatus).not.toHaveBeenCalled();
  });

  it("picks up status in the nightly run, including a direct sync of linked projects", async () => {
    const id = await makeProject();
    await link(id, "509");
    readProjectStatus.mockResolvedValue(
      status({
        statusId: ST_STATUS_FALLBACK.scheduled.id,
        statusName: "Scheduled",
        subStatusId: ST_SUBSTATUS_FALLBACK.orderMaterials.id,
        subStatusName: "Order Materials",
        modifiedOn: "2026-12-01T00:00:00Z",
      }),
    );
    const direct = await syncLinkedProjectStatuses(h.db, sources.serviceTitan!, t.id);
    expect(direct.failed).toBe(0);
    expect(direct.synced).toBeGreaterThan(0);
    const afterDirect = await h.db.withTenant(t.id, (db) =>
      db.query<{ stage: string }>(`SELECT stage::text AS stage FROM projects.projects WHERE id = $1`, [id]),
    );
    expect(afterDirect.rows[0]!.stage).toBe("mobilization");

    await h.db.withTenant(t.id, (db) =>
      db.query(
        `UPDATE projects.projects SET stage = 'handoff', stage_changed_at = '2020-01-01T00:00:00Z' WHERE id = $1`,
        [id],
      ),
    );
    readProjectStatus.mockResolvedValue(
      status({
        statusId: ST_STATUS_FALLBACK.inProgress.id,
        statusName: "In Progress",
        modifiedOn: "2026-12-02T00:00:00Z",
      }),
    );
    const nightly = await runHourlyLaborRefresh(h.db, sources.serviceTitan!, {
      tenantId: t.id,
      gapMs: 0,
      sleep: async () => {},
    });
    expect(nightly.skipped).toBeNull();
    const afterNight = await h.db.withTenant(t.id, (db) =>
      db.query<{ stage: string }>(`SELECT stage::text AS stage FROM projects.projects WHERE id = $1`, [id]),
    );
    expect(afterNight.rows[0]!.stage).toBe("execution");
    expect(updateProjectStatus).not.toHaveBeenCalled();
  });

  it("runs one write at a time for a project", async () => {
    const id = await makeProject();
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    updateProjectStatus.mockImplementation(async () => {
      started += 1;
      await gate;
      return status({ statusId: ST_STATUS_FALLBACK.pending.id, modifiedOn: "2026-10-27T00:00:00Z" });
    });
    const first = pushStageStatus(h.db, {
      tenantId: t.id,
      projectId: id,
      externalProjectId: "510",
      stage: "precon",
      fromStage: "handoff",
      actor: { type: "staff", id: t.staff.owner!.id, name: "Owner" },
      client: statusClientOf(sources.serviceTitan!.client)!,
      sleep: async () => {},
    });
    const second = pushStageStatus(h.db, {
      tenantId: t.id,
      projectId: id,
      externalProjectId: "510",
      stage: "precon",
      fromStage: "handoff",
      actor: { type: "staff", id: t.staff.owner!.id, name: "Owner" },
      client: statusClientOf(sources.serviceTitan!.client)!,
      sleep: async () => {},
    });
    await vi.waitFor(() => expect(started).toBe(1));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.result).toBe(b.result);
    expect(started).toBe(1);
  });

  it("keeps a Journeyman stage when ServiceTitan is older", async () => {
    const id = await makeProject();
    await h.db.withTenant(t.id, async (db) => {
      await applyInboundStatus(db, {
        tenantId: t.id,
        projectId: id,
        actor: { type: "system", id: null, name: "test" },
        snapshot: status({
          statusId: ST_STATUS_FALLBACK.completed.id,
          statusName: "Completed",
          modifiedOn: "2020-01-01T00:00:00Z",
        }),
        catalog: null,
      });
      await db.query(`UPDATE projects.projects SET stage_changed_at = '2026-10-01T00:00:00Z', stage = 'precon' WHERE id = $1`, [id]);
      const kept = await applyInboundStatus(db, {
        tenantId: t.id,
        projectId: id,
        actor: { type: "system", id: null },
        snapshot: status({
          statusId: ST_STATUS_FALLBACK.completed.id,
          statusName: "Completed",
          modifiedOn: "2026-09-01T00:00:00Z",
        }),
        catalog: null,
      });
      expect(kept?.changed).toBe(false);
      expect(kept?.stage).toBe("precon");
    });
  });

  it("exposes stage, ServiceTitan status, and scope names on the portfolio feed", async () => {
    const id = await makeProject();
    await h.db.withTenant(t.id, (db) =>
      db.query(
        `UPDATE projects.projects
            SET st_status_name = 'Pending Scheduling',
                st_substatus_name = 'Plans ordering',
                st_status_synced_at = '2026-10-27T18:00:00Z',
                st_status_write_result = 'ok'
          WHERE id = $1`,
        [id],
      ),
    );
    const app = supertest(
      createApp({
        database: h.db,
        staffSessions: new MemoryStaffSessions(),
        serveConsole: false,
        portfolio: { tenantId: t.id, token: TOKEN },
        sources,
      }),
    );
    const summary = await app.get("/api/v1/portfolio/summary").set("Authorization", `Bearer ${TOKEN}`);
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body.data.service_titan).toEqual({
      scopes: ["tn.jpm.jobs:r", PROJECTS_WRITE_SCOPE],
      hasProjectsWrite: true,
    });
    const listed = summary.body.data.projects.find((row: { id: string }) => row.id === id);
    expect(listed.stage).toBe("handoff");
    expect(listed.service_titan_status).toMatchObject({
      status: "Pending Scheduling",
      substatus: "Plans ordering",
      write_result: "ok",
    });
    expect(listed.service_titan_status.synced_at).toContain("2026-10-27");
    const projects = await app.get("/api/v1/portfolio/projects").set("Authorization", `Bearer ${TOKEN}`);
    expect(projects.status).toBe(200);
    expect(projects.body.data.service_titan.hasProjectsWrite).toBe(true);
    const body = JSON.stringify(projects.body) + JSON.stringify(summary.body);
    expect(body).not.toContain("secret");
    expect(body).not.toContain("access_token");
    expect(body).not.toMatch(/Bearer\s+\S+/);
  });
});
