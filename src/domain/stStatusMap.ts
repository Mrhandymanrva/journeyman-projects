import {
  gatesBlocking,
  nextStage,
  STAGE_ORDER,
  type GateState,
  type ProjectStage,
} from "./stages.js";

/**
 * Live ServiceTitan ids for the production account. Names are resolved at
 * runtime when the status catalog can be read. These ids are the fallback
 * when a name is missing from that catalog.
 */
export const ST_STATUS_FALLBACK = {
  bid: { name: "Bid", id: "257701778" },
  pending: { name: "Pending Scheduling", id: "221978471" },
  scheduled: { name: "Scheduled", id: "221978472" },
  inProgress: { name: "In Progress", id: "221978473" },
  completed: { name: "Completed", id: "221978474" },
  hold: { name: "Hold", id: "221978475" },
  canceled: { name: "Canceled", id: "221978476" },
} as const;

export const ST_SUBSTATUS_FALLBACK = {
  plansOrdering: { name: "Plans ordering", id: "291302447", parent: "pending" },
  permitSubmitted: { name: "Permit submitted", id: "291302448", parent: "pending" },
  permitReceived: { name: "Permit received", id: "291302449", parent: "pending" },
  orderMaterials: { name: "Order Materials", id: "246882139", parent: "scheduled" },
  materialsOrdered: { name: "Materials ordered", id: "291304733", parent: "scheduled" },
  jobsScheduled: { name: "Jobs Scheduled", id: "292547985", parent: "scheduled" },
} as const;

const PRECON_SUBS = new Set(["plansOrdering", "permitSubmitted", "permitReceived"]);

export const PROJECTS_WRITE_SCOPE = "tn.jpm.projects:w";

export interface StProjectStatus {
  statusId: string | null;
  statusName: string | null;
  subStatusId: string | null;
  subStatusName: string | null;
  modifiedOn: string | null;
}

export interface StNamedStatus {
  id: string;
  name: string;
  statusId?: string | null;
}

export interface StStatusCatalog {
  statuses: StNamedStatus[];
  substatuses: StNamedStatus[];
}

type StatusKey = keyof typeof ST_STATUS_FALLBACK;
type SubKey = keyof typeof ST_SUBSTATUS_FALLBACK;

export interface ResolvedCatalog {
  statusId: Record<StatusKey, string>;
  subId: Record<SubKey, string>;
  statusKeyById: Map<string, StatusKey>;
  subKeyById: Map<string, SubKey>;
  statusKeyByName: Map<string, StatusKey>;
  subKeyByName: Map<string, SubKey>;
}

export type OutboundDecision =
  | { action: "skip"; reason: "preserve-substatus" | "already-matches" }
  | { action: "patch"; statusId: string; subStatusId: string | null };

export type InboundOpinion =
  | { kind: "none" }
  | { kind: "badge"; badge: "Hold" | "Bid" }
  | { kind: "stage"; stage: ProjectStage };

export interface ServiceTitanAccess {
  scopes: string[];
  hasProjectsWrite: boolean;
}

export function normalizeStatusName(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return base === "cancelled" ? "canceled" : base;
}

