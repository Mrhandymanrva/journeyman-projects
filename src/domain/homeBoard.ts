import type { SqlClient } from "../db/database.js";
import { ApiError } from "../http/errors.js";
import {
  itemFromActivity,
  itemFromMilestone,
  itemFromPermit,
  itemFromPrecon,
  itemFromWbs,
  summarizeSchedule,
} from "../../client/scheduleDefinition.js";
import {
  feedHealth,
  loadProjectHealth,
  type HealthScore,
} from "./projectHealth.js";
import { STAGE_ORDER, type ProjectStage } from "./stages.js";

/**
 * Home is the list of projects a staff member can already open, plus the
 * work due today or overdue.
 *
 * Due today uses summarizeSchedule() from client/scheduleDefinition.js, the
 * same function as the project dashboard. The schedule is Gantt activities,
 * ServiceTitan appointments when a caller supplies them, precon tasks, WBS
 * tasks, and milestones. Home reads Gantt activities from schedule_items.
 * Appointments are a live ServiceTitan read, so this list does not call
 * ServiceTitan; the dashboard passes that read into the same function.
 *
 * A plan milestone is done when every linked task is done, or when it has
 * no linked tasks and its manual status is complete.
 */

export const HOME_STATUSES = ["open", "completed", "cancelled", "all"] as const;
export type HomeStatus = (typeof HOME_STATUSES)[number];

export const HOME_STAGES: ProjectStage[] = [...STAGE_ORDER, "cancelled"];

export type DueItemType =
  | "wbs_task"
  | "precon_task"
  | "milestone"
  | "permit_milestone"
  | "activity"
  | "appointment";

export interface HomeFilters {
  status: HomeStatus;
  stage: ProjectStage | null;
  pmId: string | null;
  q: string | null;
}

export interface HomeMilestone {
  title: string;
  due_on: string;
  item_type: "milestone" | "permit_milestone";
}

export interface HomeProject {
  id: string;
  project_number: string;
  name: string;
  customer: string | null;
  stage: string;
  lifecycle: "open" | "completed" | "cancelled";
  pm_id: string | null;
  pm_name: string | null;
  health: HealthScore;
  next_milestone: HomeMilestone | null;
}

export interface HomeFacets {
  stages: string[];
  project_managers: Array<{ id: string; name: string }>;
}

export interface HomeBoard {
  today: string;
  status: HomeStatus;
  projects: HomeProject[];
  facets: HomeFacets;
}

