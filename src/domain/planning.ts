import { z } from "zod";
import type { StaffContext } from "../http/staffSession.js";
import { ApiError, notFound } from "../http/errors.js";

export const planningFields = {
  trade: z.string().trim().max(120).nullish(),
  activity_type: z.string().trim().max(200).nullish(),
  phase: z.string().trim().max(120).nullish(),
  job_link_id: z.string().uuid().nullish(),
  resource_ids: z.array(z.string().uuid()).max(50).optional(),
  dependencies: z
    .array(
      z
        .object({
          predecessor_id: z.string().uuid(),
          lag_days: z.number().int().min(0).max(365).default(0),
        })
        .strict(),
    )
    .max(50)
    .optional(),
};
type PlanningInput = {
  job_link_id?: string | null;
  resource_ids?: string[];
  depends_on?: string | null;
  dependencies?: { predecessor_id: string; lag_days: number }[];
};

export async function validatePlanning(
  ctx: StaffContext,
  projectId: string,
  input: PlanningInput,
  itemId?: string,
) {
  // Serialize graph edits per project so concurrent A->B and B->A edits cannot
  // both pass cycle detection on an earlier snapshot.
  await ctx.db.query(
    "SELECT id FROM projects.projects WHERE id = $1 FOR UPDATE",
    [projectId],
  );
  if (input.job_link_id) {
    const r = await ctx.db.query(
      "SELECT id FROM projects.project_job_links WHERE id = $1 AND project_id = $2 AND (source_active OR id IN (SELECT job_link_id FROM projects.schedule_items WHERE id=$3))",
      [input.job_link_id, projectId, itemId ?? null],
    );
    if (!r.rows.length) throw notFound("Job link not found");
  }
  if (input.resource_ids) {
    if (new Set(input.resource_ids).size !== input.resource_ids.length)
      throw new ApiError(
        "validation_failed",
        "A resource can only be assigned once.",
      );
    const r = await ctx.db.query(
      "SELECT id FROM projects.scheduling_resources WHERE id = ANY($1::uuid[]) AND (active OR id IN (SELECT resource_id FROM projects.schedule_assignments WHERE schedule_item_id=$2))",
      [input.resource_ids, itemId ?? null],
    );
    if (r.rows.length !== input.resource_ids.length)
      throw notFound("Resource not found");
  }
  if (input.dependencies !== undefined && input.depends_on !== undefined) {
    throw new ApiError(
      "validation_failed",
      "Use dependencies or depends_on, not both.",
    );
  }
  const dependencies =
    input.dependencies ??
    (input.depends_on
      ? [{ predecessor_id: input.depends_on, lag_days: 0 }]
      : input.depends_on === null
        ? []
        : undefined);
  if (dependencies) {
    const ids = dependencies.map((d) => d.predecessor_id);
    if (new Set(ids).size !== ids.length)
      throw new ApiError(
        "validation_failed",
        "A predecessor can only be listed once.",
      );
    const r = await ctx.db.query(
      "SELECT id FROM projects.schedule_items WHERE project_id = $1 AND id = ANY($2::uuid[])",
      [projectId, ids],
    );
    if (r.rows.length !== ids.length) throw notFound("Predecessor not found");
    if (itemId) {
      const cycle = await ctx.db.query(
        `WITH RECURSIVE edges AS (
        SELECT schedule_item_id AS child, predecessor_id AS parent FROM projects.schedule_dependencies WHERE project_id = $1 AND schedule_item_id <> $2
        UNION SELECT id, depends_on FROM projects.schedule_items WHERE project_id = $1 AND id <> $2 AND depends_on IS NOT NULL
      ), ancestors(id) AS (
        SELECT unnest($3::uuid[]) UNION SELECT e.parent FROM edges e JOIN ancestors a ON e.child = a.id
      ) SELECT id FROM ancestors WHERE id = $2`,
        [projectId, itemId, ids],
      );
      if (cycle.rows.length)
        throw new ApiError("conflict", "This dependency would create a cycle.");
    }
  }
  return dependencies;
}

