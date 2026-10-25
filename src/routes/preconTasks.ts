import { Router } from "express";
import { z } from "zod";
import {
  INSPECTION_RESULTS,
  PRECON_NOTES_MAX,
  PRECON_STATUSES,
  PRECON_TASK_TYPES,
  countPreconTasks,
  listPreconTasks,
  seedPreconTasks,
  type PreconStatus,
  type PreconTaskType,
} from "../domain/preconTasks.js";
import { requireCapability } from "../http/capabilities.js";
import { sendData } from "../http/envelope.js";
import { ApiError, notFound, validationFailed } from "../http/errors.js";
import {
  staffRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import {
  loadVisibleProject,
  parseBody,
  parseUuidParam,
  requireOwnedRow,
} from "./shared.js";

const taskType = z.enum(PRECON_TASK_TYPES);
const taskStatus = z.enum(PRECON_STATUSES);
const inspectionResult = z.enum(INSPECTION_RESULTS);
const staffRole = z.enum([
  "owner",
  "manager",
  "project_manager",
  "estimator",
  "office",
  "bookkeeper",
]);
const notes = z
  .string()
  .trim()
  .max(PRECON_NOTES_MAX)
  .nullable()
  .optional()
  .transform((value) =>
    value === undefined ? undefined : value ? value : null,
  );

const createTaskSchema = z
  .object({
    type: taskType,
    title: z.string().trim().min(1).max(200),
    owner_role: staffRole,
    due_on: z.string().date().nullish(),
    status: taskStatus.optional(),
    notes,
    jurisdiction_id: z.string().uuid().nullish(),
    permit_id: z.string().uuid().nullish(),
    purchase_order_id: z.string().uuid().nullish(),
    sort_order: z.number().int().min(0).max(10000).optional(),
  })
  .strict();

const patchTaskSchema = z
  .object({
    type: taskType.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    owner_role: staffRole.optional(),
    due_on: z.string().date().nullish(),
    status: taskStatus.optional(),
    notes,
    jurisdiction_id: z.string().uuid().nullish(),
    permit_id: z.string().uuid().nullish(),
    purchase_order_id: z.string().uuid().nullish(),
    sort_order: z.number().int().min(0).max(10000).optional(),
  })
  .strict();

const createInspectionSchema = z
  .object({
    scheduled_on: z.string().date().nullish(),
    occurred_on: z.string().date().nullish(),
    result: inspectionResult.optional(),
    notes,
  })
  .strict();

const patchInspectionSchema = createInspectionSchema;

interface TaskLinkState {
  task_type: PreconTaskType;
  jurisdiction_id: string | null;
  permit_id: string | null;
  purchase_order_id: string | null;
}

interface StoredTask extends TaskLinkState {
  id: string;
  project_id: string;
  title: string;
  owner_role: string;
  due_on: string | null;
  status: PreconStatus;
  notes: string | null;
  sort_order: number;
}

/**
 * Staff checklist for work that happens before the field is on site.
 * Viewing is open to every staff role. Writing is owner, manager, and
 * project_manager. These routes do not create permits, purchase orders,
 * or anything in ServiceTitan or QuickBooks.
 */
export function preconTaskRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    "/projects/:id/precon-tasks",
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      sendData(ctx.res, await listPreconTasks(ctx.db, projectId));
    }),
  );

  router.post(
    "/projects/:id/precon-tasks",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_precon_tasks");
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, projectId, "id");
      const body = parseBody(createTaskSchema, ctx.req.body);
      const next: TaskLinkState = {
        task_type: body.type,
        jurisdiction_id: body.jurisdiction_id ?? null,
        permit_id: body.permit_id ?? null,
        purchase_order_id: body.purchase_order_id ?? null,
      };
      await assertTaskLinks(ctx, projectId, next);
      const sort =
        body.sort_order ??
        Number(
          (
            await ctx.db.query<{ n: string }>(
              `SELECT (COALESCE(max(sort_order), 0) + 1)::text AS n
                 FROM projects.precon_tasks WHERE project_id = $1`,
              [projectId],
            )
          ).rows[0]?.n ?? "1",
        );
      const inserted = await ctx.db.query<{ id: string }>(
        `INSERT INTO projects.precon_tasks
           (tenant_id, project_id, task_type, title, owner_role, due_on, status, notes,
            jurisdiction_id, permit_id, purchase_order_id, sort_order)
         VALUES ($1,$2,$3,$4,$5::projects.staff_role,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          ctx.staff.tenantId,
          projectId,
          body.type,
          body.title,
          body.owner_role,
          body.due_on ?? null,
          body.status ?? "not_started",
          body.notes ?? null,
          next.jurisdiction_id,
          next.permit_id,
          next.purchase_order_id,
          sort,
        ],
      );
      sendData(
        ctx.res,
        await oneTask(ctx, projectId, inserted.rows[0]!.id),
        undefined,
        201,
      );
    }),
  );

  router.post(
    "/projects/:id/precon-tasks/apply-template",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_precon_tasks");
      const projectId = parseUuidParam(ctx.req.params.id, "Project");
      const project = await loadVisibleProject<{
        scheduled_start: string | null;
      }>(ctx, projectId, "scheduled_start");
      const existing = await countPreconTasks(ctx.db, projectId);
      if (existing > 0) {
        throw new ApiError(
          "conflict",
          "This project already has preconstruction tasks.",
          { tasks: existing },
        );
      }
      await seedPreconTasks(
        ctx.db,
        ctx.staff.tenantId,
        projectId,
        project.scheduled_start,
      );
      sendData(
        ctx.res,
        await listPreconTasks(ctx.db, projectId),
        undefined,
        201,
      );
    }),
  );

  router.patch(
    "/precon-tasks/:id",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_precon_tasks");
      const taskId = parseUuidParam(ctx.req.params.id, "Preconstruction task");
      const current = await loadTask(ctx, taskId);
      const body = parseBody(patchTaskSchema, ctx.req.body);
      const next: TaskLinkState = {
        task_type: body.type ?? current.task_type,
        jurisdiction_id:
          body.jurisdiction_id === undefined
            ? current.jurisdiction_id
            : body.jurisdiction_id,
        permit_id:
          body.permit_id === undefined ? current.permit_id : body.permit_id,
        purchase_order_id:
          body.purchase_order_id === undefined
            ? current.purchase_order_id
            : body.purchase_order_id,
      };
      await assertTaskLinks(ctx, current.project_id, next);
      const assignable: Record<string, unknown> = {
        task_type: body.type,
        title: body.title,
        owner_role: body.owner_role,
        due_on: body.due_on,
        status: body.status,
        notes: body.notes,
        jurisdiction_id: body.jurisdiction_id,
        permit_id: body.permit_id,
        purchase_order_id: body.purchase_order_id,
        sort_order: body.sort_order,
      };
      const entries = Object.entries(assignable).filter(
        ([, value]) => value !== undefined,
      );
      if (entries.length > 0) {
        const sets = entries
          .map(([column], index) =>
            column === "owner_role"
              ? `${column} = $${index + 2}::projects.staff_role`
              : `${column} = $${index + 2}`,
          )
          .join(", ");
        await ctx.db.query(
          `UPDATE projects.precon_tasks SET ${sets} WHERE id = $1`,
          [taskId, ...entries.map(([, value]) => value)],
        );
      }
      sendData(ctx.res, await oneTask(ctx, current.project_id, taskId));
    }),
  );

  router.post(
    "/precon-tasks/:id/inspections",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_precon_tasks");
      const taskId = parseUuidParam(ctx.req.params.id, "Preconstruction task");
      const task = await loadTask(ctx, taskId);
      if (task.task_type !== "permit") {
        throw new ApiError("conflict", "Inspections belong on a permit task.");
      }
      const body = parseBody(createInspectionSchema, ctx.req.body ?? {});
      const inserted = await ctx.db.query<{ id: string }>(
        `INSERT INTO projects.precon_inspections
           (tenant_id, task_id, scheduled_on, occurred_on, result, notes)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          ctx.staff.tenantId,
          taskId,
          body.scheduled_on ?? null,
          body.occurred_on ?? null,
          body.result ?? "pending",
          body.notes ?? null,
        ],
      );
      const tasks = await listPreconTasks(ctx.db, task.project_id);
      const inspection = tasks
        .find((item) => item.id === taskId)
        ?.inspections.find((item) => item.id === inserted.rows[0]!.id);
      sendData(ctx.res, inspection, undefined, 201);
    }),
  );

  router.patch(
    "/precon-inspections/:id",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_precon_tasks");
      const inspectionId = parseUuidParam(ctx.req.params.id, "Inspection");
      const current = await loadInspection(ctx, inspectionId);
      const body = parseBody(patchInspectionSchema, ctx.req.body ?? {});
      const assignable: Record<string, unknown> = {
        scheduled_on: body.scheduled_on,
        occurred_on: body.occurred_on,
        result: body.result,
        notes: body.notes,
      };
      const entries = Object.entries(assignable).filter(
        ([, value]) => value !== undefined,
      );
      if (entries.length > 0) {
        const sets = entries
          .map(([column], index) => `${column} = $${index + 2}`)
          .join(", ");
        await ctx.db.query(
          `UPDATE projects.precon_inspections SET ${sets} WHERE id = $1`,
          [inspectionId, ...entries.map(([, value]) => value)],
        );
      }
      const tasks = await listPreconTasks(ctx.db, current.project_id);
      const inspection = tasks
        .flatMap((task) => task.inspections)
        .find((item) => item.id === inspectionId);
      sendData(ctx.res, inspection);
    }),
  );

  router.delete(
    "/precon-inspections/:id",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_precon_tasks");
      const inspectionId = parseUuidParam(ctx.req.params.id, "Inspection");
      await loadInspection(ctx, inspectionId);
      await ctx.db.query(
        `DELETE FROM projects.precon_inspections WHERE id = $1`,
        [inspectionId],
      );
      sendData(ctx.res, { id: inspectionId, deleted: true });
    }),
  );

  return router;
}