export interface DueItem {
  project_id: string;
  project_number: string;
  project_name: string;
  item_type: DueItemType;
  item_id: string;
  title: string;
  due_on: string;
  overdue: boolean;
  owner_name: string | null;
  owner_role: string | null;
  href: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Open when milestone credit is not 1. Matches milestoneCredit():
 * every linked task done, or no linked tasks and manual state complete.
 */
const MILESTONE_NOT_DONE = `
  m.kind = 'milestone'
  AND m.active
  AND COALESCE(m.data->>'due_on', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND NOT (
    (
      EXISTS (
        SELECT 1 FROM projects.project_controls t
         WHERE t.project_id = m.project_id
           AND t.kind = 'task'
           AND t.active
           AND t.data->>'milestone_id' = m.id::text
      )
      AND NOT EXISTS (
        SELECT 1 FROM projects.project_controls t
         WHERE t.project_id = m.project_id
           AND t.kind = 'task'
           AND t.active
           AND t.data->>'milestone_id' = m.id::text
           AND COALESCE(t.data->>'state', '') <> 'complete'
      )
    )
    OR (
      NOT EXISTS (
        SELECT 1 FROM projects.project_controls t
         WHERE t.project_id = m.project_id
           AND t.kind = 'task'
           AND t.active
           AND t.data->>'milestone_id' = m.id::text
      )
      AND COALESCE(m.data->>'state', '') = 'complete'
    )
  )
`;

export function projectLifecycle(
  stage: string,
): "open" | "completed" | "cancelled" {
  if (stage === "complete") return "completed";
  if (stage === "cancelled") return "cancelled";
  return "open";
}

export function dueItemHref(
  projectId: string,
  itemType: DueItemType,
  itemId: string,
): string {
  const project = encodeURIComponent(projectId);
  const item = encodeURIComponent(itemId);
  if (itemType === "wbs_task")
    return `/?project=${project}&plan=tasks&item=${item}#plan`;
  if (itemType === "milestone")
    return `/?project=${project}&plan=roadmap&item=${item}#plan`;
  if (itemType === "activity" || itemType === "appointment")
    return `/?project=${project}&plan=gantt&item=${item}#plan`;
  return `/?project=${project}&item=${item}#precon-permits`;
}

export function parseHomeFilters(query: Record<string, unknown>): HomeFilters {
  const statusRaw = stringQuery(query.status);
  const status = (statusRaw === "" ? "open" : statusRaw) as HomeStatus;
  if (!HOME_STATUSES.includes(status)) {
    throw new ApiError(
      "validation_failed",
      "status must be open, completed, cancelled, or all.",
    );
  }
  const stageRaw = stringQuery(query.stage);
  let stage: ProjectStage | null = null;
  if (stageRaw) {
    if (!HOME_STAGES.includes(stageRaw as ProjectStage)) {
      throw new ApiError("validation_failed", "stage is not a project stage.");
    }
    stage = stageRaw as ProjectStage;
  }
  const pmRaw = stringQuery(query.pm_id);
  if (pmRaw && !UUID.test(pmRaw)) {
    throw new ApiError("validation_failed", "pm_id must be a staff id.");
  }
  const qRaw = stringQuery(query.q);
  return {
    status,
    stage,
    pmId: pmRaw || null,
    q: qRaw || null,
  };
}

function stringQuery(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function visibleSql(alias: string): string {
  return `($${1}::uuid IS NULL OR ${alias}.business_unit_id IS NULL OR ${alias}.business_unit_id = $1::uuid)`;
}

export async function loadHomeBoard(
  db: SqlClient,
  scope: string | null,
  filters: HomeFilters,
  today: string,
): Promise<HomeBoard> {
  const [projects, facets, healthRows, nextMilestones] = await Promise.all([
    db.query<{
      id: string;
      project_number: string;
      name: string;
      customer: string | null;
      stage: string;
      pm_id: string | null;
      pm_name: string | null;
    }>(
      `SELECT p.id, p.project_number, p.name,
              NULLIF(btrim(p.source_customer_name), '') AS customer,
              p.stage::text AS stage, p.pm_id::text AS pm_id, s.full_name AS pm_name
         FROM projects.projects p
         LEFT JOIN projects.staff s ON s.id = p.pm_id
        WHERE ${visibleSql("p")}
          AND (
            $2::text = 'all'
            OR ($2::text = 'completed' AND p.stage = 'complete')
            OR ($2::text = 'cancelled' AND p.stage = 'cancelled')
            OR ($2::text = 'open' AND p.stage NOT IN ('complete', 'cancelled'))
          )
          AND ($3::text IS NULL OR p.stage = $3::projects.project_stage)
          AND ($4::uuid IS NULL OR p.pm_id = $4::uuid)
          AND (
            $5::text IS NULL
            OR p.name ILIKE '%' || $5 || '%'
            OR p.project_number ILIKE '%' || $5 || '%'
            OR COALESCE(p.source_customer_name, '') ILIKE '%' || $5 || '%'
          )
        ORDER BY p.project_number, p.name`,
      [scope, filters.status, filters.stage, filters.pmId, filters.q],
    ),
    db.query<{ stage: string; pm_id: string | null; pm_name: string | null }>(
      `SELECT p.stage::text AS stage, p.pm_id::text AS pm_id, s.full_name AS pm_name
         FROM projects.projects p
         LEFT JOIN projects.staff s ON s.id = p.pm_id
        WHERE ${visibleSql("p")}`,
      [scope],
    ),
    loadProjectHealth(db, today),
    db.query<{
      project_id: string;
      title: string;
      due_on: string;
      item_type: "milestone" | "permit_milestone";
    }>(
      `SELECT DISTINCT ON (project_id)
              project_id, title, due_on, item_type
         FROM (
           SELECT m.project_id,
                  COALESCE(NULLIF(btrim(m.data->>'title'), ''), 'Milestone') AS title,
                  m.data->>'due_on' AS due_on,
                  'milestone'::text AS item_type
             FROM projects.project_controls m
             JOIN projects.projects p ON p.id = m.project_id
            WHERE ${visibleSql("p")}
              AND ${MILESTONE_NOT_DONE}
           UNION ALL
           SELECT pr.project_id,
                  pm.name AS title,
                  pm.due_on::text AS due_on,
                  'permit_milestone'::text AS item_type
             FROM projects.permit_milestones pm
             JOIN projects.permits pr ON pr.id = pm.permit_id
             JOIN projects.projects p ON p.id = pr.project_id
            WHERE ${visibleSql("p")}
              AND pm.status IN ('pending', 'in_progress')
              AND pm.due_on IS NOT NULL
         ) candidates
        ORDER BY project_id, due_on ASC, title ASC`,
      [scope],
    ),
  ]);

  const milestones = new Map<string, HomeMilestone>();
  for (const row of nextMilestones.rows) {
    milestones.set(row.project_id, {
      title: row.title,
      due_on: row.due_on.slice(0, 10),
      item_type: row.item_type,
    });
  }

  const healthById = new Map(healthRows.map((row) => [row.project_id, row]));
  const stages = new Set(facets.rows.map((row) => row.stage));
  const managers = new Map<string, string>();
  for (const row of facets.rows) {
    if (row.pm_id && row.pm_name) managers.set(row.pm_id, row.pm_name);
  }

  return {
    today,
    status: filters.status,
    projects: projects.rows.map((row) => {
      const assessed = feedHealth(healthById.get(row.id));
      const next = milestones.get(row.id) ?? null;
      return {
        id: row.id,
        project_number: row.project_number,
        name: row.name,
        customer: row.customer,
        stage: row.stage,
        lifecycle: projectLifecycle(row.stage),
        pm_id: row.pm_id,
        pm_name: row.pm_name,
        health: assessed.health,
        next_milestone: next,
      };
    }),
    facets: {
      stages: HOME_STAGES.filter((stage) => stages.has(stage)),
      project_managers: [...managers.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
  };
}

interface DueCandidate {
  project_id: string;
  project_number: string;
  project_name: string;
  item_type: string;
  item_id: string;
  title: string;
  due_on: string | null;
  start_on: string | null;
  end_on: string | null;
  status: string | null;
  state: string | null;
  linked_total: number | string | null;
  linked_done: number | string | null;
  owner_name: string | null;
  owner_role: string | null;
}

function dueKind(kind: string): DueItemType {
  if (kind === "precon") return "precon_task";
  if (kind === "activity") return "activity";
  if (kind === "appointment") return "appointment";
  if (kind === "permit_milestone") return "permit_milestone";
  if (kind === "milestone") return "milestone";
  return "wbs_task";
}

export async function loadDueItems(
  db: SqlClient,
  scope: string | null,
  today: string,
): Promise<DueItem[]> {
  const { rows } = await db.query<DueCandidate>(
    `SELECT project_id, project_number, project_name, item_type, item_id,
            title, due_on, start_on, end_on, status, state,
            linked_total, linked_done, owner_name, owner_role
       FROM (
         SELECT v.id AS project_id, v.project_number, v.name AS project_name,
                'wbs_task'::text AS item_type, c.id::text AS item_id,
                COALESCE(NULLIF(btrim(c.data->>'title'), ''), 'Task') AS title,
                c.data->>'due_on' AS due_on,
                c.data->>'due_on' AS start_on,
                c.data->>'due_on' AS end_on,
                NULL::text AS status,
                c.data->>'state' AS state,
                0 AS linked_total,
                0 AS linked_done,
                s.full_name AS owner_name,
                NULL::text AS owner_role
           FROM projects.projects v
           JOIN projects.project_controls c ON c.project_id = v.id
           LEFT JOIN projects.staff s ON s.id::text = c.data->>'owner_id'
          WHERE ${visibleSql("v")}
            AND c.kind = 'task'
            AND c.active
            AND COALESCE(c.data->>'state', '') <> 'complete'
            AND COALESCE(c.data->>'due_on', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            AND (c.data->>'due_on')::date <= $2::date
         UNION ALL
         SELECT v.id, v.project_number, v.name,
                'precon_task', t.id::text, t.title,
                t.due_on::text, t.due_on::text, t.due_on::text,
                t.status::text, NULL::text, 0, 0,
                NULL::text, t.owner_role::text
           FROM projects.projects v
           JOIN projects.precon_tasks t ON t.project_id = v.id
          WHERE ${visibleSql("v")}
            AND t.status IN ('not_started', 'in_progress')
            AND t.due_on IS NOT NULL
            AND t.due_on <= $2::date
         UNION ALL
         SELECT v.id, v.project_number, v.name,
                'milestone', m.id::text,
                COALESCE(NULLIF(btrim(m.data->>'title'), ''), 'Milestone'),
                m.data->>'due_on', m.data->>'due_on', m.data->>'due_on',
                NULL::text, m.data->>'state',
                (
                  SELECT count(*)::int FROM projects.project_controls t
                   WHERE t.project_id = m.project_id
                     AND t.kind = 'task' AND t.active
                     AND t.data->>'milestone_id' = m.id::text
                ),
                (
                  SELECT count(*)::int FROM projects.project_controls t
                   WHERE t.project_id = m.project_id
                     AND t.kind = 'task' AND t.active
                     AND t.data->>'milestone_id' = m.id::text
                     AND COALESCE(t.data->>'state', '') = 'complete'
                ),
                s.full_name, NULL::text
           FROM projects.projects v
           JOIN projects.project_controls m ON m.project_id = v.id
           LEFT JOIN projects.staff s ON s.id::text = m.data->>'owner_id'
          WHERE ${visibleSql("v")}
            AND m.kind = 'milestone'
            AND m.active
            AND COALESCE(m.data->>'due_on', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            AND (m.data->>'due_on')::date <= $2::date
         UNION ALL
         SELECT v.id, v.project_number, v.name,
                'permit_milestone', pm.id::text, pm.name,
                pm.due_on::text, pm.due_on::text, pm.due_on::text,
                pm.status::text, NULL::text, 0, 0,
                NULL::text, pm.owner_role::text
           FROM projects.projects v
           JOIN projects.permits pr ON pr.project_id = v.id
           JOIN projects.permit_milestones pm ON pm.permit_id = pr.id
          WHERE ${visibleSql("v")}
            AND pm.status IN ('pending', 'in_progress', 'complete')
            AND pm.due_on IS NOT NULL
            AND pm.due_on <= $2::date
         UNION ALL
         SELECT v.id, v.project_number, v.name,
                'activity', s.id::text, s.title,
                s.window_end::text, s.window_start::text, s.window_end::text,
                s.status::text, NULL::text, 0, 0,
                st.full_name, NULL::text
           FROM projects.projects v
           JOIN projects.schedule_items s ON s.project_id = v.id
           LEFT JOIN projects.staff st ON st.id = s.staff_id
          WHERE ${visibleSql("v")}
            AND s.status NOT IN ('cancelled', 'complete')
            AND s.window_start <= $2::date
       ) due`,
    [scope, today],
  );

  const shared = rows.map((row) => {
    const base = {
      id: row.item_id,
      title: row.title,
      project_id: row.project_id,
      project_number: row.project_number,
      project_name: row.project_name,
      owner_name: row.owner_name,
      owner_role: row.owner_role,
    };
    if (row.item_type === "activity")
      return itemFromActivity({
        ...base,
        window_start: row.start_on,
        window_end: row.end_on,
        status: row.status,
      });
    if (row.item_type === "precon_task")
      return itemFromPrecon({
        ...base,
        due_on: row.due_on,
        status: row.status,
      });
    if (row.item_type === "milestone")
      return itemFromMilestone({
        ...base,
        due_on: row.due_on,
        state: row.state,
        linked_total: row.linked_total,
        linked_done: row.linked_done,
      });
    if (row.item_type === "permit_milestone")
      return itemFromPermit({
        ...base,
        name: row.title,
        due_on: row.due_on,
        status: row.status,
      });
    return itemFromWbs({ ...base, due_on: row.due_on, state: row.state });
  });

  const summary = summarizeSchedule(shared, today) as {
    due: Array<{
      kind: string;
      id: string;
      title: string;
      end: string;
      overdue?: boolean;
      project_id: string;
      project_number: string;
      project_name: string;
      owner_name: string | null;
      owner_role: string | null;
    }>;
  };

  return summary.due.map((item) => {
    const itemType = dueKind(item.kind);
    return {
      project_id: item.project_id,
      project_number: item.project_number,
      project_name: item.project_name,
      item_type: itemType,
      item_id: item.id,
      title: item.title,
      due_on: String(item.end).slice(0, 10),
      overdue: item.overdue === true,
      owner_name: item.owner_name,
      owner_role: item.owner_role,
      href: dueItemHref(item.project_id, itemType, item.id),
    };
  });
}