export function resolveStatusIds(catalog: StStatusCatalog | null | undefined): ResolvedCatalog {
  const statusId = {} as Record<StatusKey, string>;
  const subId = {} as Record<SubKey, string>;
  const statusKeyById = new Map<string, StatusKey>();
  const subKeyById = new Map<string, SubKey>();
  const statusKeyByName = new Map<string, StatusKey>();
  const subKeyByName = new Map<string, SubKey>();

  const statusRows = catalog?.statuses ?? [];
  const subRows = catalog?.substatuses ?? [];

  (Object.keys(ST_STATUS_FALLBACK) as StatusKey[]).forEach((key) => {
    const fallback = ST_STATUS_FALLBACK[key];
    const found = statusRows.find((row) => normalizeStatusName(row.name) === normalizeStatusName(fallback.name));
    const id = found?.id ?? fallback.id;
    statusId[key] = id;
    statusKeyById.set(id, key);
    statusKeyByName.set(normalizeStatusName(fallback.name), key);
    if (found) statusKeyByName.set(normalizeStatusName(found.name), key);
  });

  (Object.keys(ST_SUBSTATUS_FALLBACK) as SubKey[]).forEach((key) => {
    const fallback = ST_SUBSTATUS_FALLBACK[key];
    const found = subRows.find((row) => normalizeStatusName(row.name) === normalizeStatusName(fallback.name));
    const id = found?.id ?? fallback.id;
    subId[key] = id;
    subKeyById.set(id, key);
    subKeyByName.set(normalizeStatusName(fallback.name), key);
    if (found) subKeyByName.set(normalizeStatusName(found.name), key);
  });

  return { statusId, subId, statusKeyById, subKeyById, statusKeyByName, subKeyByName };
}

export function statusKeyOf(snapshot: StProjectStatus, resolved: ResolvedCatalog): StatusKey | null {
  if (snapshot.statusId && resolved.statusKeyById.has(snapshot.statusId)) {
    return resolved.statusKeyById.get(snapshot.statusId) ?? null;
  }
  if (snapshot.statusName) {
    return resolved.statusKeyByName.get(normalizeStatusName(snapshot.statusName)) ?? null;
  }
  return null;
}

export function subKeyOf(snapshot: StProjectStatus, resolved: ResolvedCatalog): SubKey | null {
  if (snapshot.subStatusId && resolved.subKeyById.has(snapshot.subStatusId)) {
    return resolved.subKeyById.get(snapshot.subStatusId) ?? null;
  }
  if (snapshot.subStatusName) {
    return resolved.subKeyByName.get(normalizeStatusName(snapshot.subStatusName)) ?? null;
  }
  return null;
}

function stageForStatus(key: StatusKey): ProjectStage[] {
  switch (key) {
    case "pending":
      return ["handoff"];
    case "scheduled":
      return ["mobilization"];
    case "inProgress":
      return ["execution", "closeout"];
    case "completed":
      return ["complete"];
    case "canceled":
      return ["cancelled"];
    default:
      return [];
  }
}

/**
 * What an observed ServiceTitan status means for Journeyman.
 * A project with no status is no opinion. Hold and Bid never move the stage.
 * In Progress keeps closeout when Journeyman is already there.
 */
export function interpretInbound(
  currentStage: ProjectStage,
  snapshot: StProjectStatus,
  resolved: ResolvedCatalog,
): InboundOpinion {
  const key = statusKeyOf(snapshot, resolved);
  if (!key) return { kind: "none" };
  if (key === "hold") return { kind: "badge", badge: "Hold" };
  if (key === "bid") return { kind: "badge", badge: "Bid" };
  if (key === "pending") {
    const sub = subKeyOf(snapshot, resolved);
    const stages: ProjectStage[] = sub && PRECON_SUBS.has(sub) ? ["precon"] : ["handoff"];
    return { kind: "stage", stage: pickStage(currentStage, stages) };
  }
  const stages = stageForStatus(key);
  if (!stages.length) return { kind: "none" };
  return { kind: "stage", stage: pickStage(currentStage, stages) };
}

function pickStage(current: ProjectStage, options: ProjectStage[]): ProjectStage {
  if (options.includes(current)) return current;
  const ordered = STAGE_ORDER.filter((stage) => options.includes(stage));
  if (ordered.length) return ordered[0]!;
  return options[0]!;
}

/**
 * The ServiceTitan write for a Journeyman stage.
 * A finer sub-status is left alone when the main status already matches.
 * Preconstruction keeps Plans ordering / Permit submitted / Permit received,
 * and otherwise sets Plans ordering. Hold and Bid are never targets.
 */
