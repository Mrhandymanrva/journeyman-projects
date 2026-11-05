import type { Database, SqlClient } from "../db/database.js";
import type { GateState, ProjectStage } from "./stages.js";
import {
  decideOutbound,
  gateWarningForInboundMove,
  inboundShouldApply,
  interpretInbound,
  isoTimestamp,
  resolveStatusIds,
  statusWriteMessage,
  type StProjectStatus,
  type StStatusCatalog,
} from "./stStatusMap.js";

/**
 * PM_ST_WRITES_ENABLED is not a global kill switch. sourceConnections copies
 * it onto serviceTitan.writesEnabled, and only schedule reschedule
 * (scheduleChanges.ts) and record publication (recordExports.ts) consult it.
 * The ServiceTitan adapter does not. Status sync does not consult it either:
 * the owner declined a feature flag, and this guard does not already govern
 * every Journeyman write to ServiceTitan.
 */

export interface StStatusClient {
  readProjectStatus(projectId: string): Promise<StProjectStatus>;
  readStatusCatalog?(): Promise<StStatusCatalog>;
  updateProjectStatus?(
    projectId: string,
    patch: { statusId: string; subStatusId: string | null },
  ): Promise<StProjectStatus>;
}

/** The connector stores these methods as optional. Callers need a client that has the read. */
export type StStatusClientSource = {
  readProjectStatus?: StStatusClient["readProjectStatus"];
  readStatusCatalog?: StStatusClient["readStatusCatalog"];
  updateProjectStatus?: StStatusClient["updateProjectStatus"];
};

export function statusClientOf(client: StStatusClientSource): StStatusClient | null {
  const readProjectStatus = client.readProjectStatus;
  if (!readProjectStatus) return null;
  const readStatusCatalog = client.readStatusCatalog;
  const updateProjectStatus = client.updateProjectStatus;
  return {
    readProjectStatus: (projectId) => readProjectStatus.call(client, projectId),
    readStatusCatalog: readStatusCatalog ? () => readStatusCatalog.call(client) : undefined,
    updateProjectStatus: updateProjectStatus
      ? (projectId, patch) => updateProjectStatus.call(client, projectId, patch)
      : undefined,
  };
}

export interface StatusActor {
  type: "staff" | "system";
  id: string | null;
  name?: string | null;
}

export interface StatusSyncResult {
  ok: boolean;
  result: "ok" | "skipped" | "rejected" | "failed";
  http_status: number | null;
  message: string;
}

export interface InboundApplyResult {
  stage: ProjectStage;
  changed: boolean;
  badge: "Hold" | "Bid" | null;
  gate_warning: string | null;
}

const flights = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = flights.get(key);
  if (existing) return existing as Promise<T>;
  const promise = run().finally(() => {
    if (flights.get(key) === promise) flights.delete(key);
  });
  flights.set(key, promise);
  return promise;
}

function flightKey(tenantId: string, projectId: string): string {
  return `st-status:${tenantId}:${projectId}`;
}

function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : "ServiceTitan status sync failed.";
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 300);
}

function failureOf(err: unknown): { httpStatus: number | null; retryable: boolean } {
  if (err && typeof err === "object") {
    const record = err as { httpStatus?: unknown; retryable?: unknown };
    if ("httpStatus" in record || "retryable" in record) {
      const httpStatus =
        typeof record.httpStatus === "number" || record.httpStatus === null
          ? record.httpStatus
          : null;
      return { httpStatus, retryable: record.retryable === true };
    }
  }
  const message = err instanceof Error ? err.message : "";
  return {
    httpStatus: null,
    retryable: /timeout|aborted|network|ECONN|fetch failed|HTTP 5\d\d/i.test(message),
  };
}

function backoffMs(attempt: number): number {
  return attempt <= 1 ? 200 : 800 * (attempt - 1);
}

async function loadCatalog(client: StStatusClient): Promise<StStatusCatalog | null> {
  if (!client.readStatusCatalog) return null;
  try {
    return await client.readStatusCatalog();
  } catch (err) {
    console.error(`ServiceTitan status catalog was not read. ${safeError(err)}`);
    return null;
  }
}