async function assertTaskLinks(
  ctx: StaffContext,
  projectId: string,
  task: TaskLinkState,
): Promise<void> {
  if (task.jurisdiction_id && task.task_type !== "permit") {
    throw validationFailed([
      {
        field: "jurisdiction_id",
        message: "A jurisdiction belongs on a permit task.",
      },
    ]);
  }
  if (task.permit_id && task.task_type !== "permit") {
    throw validationFailed([
      { field: "permit_id", message: "A permit belongs on a permit task." },
    ]);
  }
  if (task.purchase_order_id && task.task_type !== "material_order") {
    throw validationFailed([
      {
        field: "purchase_order_id",
        message: "A material order belongs on a material order task.",
      },
    ]);
  }
  await requireOwnedRow(
    ctx.db,
    "jurisdictions",
    task.jurisdiction_id,
    "jurisdiction_id",
  );
  if (task.permit_id) {
    const permit = await ctx.db.query<{ project_id: string }>(
      `SELECT project_id FROM projects.permits WHERE id = $1`,
      [task.permit_id],
    );
    if (permit.rows[0]?.project_id !== projectId) {
      throw validationFailed([
        { field: "permit_id", message: "Link a permit on this project." },
      ]);
    }
  }
  if (task.purchase_order_id) {
    const po = await ctx.db.query<{ project_id: string; kind: string }>(
      `SELECT project_id, kind::text AS kind FROM projects.purchase_orders WHERE id = $1`,
      [task.purchase_order_id],
    );
    const row = po.rows[0];
    if (!row || row.project_id !== projectId || row.kind !== "material") {
      throw validationFailed([
        {
          field: "purchase_order_id",
          message: "Link a material purchase order on this project.",
        },
      ]);
    }
  }
}