export function decideOutbound(
  stage: ProjectStage,
  current: StProjectStatus,
  resolved: ResolvedCatalog,
): OutboundDecision {
  const currentKey = statusKeyOf(current, resolved);
  const currentSub = subKeyOf(current, resolved);

  if (stage === "precon") {
    if (currentKey === "pending" && currentSub && PRECON_SUBS.has(currentSub)) {
      return { action: "skip", reason: "preserve-substatus" };
    }
    return {
      action: "patch",
      statusId: resolved.statusId.pending,
      subStatusId: resolved.subId.plansOrdering,
    };
  }

  const target = targetKey(stage);
  if (currentKey === target) {
    return {
      action: "skip",
      reason: currentSub ? "preserve-substatus" : "already-matches",
    };
  }
  return { action: "patch", statusId: resolved.statusId[target], subStatusId: null };
}

function targetKey(stage: ProjectStage): StatusKey {
  switch (stage) {
    case "handoff":
      return "pending";
    case "precon":
      return "pending";
    case "mobilization":
      return "scheduled";
    case "execution":
    case "closeout":
      return "inProgress";
    case "complete":
      return "completed";
    case "cancelled":
      return "canceled";
  }
}

export function holdOrBidIds(resolved: ResolvedCatalog): string[] {
  return [resolved.statusId.hold, resolved.statusId.bid];
}

/**
 * True when the ServiceTitan edit is newer than Journeyman's last stage change.
 * No modifiedOn cannot override a recorded Journeyman change. A project with
 * no stage_changed_at has not recorded one, so ServiceTitan may set the stage.
 */
export function inboundShouldApply(
  modifiedOn: string | null,
  stageChangedAt: Date | string | null | undefined,
): boolean {
  if (stageChangedAt == null || stageChangedAt === "") return true;
  if (!modifiedOn) return false;
  const remote = Date.parse(modifiedOn);
  const local = stageChangedAt instanceof Date ? stageChangedAt.getTime() : Date.parse(String(stageChangedAt));
  if (!Number.isFinite(remote) || !Number.isFinite(local)) return false;
  return remote > local;
}

export function gateWarningForInboundMove(
  from: ProjectStage,
  to: ProjectStage,
  gates: GateState[],
): string | null {
  if (from === to || to === "cancelled") return null;
  if (from === "cancelled") {
    return `ServiceTitan moved this project from cancelled to ${label(to)}. Stage gates were not approved.`;
  }
  if (to !== nextStage(from)) {
    return `ServiceTitan moved this project from ${label(from)} to ${label(to)}, outside the one-step stage sequence. Stage gates were not approved.`;
  }
  const blocking = gatesBlocking(from, gates);
  const gate = blocking[0];
  if (gate) {
    return `ServiceTitan moved this project to ${label(to)} while gate ${gate.gate_number} (${gate.title}) is ${gate.status}. The gate was not approved.`;
  }
  return null;
}

function label(stage: ProjectStage): string {
  return stage;
}

export function badgeForStoredStatus(
  statusId: string | null,
  statusName: string | null,
): "Hold" | "Bid" | null {
  const opinion = interpretInbound(
    "handoff",
    {
      statusId,
      statusName,
      subStatusId: null,
      subStatusName: null,
      modifiedOn: null,
    },
    resolveStatusIds(null),
  );
  return opinion.kind === "badge" ? opinion.badge : null;
}