export async function applyInboundStatus(
  db: SqlClient,
  input: {
    tenantId: string;
    projectId: string;
    actor: StatusActor;
    snapshot: StProjectStatus;
    catalog: StStatusCatalog | null;
    now?: Date;
  },
): Promise<InboundApplyResult | null> {
  const project = (
    await db.query<{ stage: ProjectStage; stage_changed_at: Date | string | null }>(
      `SELECT stage::text AS stage, stage_changed_at
         FROM projects.projects
        WHERE id = $1
        FOR UPDATE`,
      [input.projectId],
    )
  ).rows[0];
  if (!project) return null;

  const resolved = resolveStatusIds(input.catalog);
  const opinion = interpretInbound(project.stage, input.snapshot, resolved);
  const now = input.now ?? new Date();
  const blank = !input.snapshot.statusId && !input.snapshot.statusName?.trim();

  let nextStage = project.stage;
  let changed = false;
  let warning: string | null | undefined;
  if (
    !blank &&
    opinion.kind === "stage" &&
    opinion.stage !== project.stage &&
    inboundShouldApply(input.snapshot.modifiedOn, project.stage_changed_at)
  ) {
    const gates = await db.query<GateState>(
      `SELECT gate_number, title, status::text AS status
         FROM projects.stage_gates
        WHERE project_id = $1
        ORDER BY gate_number`,
      [input.projectId],
    );
    warning = gateWarningForInboundMove(project.stage, opinion.stage, gates.rows);
    const changedAt = isoTimestamp(input.snapshot.modifiedOn) ?? now.toISOString();
    await db.query(
      `UPDATE projects.projects
          SET stage = $2::projects.project_stage,
              stage_changed_at = $3::timestamptz,
              st_status_gate_warning = $4
        WHERE id = $1`,
      [input.projectId, opinion.stage, changedAt, warning],
    );
    nextStage = opinion.stage;
    changed = true;
    await db.query(
      `INSERT INTO projects.audit_log
         (tenant_id, actor_type, actor_id, entity_table, entity_id, action, before_data, after_data)
       VALUES ($1, $2, $3, 'projects', $4, 'st_status_inbound', $5::jsonb, $6::jsonb)`,
      [
        input.tenantId,
        input.actor.type,
        input.actor.id,
        input.projectId,
        JSON.stringify({ stage: project.stage }),
        JSON.stringify({
          who: input.actor,
          from_stage: project.stage,
          to_stage: opinion.stage,
          st_before: input.snapshot,
          result: "inbound",
          gate_warning: warning,
          occurred_at: now.toISOString(),
        }),
      ],
    );
  }

  if (blank) {
    await db.query(
      `UPDATE projects.projects
          SET st_status_id = NULL,
              st_substatus_id = NULL,
              st_status_name = NULL,
              st_substatus_name = NULL,
              st_status_modified_on = NULL,
              st_status_synced_at = $2
        WHERE id = $1`,
      [input.projectId, now.toISOString()],
    );
  } else {
    await db.query(
      `UPDATE projects.projects
          SET st_status_id = $2,
              st_substatus_id = $3,
              st_status_name = $4,
              st_substatus_name = $5,
              st_status_modified_on = $6,
              st_status_synced_at = $7,
              source_project_status = COALESCE($4, source_project_status)
        WHERE id = $1`,
      [
        input.projectId,
        input.snapshot.statusId,
        input.snapshot.subStatusId,
        input.snapshot.statusName,
        input.snapshot.subStatusName,
        isoTimestamp(input.snapshot.modifiedOn),
        now.toISOString(),
      ],
    );
  }

  const storedWarning = (
    await db.query<{ st_status_gate_warning: string | null }>(
      `SELECT st_status_gate_warning FROM projects.projects WHERE id = $1`,
      [input.projectId],
    )
  ).rows[0]?.st_status_gate_warning ?? null;

  return {
    stage: nextStage,
    changed,
    badge: opinion.kind === "badge" ? opinion.badge : null,
    gate_warning: warning === undefined ? storedWarning : warning,
  };
}

export async function pullProjectStatus(
  db: Database,
  input: {
    tenantId: string;
    projectId: string;
    externalProjectId: string;
    actor: StatusActor;
    client: StStatusClient;
    now?: Date;
  },
): Promise<InboundApplyResult | null> {
  return singleFlight(flightKey(input.tenantId, input.projectId), async () => {
    const snapshot = await input.client.readProjectStatus(input.externalProjectId);
    const catalog = await loadCatalog(input.client);
    return db.withTenant(input.tenantId, (sql) =>
      applyInboundStatus(sql, {
        tenantId: input.tenantId,
        projectId: input.projectId,
        actor: input.actor,
        snapshot,
        catalog,
        now: input.now,
      }),
    );
  });
}

/**
 * Writes the Journeyman stage to ServiceTitan. Inbound pulls never call this.
 * A matching status is not patched. Timeout and HTTP 5xx are retried after a
 * fresh read. HTTP 4xx, including 403, is returned to the caller and not retried.
 */
export async function pushStageStatus(
  db: Database,
  input: {
    tenantId: string;
    projectId: string;
    externalProjectId: string;
    stage: ProjectStage;
    fromStage: ProjectStage;
    actor: StatusActor;
    client: StStatusClient;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
  },
): Promise<StatusSyncResult> {
  return singleFlight(flightKey(input.tenantId, input.projectId), () => pushOnce(db, input));
}