async function loadTask(
  ctx: StaffContext,
  taskId: string,
): Promise<StoredTask> {
  const { rows } = await ctx.db.query<StoredTask>(
    `SELECT id, project_id, task_type, title, owner_role::text AS owner_role,
            due_on::text AS due_on, status, notes, sort_order,
            jurisdiction_id, permit_id, purchase_order_id
       FROM projects.precon_tasks WHERE id = $1`,
    [taskId],
  );
  const task = rows[0];
  if (!task) throw notFound("Preconstruction task not found");
  await loadVisibleProject(ctx, task.project_id, "id");
  return task;
}

async function loadInspection(
  ctx: StaffContext,
  inspectionId: string,
): Promise<{ id: string; task_id: string; project_id: string }> {
  const { rows } = await ctx.db.query<{
    id: string;
    task_id: string;
    project_id: string;
  }>(
    `SELECT i.id, i.task_id, t.project_id
       FROM projects.precon_inspections i
       JOIN projects.precon_tasks t ON t.id = i.task_id
      WHERE i.id = $1`,
    [inspectionId],
  );
  const inspection = rows[0];
  if (!inspection) throw notFound("Inspection not found");
  await loadVisibleProject(ctx, inspection.project_id, "id");
  return inspection;
}

async function oneTask(ctx: StaffContext, projectId: string, taskId: string) {
  const task = (await listPreconTasks(ctx.db, projectId)).find(
    (item) => item.id === taskId,
  );
  if (!task) throw notFound("Preconstruction task not found");
  return task;
}
