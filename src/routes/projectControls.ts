import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  staffRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import { can, requireCapability } from "../http/capabilities.js";
import { ApiError, notFound } from "../http/errors.js";
import { sendData } from "../http/envelope.js";
import { loadVisibleProject, parseBody, parseUuidParam } from "./shared.js";
import {
  attachControlRollups,
  controlData,
  preserveDerivedControlFields,
  today,
  leafTasks,
  validateTaskGraph,
  nextCommunicationDate,
  type ControlKind,
  type ControlRecord,
} from "../domain/projectControls.js";
import { loadProjectHealth } from "../domain/projectHealth.js";
import { ragScheduleAndCost } from "../domain/ragHealth.js";
const kind = z.enum([
  "task",
  "goal",
  "milestone",
  "risk",
  "communication",
  "reserve",
  "document",
  "report",
]);
export function projectControlRoutes(deps: StaffRouterDeps) {
  const r = Router();
  async function project(ctx: StaffContext, lock = false) {
    const id = parseUuidParam(ctx.req.params.id, "Project");
    await loadVisibleProject(ctx, id, "id");
    if (lock)
      await ctx.db.query(
        "SELECT id FROM projects.projects WHERE id=$1 FOR UPDATE",
        [id],
      );
    return id;
  }
  function write(ctx: StaffContext, k: ControlKind) {
    requireCapability(
      ctx.staff.role,
      k === "document"
        ? "manage_project_documents"
        : k === "reserve"
          ? "manage_project_reserves"
          : "manage_project_controls",
    );
  }
  function read(ctx: StaffContext, k: ControlKind) {
    if (k === "reserve") requireCapability(ctx.staff.role, "view_margin");
  }
  async function records(ctx: StaffContext, id: string) {
    return (
      await ctx.db.query<ControlRecord>(
        "SELECT c.*,f.file_name,f.file_size,p.state AS st_state,p.record_version AS st_version,p.format AS st_format,l.state AS st_link_state,l.record_version AS st_link_version,l.message AS st_link_message FROM projects.project_controls c LEFT JOIN projects.project_control_files f ON f.record_id=c.id LEFT JOIN LATERAL (SELECT state,record_version,format FROM projects.record_publications WHERE record_id=c.id ORDER BY created_at DESC LIMIT 1) p ON true LEFT JOIN LATERAL (SELECT state,record_version,message FROM projects.document_links WHERE record_id=c.id ORDER BY created_at DESC LIMIT 1) l ON true WHERE c.project_id=$1 ORDER BY c.created_at,c.id",
        [id],
      )
    ).rows;
  }
  async function one(ctx: StaffContext, id: string) {
    const row = (
      await ctx.db.query<ControlRecord>(
        "SELECT * FROM projects.project_controls WHERE id=$1 AND project_id=$2",
        [parseUuidParam(ctx.req.params.recordId, "Record"), id],
      )
    ).rows[0];
    if (!row) throw notFound("Project record not found");
    return row;
  }
  async function audit(
    ctx: StaffContext,
    id: string,
    action: string,
    before: unknown,
    after: unknown,
  ) {
    await ctx.db.query(
      `INSERT INTO projects.audit_log(tenant_id,actor_type,actor_id,entity_table,entity_id,action,before_data,after_data) VALUES($1,'staff',$2,'project_controls',$3,$4,$5::jsonb,$6::jsonb)`,
      [
        ctx.staff.tenantId,
        ctx.staff.staffId,
        id,
        action,
        JSON.stringify(before),
        JSON.stringify(after),
      ],
    );
  }
  function linkedTasks(rows: ControlRecord[], milestoneId: string) {
    return rows.filter(
      (row) =>
        row.active &&
        row.kind === "task" &&
        row.data.milestone_id === milestoneId,
    ).length;
  }
  async function healthRag(ctx: StaffContext, projectId: string) {
    const rows = await loadProjectHealth(ctx.db, today());
    return ragScheduleAndCost(
      rows.find((row) => row.project_id === projectId)?.health,
    );
  }
  function finishManualMilestone(data: object, linked: number) {
    const record = data as { state?: string; completed_on?: string | null };
    if (linked > 0 || record.state !== "complete") return;
    record.completed_on ??= today();
    if (record.completed_on > today())
      throw new ApiError(
        "validation_failed",
        "Completion cannot be in the future.",
      );
  }
  async function progress(ctx: StaffContext, id: string) {
    const b = (
      await ctx.db.query<{ id: string }>(
        "SELECT id FROM projects.project_control_baselines WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
        [id],
      )
    ).rows[0];
    if (!b) return;
    const tasks = leafTasks(await records(ctx, id));
    await ctx.db.query(
      `INSERT INTO projects.project_control_progress(tenant_id,baseline_id,on_date,total,remaining) VALUES($1,$2,$3,$4,$5) ON CONFLICT(baseline_id,on_date) DO UPDATE SET total=excluded.total,remaining=excluded.remaining`,
      [
        ctx.staff.tenantId,
        b.id,
        today(),
        tasks.length,
        tasks.filter((t) => t.data.state !== "complete").length,
      ],
    );
  }
  async function validate(
    ctx: StaffContext,
    projectId: string,
    row: ControlRecord,
    all: ControlRecord[],
  ) {
    const b = row.data;
    if (
      b.owner_id &&
      !(
        await ctx.db.query(
          "SELECT id FROM projects.staff WHERE id=$1 AND active",
          [b.owner_id],
        )
      ).rows.length
    )
      throw new ApiError(
        "validation_failed",
        "Choose an active PM user as owner.",
      );
    for (const [field, table] of [
      ["resource_id", "scheduling_resources"],
      ["job_link_id", "project_job_links"],
    ] as const) {
      if (
        b[field] &&
        !(
          await ctx.db.query(
            `SELECT id FROM projects.${table} WHERE id=$1 ${field === "job_link_id" ? "AND project_id=$2 AND source_active" : "AND active"}`,
            field === "job_link_id" ? [b[field], projectId] : [b[field]],
          )
        ).rows.length
      )
        throw new ApiError(
          "validation_failed",
          "Choose an active crew or a job linked to this project.",
        );
    }
    for (const [field, k] of [
      ["milestone_id", "milestone"],
      ["goal_id", "goal"],
      ["risk_id", "risk"],
    ] as const) {
      if (
        b[field] &&
        !all.some((r) => r.id === b[field] && r.kind === k && r.active)
      )
        throw new ApiError(
          "validation_failed",
          "Linked project record is missing or archived.",
        );
    }
    const candidate = [...all.filter((r) => r.id !== row.id), row];
    if (
      !row.active &&
      candidate.some(
        (r) =>
          r.active &&
          Object.values(r.data).some(
            (v) => v === row.id || (Array.isArray(v) && v.includes(row.id)),
          ),
      )
    )
      throw new ApiError(
        "conflict",
        "Remove links and child tasks before archiving this record.",
      );
    if (row.kind === "task" || !row.active) {
      try {
        validateTaskGraph(candidate);
      } catch (e) {
        throw new ApiError("validation_failed", (e as Error).message);
      }
    }
    if (row.kind === "task") {
      if (b.state === "complete") {
        b.completed_on ??= today();
        if (
          b.completed_on > today() ||
          (b.start_on && b.completed_on < b.start_on)
        )
          throw new ApiError(
            "validation_failed",
            "Completion must be between the start date and today.",
          );
      } else b.completed_on = null;
    }
  }
  r.get(
    "/projects/:id/controls",
    staffRoute(deps, async (ctx) => {
      const id = await project(ctx);
      const rows = (await records(ctx, id)).filter(
        (r) => r.kind !== "reserve" || can(ctx.staff.role, "view_margin"),
      );
      const baseline =
        (
          await ctx.db.query(
            "SELECT id,start_on::text,finish_on::text,total,created_at FROM projects.project_control_baselines WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
            [id],
          )
        ).rows[0] ?? null;
      const history = baseline
        ? (
            await ctx.db.query(
              "SELECT on_date::text,total,remaining FROM projects.project_control_progress WHERE baseline_id=$1 ORDER BY on_date",
              [baseline.id],
            )
          ).rows
        : [];
      sendData(ctx.res, {
        records: attachControlRollups(rows, today()),
        baseline,
        history,
        rag: await healthRag(ctx, id),
      });
    }),
  );
  r.post(
    "/projects/:id/controls",
    staffRoute(deps, async (ctx) => {
      const id = await project(ctx, true);
      const b = parseBody(
        z.object({ kind, data: z.unknown() }).strict(),
        ctx.req.body,
      );
      write(ctx, b.kind);
      const data = preserveDerivedControlFields(
        b.kind,
        parseBody(controlData[b.kind], b.data),
        null,
        0,
      );
      if (b.kind === "milestone") finishManualMilestone(data, 0);
      if (b.kind === "report") Object.assign(data, await healthRag(ctx, id));
      const row: ControlRecord = {
        id: randomUUID(),
        kind: b.kind,
        data,
        active: true,
        version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await validate(ctx, id, row, await records(ctx, id));
      await ctx.db.query(
        "INSERT INTO projects.project_controls(id,tenant_id,project_id,kind,data) VALUES($1,$2,$3,$4,$5::jsonb)",
        [row.id, ctx.staff.tenantId, id, b.kind, JSON.stringify(data)],
      );
      await audit(ctx, row.id, "created", null, data);
      if (b.kind === "task") await progress(ctx, id);
      sendData(ctx.res, row, undefined, 201);
    }),
  );
  r.delete(
    "/projects/:id/controls/:recordId",
    staffRoute(deps, async (ctx) => {
      const id = await project(ctx, true);
      const old = await one(ctx, id);
      write(ctx, old.kind);
      if (old.kind !== "milestone" && old.kind !== "goal")
        throw new ApiError(
          "validation_failed",
          "This delete action is only available for milestones and goals.",
        );
      const body = parseBody(
        z.object({ version: z.number().int().positive() }).strict(),
        ctx.req.body,
      );
      const noun = old.kind === "goal" ? "goal" : "milestone";
      if (body.version !== old.version)
        throw new ApiError(
          "conflict",
          `This ${noun} changed. Reload it before deleting.`,
        );
      if (!old.active) {
        sendData(ctx.res, old);
        return;
      }
      const existing = await records(ctx, id);
      // Keep the linked records. Drop only the link, the same way a milestone delete keeps its tasks.
      const linkedTasks = existing.filter(
        (row) => row.kind === "task" && row.data.milestone_id === old.id,
      );
      const linkedMilestones = existing.filter(
        (row) => row.kind === "milestone" && row.data.goal_id === old.id,
      );
      if (old.kind === "milestone") {
        for (const task of linkedTasks) {
          const data = { ...task.data, milestone_id: null };
          await ctx.db.query(
            "UPDATE projects.project_controls SET data=$1::jsonb,version=version+1,updated_at=now() WHERE id=$2",
            [JSON.stringify(data), task.id],
          );
          await audit(ctx, task.id, "milestone_unlinked", task.data, data);
        }
      } else {
        for (const milestone of linkedMilestones) {
          const data = { ...milestone.data, goal_id: null };
          await ctx.db.query(
            "UPDATE projects.project_controls SET data=$1::jsonb,version=version+1,updated_at=now() WHERE id=$2",
            [JSON.stringify(data), milestone.id],
          );
          await audit(ctx, milestone.id, "goal_unlinked", milestone.data, data);
        }
      }
      await ctx.db.query(
        "UPDATE projects.project_controls SET active=false,version=version+1,updated_at=now() WHERE id=$1",
        [old.id],
      );
      await audit(ctx, old.id, "archived", old.data, old.data);
      sendData(ctx.res, {
        ...old,
        active: false,
        version: old.version + 1,
        unlinked_tasks: old.kind === "milestone" ? linkedTasks.length : 0,
        unlinked_milestones: old.kind === "goal" ? linkedMilestones.length : 0,
      });
    }),
  );
  r.patch(
    "/projects/:id/controls/:recordId",
    staffRoute(deps, async (ctx) => {
      const id = await project(ctx, true);
      const old = await one(ctx, id);
      write(ctx, old.kind);
      const b = parseBody(
        z
          .object({
            version: z.number().int(),
            data: z.unknown(),
            active: z.boolean().default(true),
          })
          .strict(),
        ctx.req.body,
      );
      if (b.version !== old.version)
        throw new ApiError(
          "conflict",
          "This record changed. Reload it before saving.",
        );
      const all = await records(ctx, id);
      const linked = old.kind === "milestone" ? linkedTasks(all, old.id) : 0;
      const data = preserveDerivedControlFields(
        old.kind,
        parseBody(controlData[old.kind], b.data),
        old.data,
        linked,
      );
      if (old.kind === "milestone") finishManualMilestone(data, linked);
      if (old.kind === "report") Object.assign(data, await healthRag(ctx, id));
      const updated = {
        ...old,
        data,
        active: b.active,
        version: old.version + 1,
      };
      await validate(ctx, id, updated, await records(ctx, id));
      await ctx.db.query(
        "UPDATE projects.project_controls SET data=$1::jsonb,active=$2,version=version+1,updated_at=now() WHERE id=$3",
        [JSON.stringify(data), b.active, old.id],
      );
      await audit(
        ctx,
        old.id,
        b.active ? "updated" : "archived",
        old.data,
        data,
      );
      if (old.kind === "task") await progress(ctx, id);
      sendData(ctx.res, updated);
    }),
  );
  r.post(
    "/projects/:id/controls/baseline",
    staffRoute(deps, async (ctx) => {
      const id = await project(ctx, true);
      write(ctx, "task");
      const b = parseBody(
        z.object({ finish_on: z.string().date() }).strict(),
        ctx.req.body,
      );
      if (b.finish_on < today())
        throw new ApiError(
          "validation_failed",
          "Choose a target date of today or later.",
        );
      const tasks = leafTasks(await records(ctx, id));
      if (!tasks.length)
        throw new ApiError(
          "validation_failed",
          "Add tasks before recording a baseline.",
        );
      const row = (
        await ctx.db.query(
          "INSERT INTO projects.project_control_baselines(tenant_id,project_id,start_on,finish_on,total) VALUES($1,$2,$3,$4,$5) RETURNING id",
          [
            ctx.staff.tenantId,
            id,
            today(),
            b.finish_on,
            tasks.filter((t) => t.data.state !== "complete").length,
          ],
        )
      ).rows[0];
      await progress(ctx, id);
      await audit(ctx, id, "burndown_baseline", null, b);
      sendData(ctx.res, row, undefined, 201);
    }),
  );
  r.post(
    "/projects/:id/controls/:recordId/deliver",
    staffRoute(deps, async (ctx) => {
      const id = await project(ctx, true),
        row = await one(ctx, id);
      write(ctx, "communication");
      if (row.kind !== "communication" || !row.active)
        throw notFound("Communication plan not found");
      const b = parseBody(
        z.object({
          version: z.number().int(),
          notes: z.string().min(1).max(10000),
        }),
        ctx.req.body,
      );
      if (b.version !== row.version)
        throw new ApiError("conflict", "This plan changed. Reload it.");
      const data = {
        ...row.data,
        last_delivered_on: today(),
        delivery_notes: b.notes,
        next_on: nextCommunicationDate(row.data.cadence, today()),
      };
      await ctx.db.query(
        "UPDATE projects.project_controls SET data=$1::jsonb,version=version+1,updated_at=now() WHERE id=$2",
        [JSON.stringify(data), row.id],
      );
      await audit(ctx, row.id, "communication_delivered", row.data, data);
      sendData(ctx.res, { ...row, data, version: row.version + 1 });
    }),
  );
  r.post(
    "/projects/:id/controls/:recordId/file",
    staffRoute(deps, async (ctx) => {
      const id = await project(ctx, true),
        row = await one(ctx, id);
      write(ctx, "document");
      if (row.kind !== "document" || !row.active)
        throw notFound("Document not found");
      const b = parseBody(
        z
          .object({
            file_name: z.string().min(1).max(200),
            media_type: z.enum([
              "application/pdf",
              "image/png",
              "image/jpeg",
              "text/plain",
              "text/csv",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ]),
            content: z.string().min(1).max(11184812),
          })
          .strict(),
        ctx.req.body,
      );
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b.content))
        throw new ApiError("validation_failed", "Invalid file encoding.");
      const bytes = Buffer.from(b.content, "base64");
      const valid =
        b.media_type === "application/pdf"
          ? bytes.subarray(0, 5).toString() === "%PDF-"
          : b.media_type === "image/png"
            ? bytes
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : b.media_type === "image/jpeg"
              ? bytes[0] === 255 && bytes[1] === 216
              : b.media_type.startsWith("application/vnd.")
                ? bytes.subarray(0, 2).toString() === "PK"
                : !bytes.includes(0);
      if (!valid || bytes.length < 1 || bytes.length > 8388608)
        throw new ApiError(
          "validation_failed",
          "Choose a supported file up to 8 MB.",
        );
      const name = b.file_name.replace(/[\x00-\x1f\\/]/g, "_");
      await ctx.db.query(
        "INSERT INTO projects.project_control_files(tenant_id,record_id,file_name,media_type,file_data,file_size) VALUES($1,$2,$3,$4,$5,$6)",
        [ctx.staff.tenantId, row.id, name, b.media_type, bytes, bytes.length],
      );
      await audit(ctx, row.id, "file_attached", null, {
        file_name: name,
        file_size: bytes.length,
      });
      sendData(
        ctx.res,
        { file_name: name, file_size: bytes.length },
        undefined,
        201,
      );
    }),
  );
  r.get(
    "/projects/:id/controls/:recordId/file",
    staffRoute(deps, async (ctx) => {
      const id = await project(ctx),
        row = await one(ctx, id);
      read(ctx, row.kind);
      if (row.kind !== "document") throw notFound("Document not found");
      const file = (
        await ctx.db.query(
          "SELECT file_name,media_type,encode(file_data,'base64') AS content FROM projects.project_control_files WHERE record_id=$1",
          [row.id],
        )
      ).rows[0];
      if (!file) throw notFound("File not found");
      ctx.res.set("Cache-Control", "no-store");
      sendData(ctx.res, file);
    }),
  );
  r.get(
    "/projects/:id/controls/:recordId/history",
    staffRoute(deps, async (ctx) => {
      const id = await project(ctx),
        row = await one(ctx, id);
      read(ctx, row.kind);
      sendData(
        ctx.res,
        (
          await ctx.db.query(
            `SELECT action,after_data,occurred_at,s.full_name AS actor FROM projects.audit_log a LEFT JOIN projects.staff s ON s.id=a.actor_id WHERE entity_table='project_controls' AND entity_id=$1 ORDER BY occurred_at DESC LIMIT 100`,
            [row.id],
          )
        ).rows,
      );
    }),
  );
  return r;
}