async function pushOnce(
  db: Database,
  input: {
    tenantId: string;
    projectId: string;
    externalProjectId: string;
    stage: ProjectStage;
    fromStage: ProjectStage;
    actor: StatusActor;
    client: StStatusClient;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
  },
): Promise<StatusSyncResult> {
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? (() => new Date());
  const started = now();
  const update = input.client.updateProjectStatus?.bind(input.client);
  if (!update) {
    return {
      ok: false,
      result: "failed",
      http_status: null,
      message: "ServiceTitan project status updates are not available on this connection.",
    };
  }

  let lastCurrent: StProjectStatus | null = null;
  let lastAfter: StProjectStatus | null = null;
  let result: StatusSyncResult = {
    ok: false,
    result: "failed",
    http_status: null,
    message: statusWriteMessage(null, true),
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let current: StProjectStatus;
    try {
      current = await input.client.readProjectStatus(input.externalProjectId);
    } catch (err) {
      const failure = failureOf(err);
      result = {
        ok: false,
        result: failure.retryable ? "failed" : "rejected",
        http_status: failure.httpStatus,
        message: failure.retryable
          ? statusWriteMessage(failure.httpStatus, true)
          : statusWriteMessage(failure.httpStatus, false),
      };
      if (!failure.retryable || attempt === 3) break;
      await sleep(backoffMs(attempt));
      continue;
    }
    lastCurrent = current;
    const catalog = await loadCatalog(input.client);
    const decision = decideOutbound(input.stage, current, resolveStatusIds(catalog));
    if (decision.action === "skip") {
      lastAfter = current;
      result = {
        ok: true,
        result: "skipped",
        http_status: null,
        message: "ServiceTitan already had this status.",
      };
      break;
    }
    try {
      lastAfter = await update(input.externalProjectId, {
        statusId: decision.statusId,
        subStatusId: decision.subStatusId,
      });
      result = {
        ok: true,
        result: "ok",
        http_status: null,
        message: "ServiceTitan project status was updated.",
      };
      break;
    } catch (err) {
      const failure = failureOf(err);
      result = {
        ok: false,
        result: failure.retryable ? "failed" : "rejected",
        http_status: failure.httpStatus,
        message: statusWriteMessage(failure.httpStatus, failure.retryable),
      };
      if (!failure.retryable || attempt === 3) break;
      await sleep(backoffMs(attempt));
    }
  }

  const finished = now();
  const observed = lastAfter ?? lastCurrent;
  try {
    await db.withTenant(input.tenantId, async (sql) => {
      await sql.query(
        `UPDATE projects.projects
            SET st_status_id = $2,
                st_substatus_id = $3,
                st_status_name = $4,
                st_substatus_name = $5,
                st_status_modified_on = $6,
                st_status_synced_at = $7,
                st_status_write_result = $8,
                st_status_write_detail = $9,
                source_project_status = COALESCE($4, source_project_status)
          WHERE id = $1`,
        [
          input.projectId,
          observed?.statusId ?? null,
          observed?.subStatusId ?? null,
          observed?.statusName ?? null,
          observed?.subStatusName ?? null,
          isoTimestamp(observed?.modifiedOn),
          finished.toISOString(),
          result.result,
          result.message,
        ],
      );
      await sql.query(
        `INSERT INTO projects.audit_log
           (tenant_id, actor_type, actor_id, entity_table, entity_id, action, before_data, after_data)
         VALUES ($1, $2, $3, 'projects', $4, 'st_status_write', $5::jsonb, $6::jsonb)`,
        [
          input.tenantId,
          input.actor.type,
          input.actor.id,
          input.projectId,
          JSON.stringify({ stage: input.fromStage, service_titan: lastCurrent }),
          JSON.stringify({
            who: input.actor,
            from_stage: input.fromStage,
            to_stage: input.stage,
            st_before: lastCurrent,
            st_after: lastAfter,
            result: result.result,
            http_status: result.http_status,
            message: result.message,
            started_at: started.toISOString(),
            finished_at: finished.toISOString(),
          }),
        ],
      );
    });
  } catch (err) {
    console.error(`ServiceTitan status audit was not saved. ${safeError(err)}`);
  }
  return result;
}

export async function syncLinkedProjectStatuses(
  db: Database,
  connection: {
    externalSystemId: string;
    client: StStatusClientSource;
  },
  tenantId: string,
): Promise<{ synced: number; failed: number }> {
  const client = statusClientOf(connection.client);
  if (!client) return { synced: 0, failed: 0 };
  const links = await db.withTenant(tenantId, (sql) =>
    sql.query<{ id: string; external_project_id: string }>(
      `SELECT p.id::text AS id, c.external_project_id
         FROM projects.st_project_connections c
         JOIN projects.projects p ON p.id = c.project_id
        WHERE c.external_system_id = $1
        ORDER BY p.project_number`,
      [connection.externalSystemId],
    ),
  );
  let synced = 0;
  let failed = 0;
  for (const link of links.rows) {
    try {
      await pullProjectStatus(db, {
        tenantId,
        projectId: link.id,
        externalProjectId: link.external_project_id,
        actor: { type: "system", id: null, name: "nightly" },
        client,
      });
      synced += 1;
    } catch (err) {
      failed += 1;
      console.error(`ServiceTitan status sync failed for project ${link.id}. ${safeError(err)}`);
    }
  }
  return { synced, failed };
}