export async function savePlanning(
  ctx: StaffContext,
  projectId: string,
  itemId: string,
  resourceIds: string[] | undefined,
  dependencies: { predecessor_id: string; lag_days: number }[] | undefined,
) {
  if (resourceIds !== undefined) {
    await ctx.db.query(
      "DELETE FROM projects.schedule_assignments WHERE schedule_item_id = $1",
      [itemId],
    );
    for (const id of resourceIds)
      await ctx.db.query(
        `INSERT INTO projects.schedule_assignments
      (tenant_id, project_id, schedule_item_id, resource_id) VALUES ($1,$2,$3,$4)`,
        [ctx.staff.tenantId, projectId, itemId, id],
      );
  }
  if (dependencies !== undefined) {
    await ctx.db.query(
      "DELETE FROM projects.schedule_dependencies WHERE schedule_item_id = $1",
      [itemId],
    );
    for (const d of dependencies)
      await ctx.db.query(
        `INSERT INTO projects.schedule_dependencies
      (tenant_id, project_id, schedule_item_id, predecessor_id, lag_days) VALUES ($1,$2,$3,$4,$5)`,
        [ctx.staff.tenantId, projectId, itemId, d.predecessor_id, d.lag_days],
      );
    // Retire the scalar on edited rows; untouched legacy dependencies remain readable.
    await ctx.db.query(
      "UPDATE projects.schedule_items SET depends_on = NULL WHERE id = $1",
      [itemId],
    );
  }
}

export async function enrichSchedule(
  ctx: StaffContext,
  rows: Record<string, any>[],
) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const resources = await ctx.db.query<Record<string, any>>(
    `SELECT a.schedule_item_id, r.id, r.name, r.kind, r.trade,
    r.vendor_id, CASE WHEN r.vendor_id IS NULL THEN true ELSE COALESCE(e.schedulable,false) END AS schedulable
    FROM projects.schedule_assignments a JOIN projects.scheduling_resources r ON r.id = a.resource_id
    LEFT JOIN projects.v_vendor_eligibility e ON e.vendor_id = r.vendor_id WHERE a.schedule_item_id = ANY($1::uuid[]) ORDER BY r.name`,
    [ids],
  );
  const deps = await ctx.db.query<Record<string, any>>(
    `WITH deps AS (
    SELECT schedule_item_id, predecessor_id, lag_days FROM projects.schedule_dependencies WHERE schedule_item_id = ANY($1::uuid[])
    UNION SELECT id, depends_on, 0 FROM projects.schedule_items WHERE id = ANY($1::uuid[]) AND depends_on IS NOT NULL
  ) SELECT d.*, p.title, p.status, p.window_end,
    (s.window_start <= p.window_end + d.lag_days) AS date_conflict
    FROM deps d JOIN projects.schedule_items p ON p.id = d.predecessor_id
    JOIN projects.schedule_items s ON s.id = d.schedule_item_id ORDER BY p.window_end`,
    [ids],
  );
  // Report resource contention without exposing a potentially hidden project's
  // name or identifier. Date windows are inclusive and are planning warnings.
  const conflicts = await ctx.db.query<{
    schedule_item_id: string;
    resource_id: string;
  }>(
    `SELECT DISTINCT a.schedule_item_id, a.resource_id
    FROM projects.schedule_assignments a JOIN projects.schedule_items s ON s.id = a.schedule_item_id
    JOIN projects.schedule_assignments b ON b.resource_id = a.resource_id AND b.schedule_item_id <> a.schedule_item_id
    JOIN projects.schedule_items other ON other.id = b.schedule_item_id
    WHERE a.schedule_item_id = ANY($1::uuid[]) AND s.status NOT IN ('cancelled','complete')
      AND other.status NOT IN ('cancelled','complete') AND s.window_start <= other.window_end AND s.window_end >= other.window_start`,
    [ids],
  );
  return rows.map((row) => ({
    ...row,
    resources: resources.rows.filter((r) => r.schedule_item_id === row.id),
    dependencies: deps.rows.filter((d) => d.schedule_item_id === row.id),
    conflicting_resource_ids: conflicts.rows
      .filter((c) => c.schedule_item_id === row.id)
      .map((c) => c.resource_id),
  }));
}