export function isoTimestamp(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

export interface StoredStatusView {
  status_id: string | null;
  status: string | null;
  substatus_id: string | null;
  substatus: string | null;
  synced_at: string | null;
  modified_on: string | null;
  write_result: string | null;
  write_detail: string | null;
  badge: "Hold" | "Bid" | null;
  gate_warning: string | null;
}

export function presentStoredStatus(row: Record<string, unknown>): StoredStatusView | null {
  if (!("st_status_id" in row) && !("st_status_name" in row)) return null;
  const statusId = textOrNull(row.st_status_id);
  const statusName = textOrNull(row.st_status_name);
  return {
    status_id: statusId,
    status: statusName,
    substatus_id: textOrNull(row.st_substatus_id),
    substatus: textOrNull(row.st_substatus_name),
    synced_at: isoTimestamp(row.st_status_synced_at),
    modified_on: isoTimestamp(row.st_status_modified_on),
    write_result: textOrNull(row.st_status_write_result),
    write_detail: textOrNull(row.st_status_write_detail),
    badge: badgeForStoredStatus(statusId, statusName),
    gate_warning: textOrNull(row.st_status_gate_warning),
  };
}

export function presentFeedStatus(row: {
  st_status_name?: unknown;
  st_substatus_name?: unknown;
  st_status_synced_at?: unknown;
  st_status_write_result?: unknown;
  st_status_write_detail?: unknown;
}): {
  status: string | null;
  substatus: string | null;
  synced_at: string | null;
  write_result: string | null;
} {
  return {
    status: textOrNull(row.st_status_name),
    substatus: textOrNull(row.st_substatus_name),
    synced_at: isoTimestamp(row.st_status_synced_at),
    write_result: textOrNull(row.st_status_write_result),
  };
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function statusWriteMessage(httpStatus: number | null, retryable: boolean): string {
  if (httpStatus === 403) {
    return "ServiceTitan refused the project status update (HTTP 403). The ServiceTitan app is missing the projects write scope (tn.jpm.projects:w). The stage was saved in Journeyman. ServiceTitan was not changed.";
  }
  if (httpStatus != null && httpStatus >= 400 && httpStatus < 500) {
    return `ServiceTitan refused the project status update (HTTP ${httpStatus}). The stage was saved in Journeyman. ServiceTitan was not changed.`;
  }
  const status = httpStatus == null ? "" : ` (HTTP ${httpStatus})`;
  if (retryable) {
    return `ServiceTitan did not confirm the project status update${status}. The stage was saved in Journeyman. The update was retried and still failed.`;
  }
  return "ServiceTitan did not confirm the project status update. The stage was saved in Journeyman.";
}

export function scopeNamesFromAuthBody(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const token = typeof record.access_token === "string" ? record.access_token : "";
  const direct = normalizeScopeValue(record.scope);
  const names = direct.length ? direct : normalizeScopeValue(token ? jwtScopeClaim(token) : undefined);
  return sanitizeScopeNames(names, token);
}

export async function readServiceTitanAccess(
  client:
    | { grantedScopes?: () => Promise<{ scopes: readonly string[]; hasProjectsWrite?: boolean }> }
    | null
    | undefined,
): Promise<ServiceTitanAccess> {
  if (!client?.grantedScopes) return { scopes: [], hasProjectsWrite: false };
  try {
    const got = await client.grantedScopes();
    const scopes = sanitizeScopeNames(got.scopes, "");
    return { scopes, hasProjectsWrite: scopes.includes(PROJECTS_WRITE_SCOPE) };
  } catch {
    return { scopes: [], hasProjectsWrite: false };
  }
}

function normalizeScopeValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") return value.split(/[\s,]+/);
  return [];
}

function jwtScopeClaim(token: string): unknown {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object") return undefined;
    return (payload as Record<string, unknown>).scope;
  } catch {
    return undefined;
  }
}

function sanitizeScopeNames(values: readonly string[], token: string): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const name = value.trim();
    if (!name || name === token) continue;
    if (name.length > 120 || name.split(".").length > 4) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name)) continue;
    out.add(name);
  }
  return [...out].sort();
}

export function statusSnapshotFromProject(project: {
  status?: string | null;
  statusId?: string | null;
  subStatus?: string | null;
  subStatusId?: string | null;
  modifiedOn?: string | null;
}): StProjectStatus {
  return {
    statusId: project.statusId ?? null,
    statusName: project.status ?? null,
    subStatusId: project.subStatusId ?? null,
    subStatusName: project.subStatus ?? null,
    modifiedOn: project.modifiedOn ?? null,
  };
}
