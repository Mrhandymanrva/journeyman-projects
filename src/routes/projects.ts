import { deleteLocalProject } from '../domain/deleteProject.js';
import { presentFieldRelease, readFieldRelease } from '../domain/fieldRelease.js';
import {
  fieldStartColumns,
  preconCountsFromRow,
  presentFieldStart,
} from '../domain/fieldStart.js';
import type { SqlClient } from '../db/database.js';
import { Router } from "express";
import { z } from "zod";
import { sendData } from "../http/envelope.js";
import { ApiError, notFound } from "../http/errors.js";
import { requireCapability, unitFilter } from "../http/capabilities.js";
import {
  staffRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import {
  assertUnitWritable,
  loadVisibleProject,
  num,
  parseBody,
  parsePagination,
  parseUuidParam,
  requireOwnedRow,
  requireStaffOfTenant,
} from "./shared.js";
import {
  deriveBudgetLines,
  parseEstimatePayload,
} from "../domain/estimateContract.js";
import { seedDrawSchedule } from "../domain/drawSchedule.js";
import { gateReadiness } from "../domain/gateReadiness.js";
import { listPreconTasks, preconCounts, seedPreconTasks } from "../domain/preconTasks.js";
import { annotateChecklist } from "./gates.js";
import {
  assertStageAdvanceAllowed,
  nextStage,
  type GateState,
  type ProjectStage,
} from "../domain/stages.js";

const createProjectSchema = z
  .object({
    project_number: z.string().min(1).max(64),
    name: z.string().min(1),
    business_unit_id: z.string().uuid().nullish(),
    estimate_import_id: z.string().uuid().nullish(),
    source_kind: z
      .enum(["journeyman_estimate", "external", "manual"])
      .nullish(),
    external_system_id: z.string().uuid().nullish(),
    external_job_id: z.string().nullish(),
    external_customer_id: z.string().nullish(),
    address_line1: z.string().min(1),
    city: z.string().min(1),
    region: z.string().min(1),
    postal_code: z.string().nullish(),
    jurisdiction_id: z.string().uuid().nullish(),
    pm_id: z.string().uuid().nullish(),
    estimator_id: z.string().uuid().nullish(),
    contract_value: z.number().positive(),
    currency: z.string().length(3).default("USD"),
    target_margin: z.number().min(0).max(1),
    // A handoff arrives with a target window, and these were accepted only on
    // PATCH. zod strips unknown keys silently, so sending them at create
    // succeeded and quietly discarded them.
    scheduled_start: z.string().date().nullish(),
    scheduled_end: z.string().date().nullish(),
    license_scope_note: z.string().nullish(),
  })
  .refine((v) => Boolean(v.estimate_import_id) || v.source_kind === "manual", {
    message:
      'Provide estimate_import_id, or source_kind "manual" to build the budget by hand',
    path: ["estimate_import_id"],
  });

const patchProjectSchema = z.object({
  name: z.string().min(1).optional(),
  business_unit_id: z.string().uuid().nullish(),
  address_line1: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  postal_code: z.string().nullish(),
  jurisdiction_id: z.string().uuid().nullish(),
  pm_id: z.string().uuid().nullish(),
  estimator_id: z.string().uuid().nullish(),
  contract_value: z.number().positive().optional(),
  target_margin: z.number().min(0).max(1).optional(),
  scheduled_start: z.string().date().nullish(),
  scheduled_end: z.string().date().nullish(),
  actual_start: z.string().date().nullish(),
  actual_end: z.string().date().nullish(),
  license_scope_note: z.string().nullish(),
});

const advanceStageSchema = z.object({
  stage: z.enum([
    "handoff",
    "precon",
    "mobilization",
    "execution",
    "closeout",
    "complete",
    "cancelled",
  ]),
});

export function projectRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  // ---------------------------------------------------------------- list ---
  router.get(
    "/projects",
    staffRoute(deps, async (ctx) => {
      const { page, perPage, offset } = parsePagination(
        ctx.req.query as Record<string, unknown>,
      );
      const scope = unitFilter(
        ctx.staff.businessUnitId,
        ctx.settings.enforceBusinessUnitScoping,
      );
      const q =
        typeof ctx.req.query.q === "string" ? ctx.req.query.q.trim() : "";

      const where = `
        WHERE ($1::text  IS NULL OR p.stage = $1::projects.project_stage)
          AND ($2::uuid  IS NULL OR p.business_unit_id = $2::uuid)
          AND ($3::uuid  IS NULL OR p.pm_id = $3::uuid)
          AND ($4::text  IS NULL OR p.name ILIKE '%'||$4||'%' OR p.project_number ILIKE '%'||$4||'%')
          AND ($5::uuid  IS NULL OR p.business_unit_id IS NULL OR p.business_unit_id = $5::uuid)`;
      const params = [
        strOrNull(ctx.req.query.stage),
        strOrNull(ctx.req.query.business_unit_id),
        strOrNull(ctx.req.query.pm_id),
        q || null,
        scope,
      ];

      const total = await ctx.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.projects p ${where}`,
        params,
      );
      const { rows } = await ctx.db.query(
        `SELECT p.id, p.project_number, p.name, p.stage, p.business_unit_id,
                p.pm_id, p.estimator_id, p.city, p.region,
                p.contract_value, p.currency, p.target_margin,
                p.scheduled_start, p.scheduled_end, p.updated_at,
                ${fieldStartColumns("p")},
                p.field_released_at, p.field_release_note,
                rel.full_name AS field_released_by_name
           FROM projects.projects p
           LEFT JOIN projects.staff rel ON rel.id = p.field_released_by
           ${where}
          ORDER BY p.created_at DESC
          LIMIT $6 OFFSET $7`,
        [...params, perPage, offset],
      );

      sendData(ctx.res, rows.map(serialiseProjectSummary), {
        page,
        per_page: perPage,
        total: Number(total.rows[0]?.n ?? 0),
      });
    }),
  );

  router.delete('/projects/:id', staffRoute(deps, async (ctx) => {
    requireCapability(ctx.staff.role, 'delete_project');
    const id = parseUuidParam(ctx.req.params.id, 'Project');
    const project = await loadVisibleProject<{project_number:string}>(ctx, id, 'project_number');
    const body = parseBody(z.object({confirm_project_number:z.string()}), ctx.req.body);
    if (body.confirm_project_number !== project.project_number)
      throw new ApiError('validation_failed', 'Type the exact project number to confirm deletion.');
    await deleteLocalProject(ctx.db, id);
    sendData(ctx.res, {id, deleted:true});
  }));

  // -------------------------------------------------------------- create ---
  router.post(
    "/projects",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "create_project");
      const body = parseBody(createProjectSchema, ctx.req.body);

      // §2.2: enforce non-null business unit at creation once scoping is on,
      // because a null unit is visible to everyone regardless of the setting.
      if (ctx.settings.enforceBusinessUnitScoping && !body.business_unit_id) {
        throw new ApiError(
          "validation_failed",
          "This account scopes projects by business unit, so business_unit_id is required.",
          [
            {
              field: "business_unit_id",
              message: "Required while unit scoping is enabled",
            },
          ],
        );
      }
      assertUnitWritable(ctx, body.business_unit_id ?? null);
      await assertReferencesBelongHere(ctx, body);

      const project = await createProject(ctx, body);
      sendData(ctx.res, project, undefined, 201);
    }),
  );

  // -------------------------------------------------------------- detail ---
  router.get(
    "/projects/:id",
    staffRoute(deps, async (ctx) => {
      const id = parseUuidParam(ctx.req.params.id, "Project");
      const project = await loadVisibleProject<Record<string, unknown>>(
        ctx,
        id,
      );

      // Names for the ids the detail view shows. Two small lookups rather than
      // a join in loadVisibleProject, which every other route also calls and
      // none of the others needs these.
      const people = await ctx.db.query<{ id: string; full_name: string }>(
        `SELECT id, full_name FROM projects.staff WHERE id = ANY($1::uuid[])`,
        [[project.pm_id, project.estimator_id].filter(Boolean)],
      );
      const nameOf = (staffId: unknown) =>
        people.rows.find((p) => p.id === staffId)?.full_name ?? null;

      // Joined to the template for approver_role and freezes_baseline. Without
      // them the caller cannot tell who is allowed to approve a gate, and a
      // console that guesses "owner" is a console that hides the button from
      // the manager whose job it actually is.
      const gates = await ctx.db.query(
        `SELECT g.gate_number, g.title, g.status::text AS status, g.checklist,
                g.approved_by, g.approved_at, g.rejected_note,
                gt.approver_role::text AS approver_role, gt.freezes_baseline
           FROM projects.stage_gates g
           LEFT JOIN projects.gate_templates gt
                  ON gt.tenant_id = g.tenant_id AND gt.gate_number = g.gate_number
          WHERE g.project_id = $1 ORDER BY g.gate_number`,
        [id],
      );
      const ready = await gateReadiness(ctx.db, id);
      const draws = await ctx.db.query<{
        status: string;
        n: string;
        amount: string | null;
      }>(
        `SELECT status::text AS status, count(*)::text AS n, sum(amount)::text AS amount
           FROM projects.draws WHERE project_id = $1 GROUP BY status`,
        [id],
      );
      const permits = await ctx.db.query<{
        permit_id: string;
        permit_type: string;
        permit_number: string | null;
        issued_on: string | null;
        not_required: boolean;
        open_milestones: string;
        overdue_milestones: string;
      }>(
        `SELECT pr.id AS permit_id, pr.permit_type, pr.permit_number, pr.issued_on,
                pr.not_required,
                count(*) FILTER (WHERE pm.status IN ('pending','in_progress'))::text
                  AS open_milestones,
                count(*) FILTER (WHERE pm.status IN ('pending','in_progress')
                                   AND pm.due_on IS NOT NULL
                                   AND pm.due_on < CURRENT_DATE)::text
                  AS overdue_milestones
           FROM projects.permits pr
           LEFT JOIN projects.permit_milestones pm ON pm.permit_id = pr.id
          WHERE pr.project_id = $1
          GROUP BY pr.id`,
        [id],
      );

      sendData(ctx.res, {
        ...(await projectPayload(ctx.db, id, project, true)),

        pm_name: nameOf(project.pm_id),
        estimator_name: nameOf(project.estimator_id),
        gates: gates.rows.map((row) => ({
          ...row,
          checklist: annotateChecklist(
            (row as { checklist: unknown }).checklist,
            ready,
          ),
        })),
        draw_summary: draws.rows.map((d) => ({
          status: d.status,
          count: Number(d.n),
          amount: num(d.amount) ?? 0,
        })),
        permit_summary: permits.rows.map((p) => ({
          permit_id: p.permit_id,
          permit_type: p.permit_type,
          permit_number: p.permit_number,
          issued_on: p.issued_on,
          not_required: p.not_required,
          open_milestones: Number(p.open_milestones),
          overdue_milestones: Number(p.overdue_milestones),
        })),
      });
    }),
  );

  // --------------------------------------------------------------- patch ---
  router.patch(
    "/projects/:id",
    staffRoute(deps, async (ctx) => {
      const id = parseUuidParam(ctx.req.params.id, "Project");
      const body = parseBody(patchProjectSchema, ctx.req.body);
      const current = await loadVisibleProject<{
        id: string;
        business_unit_id: string | null;
        target_margin: string;
      }>(ctx, id, "id, business_unit_id, target_margin");

      requireCapability(ctx.staff.role, "edit_budget_before_freeze");
      const connected = await ctx.db.query(
        "SELECT project_id FROM projects.st_project_connections WHERE project_id=$1",
        [id],
      );
      // scheduled_start is the logged start and stays editable here.
      // scheduled_end still follows ServiceTitan.
      if (
        connected.rows.length &&
        [
          "project_number",
          "name",
          "address_line1",
          "city",
          "region",
          "postal_code",
          "scheduled_end",
          "actual_end",
          "external_system_id",
          "external_customer_id",
          "external_job_id",
        ].some((k) => Object.hasOwn(ctx.req.body, k))
      )
        throw new ApiError(
          "conflict",
          "Edit project identity, address and source dates in ServiceTitan, then refresh this project.",
        );
      if (body.business_unit_id !== undefined) {
        assertUnitWritable(ctx, body.business_unit_id ?? null);
        if (
          ctx.settings.enforceBusinessUnitScoping &&
          body.business_unit_id === null
        ) {
          throw new ApiError(
            "validation_failed",
            "business_unit_id cannot be cleared while unit scoping is enabled.",
            [
              {
                field: "business_unit_id",
                message: "Required while unit scoping is enabled",
              },
            ],
          );
        }
      }
      await assertReferencesBelongHere(ctx, body);

      // target_margin is immutable after gate 0 approval (§3.1). The number the
      // job was accepted against stops being editable once someone signed off
      // on the handoff, otherwise a project retroactively "hits" its margin.
      if (
        body.target_margin !== undefined &&
        body.target_margin !== num(current.target_margin)
      ) {
        const gate0 = await ctx.db.query<{ status: string }>(
          `SELECT status::text AS status FROM projects.stage_gates
            WHERE project_id = $1 AND gate_number = 0`,
          [id],
        );
        if (gate0.rows[0]?.status === "approved") {
          throw new ApiError(
            "conflict",
            "target_margin cannot change after gate 0 has been approved.",
            { gate_number: 0 },
          );
        }
      }

      const assignable = {
        name: body.name,
        business_unit_id: body.business_unit_id,
        address_line1: body.address_line1,
        city: body.city,
        region: body.region,
        postal_code: body.postal_code,
        jurisdiction_id: body.jurisdiction_id,
        pm_id: body.pm_id,
        estimator_id: body.estimator_id,
        contract_value: body.contract_value,
        target_margin: body.target_margin,
        scheduled_start: body.scheduled_start,
        scheduled_end: body.scheduled_end,
        actual_start: body.actual_start,
        actual_end: body.actual_end,
        license_scope_note: body.license_scope_note,
      };
      const entries = Object.entries(assignable).filter(
        ([, v]) => v !== undefined,
      );
      if (entries.length === 0) {
        const unchanged = await loadVisibleProject<Record<string, unknown>>(
          ctx,
          id,
        );
        sendData(ctx.res, await projectPayload(ctx.db, id, unchanged));
        return;
      }

      const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(", ");
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.projects SET ${sets} WHERE id = $1 RETURNING *`,
        [id, ...entries.map(([, v]) => v)],
      );
      if (!rows[0]) throw notFound("Project not found");
      sendData(ctx.res, await projectPayload(ctx.db, id, rows[0]));
    }),
  );

  // --------------------------------------------------------- field start ---
  router.put(
    "/projects/:id/field-start",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "set_field_start");
      const id = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, id, "id");
      const body = parseBody(
        z.object({ date: z.string().date().nullable() }).strict(),
        ctx.req.body,
      );
      if (body.date === null) {
        await ctx.db.query(
          `UPDATE projects.projects
              SET field_start = NULL,
                  field_start_source = NULL,
                  field_start_appointment_id = NULL,
                  field_start_observed_at = NULL,
                  field_start_set_by = NULL
            WHERE id = $1`,
          [id],
        );
      } else {
        await ctx.db.query(
          `UPDATE projects.projects
              SET field_start = $2,
                  field_start_source = 'manual',
                  field_start_appointment_id = NULL,
                  field_start_observed_at = now(),
                  field_start_set_by = $3
            WHERE id = $1`,
          [id, body.date, ctx.staff.staffId],
        );
      }
      const row = await loadVisibleProject<Record<string, unknown>>(ctx, id);
      sendData(ctx.res, { field_start: presentFieldStart(row) });
    }),
  );

  // ------------------------------------------------------- cost position ---
  router.get(
    "/projects/:id/cost-position",
    staffRoute(deps, async (ctx) => {
      const id = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, id, "id");
      // Ordered by the cost code list's own sort_order, not by the code
      // string. Codes are text, so ordering by them puts 1030 and 1110 ahead
      // of 110 and 210 — the divisions interleave and the sheet stops reading
      // like a estimate. v_cost_position does not carry sort_order, hence the
      // join back to cost_codes, which RLS has already scoped to this tenant.
      // Unbudgeted labor carries its cost code. The join stays a left join
      // and that row sorts last. Its description is exactly "Unbudgeted labor".
      const { rows } = await ctx.db.query(
        `SELECT v.cost_code, v.description, v.cost_type::text AS cost_type,
                v.baseline, v.budget_amount, v.actual_cost, v.committed_open,
                v.total_committed, v.variance, v.labor_wage, v.labor_burden
           FROM projects.v_cost_position v
           LEFT JOIN projects.cost_codes cc ON cc.code = v.cost_code
          WHERE v.project_id = $1
          ORDER BY cc.sort_order NULLS LAST, v.cost_code NULLS LAST`,
        [id],
      );
      sendData(
        ctx.res,
        rows.map((r) => ({
          ...r,
          baseline: num(r.baseline),
          budget_amount: num(r.budget_amount),
          actual_cost: num(r.actual_cost),
          committed_open: num(r.committed_open),
          total_committed: num(r.total_committed),
          variance: num(r.variance),
          labor_wage: num(r.labor_wage),
          labor_burden: num(r.labor_burden),
        })),
      );
    }),
  );

  // -------------------------------------------------------------- margin ---
  router.get(
    "/projects/:id/margin",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "view_margin");
      const id = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, id, "id");
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT project_number, name, currency, revised_contract, target_margin,
                committed_cost, unspent_baseline, projected_cost
           FROM projects.v_project_margin WHERE project_id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) {
        // v_project_margin inner-joins cost position, so a project with no
        // budget lines yet has no row. That is "no budget", not "no project".
        sendData(ctx.res, {
          project_id: id,
          has_budget: false,
          message:
            "This project has no budget lines yet, so margin cannot be projected.",
        });
        return;
      }
      const revised = num(row.revised_contract) ?? 0;
      const projected = num(row.projected_cost) ?? 0;
      sendData(ctx.res, {
        project_id: id,
        has_budget: true,
        project_number: row.project_number,
        name: row.name,
        currency: row.currency,
        revised_contract: revised,
        target_margin: num(row.target_margin),
        committed_cost: num(row.committed_cost),
        unspent_baseline: num(row.unspent_baseline),
        projected_cost: projected,
        projected_margin:
          revised > 0 ? round4((revised - projected) / revised) : null,
      });
    }),
  );

  // --------------------------------------------------------------- stage ---
  router.post(
    "/projects/:id/stage",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "advance_stage");
      const id = parseUuidParam(ctx.req.params.id, "Project");
      const { stage } = parseBody(advanceStageSchema, ctx.req.body);
      const project = await loadVisibleProject<{
        id: string;
        stage: ProjectStage;
      }>(ctx, id, "id, stage");

      const gates = await ctx.db.query<GateState>(
        `SELECT gate_number, title, status::text AS status
           FROM projects.stage_gates WHERE project_id = $1 ORDER BY gate_number`,
        [id],
      );
      assertStageAdvanceAllowed(project.stage, stage, gates.rows);

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.projects SET stage = $2 WHERE id = $1 RETURNING *`,
        [id, stage],
      );
      sendData(ctx.res, {
        ...(await projectPayload(ctx.db, id, rows[0]!)),
        next_stage: nextStage(stage),
      });
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------

/**
 * Every id a project body may carry has to name a row in this tenant.
 *
 * None of these foreign keys carries tenant_id — the schema deliberately keys
 * on id alone — so without this a project in tenant A can be created pointing
 * at tenant B's business unit, jurisdiction, or external system. The pointer
 * is unreadable across the boundary thanks to RLS, but writing it is still a
 * cross-tenant reference, and it is exactly the kind of row that makes some
 * later report join through and find nothing, or worse, find something.
 */
async function assertReferencesBelongHere(
  ctx: StaffContext,
  body: {
    pm_id?: string | null;
    estimator_id?: string | null;
    business_unit_id?: string | null;
    jurisdiction_id?: string | null;
    external_system_id?: string | null;
  },
): Promise<void> {
  await requireStaffOfTenant(ctx.db, body.pm_id, "pm_id");
  await requireStaffOfTenant(ctx.db, body.estimator_id, "estimator_id");
  await requireOwnedRow(
    ctx.db,
    "business_units",
    body.business_unit_id,
    "business_unit_id",
  );
  await requireOwnedRow(
    ctx.db,
    "jurisdictions",
    body.jurisdiction_id,
    "jurisdiction_id",
  );
  await requireOwnedRow(
    ctx.db,
    "external_systems",
    body.external_system_id,
    "external_system_id",
  );
}

type CreateBody = z.infer<typeof createProjectSchema>;

/**
 * One transaction, already open — the request's. A project that exists without
 * its gates is worse than no project (§3.1), so nothing here is deferred to a
 * follow-up call or a background job.
 */
export async function createProject(
  ctx: StaffContext,
  body: Omit<CreateBody, "contract_value" | "target_margin"> & {
    contract_value: number | null;
    target_margin: number | null;
  },
) {
  const { rows } = await ctx.db.query<Record<string, unknown>>(
    `INSERT INTO projects.projects
       (tenant_id, project_number, business_unit_id, external_system_id, external_job_id,
        external_customer_id, estimate_import_id, name, address_line1, city, region,
        postal_code, jurisdiction_id, pm_id, estimator_id, contract_value, currency,
        target_margin, license_scope_note, scheduled_start, scheduled_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
             CASE WHEN $22::boolean THEN (now() AT TIME ZONE 'America/New_York')::date ELSE $20::date END,
             $21)
     RETURNING *`,
    [
      ctx.staff.tenantId,
      body.project_number,
      body.business_unit_id ?? null,
      body.external_system_id ?? null,
      body.external_job_id ?? null,
      body.external_customer_id ?? null,
      body.estimate_import_id ?? null,
      body.name,
      body.address_line1,
      body.city,
      body.region,
      body.postal_code ?? null,
      body.jurisdiction_id ?? null,
      body.pm_id ?? null,
      body.estimator_id ?? null,
      body.contract_value,
      body.currency,
      body.target_margin,
      body.license_scope_note ?? null,
      body.scheduled_start ?? null,
      body.scheduled_end ?? null,
      body.scheduled_start === undefined,
    ],
  );
  const project = rows[0]!;
  const projectId = project.id as string;

  // Gates from the tenant's templates. Count and content are tenant
  // configuration; five gates is the shipped default, not a constraint.
  const gates = await ctx.db.query<{ n: string }>(
    `INSERT INTO projects.stage_gates (tenant_id, project_id, gate_number, title, checklist)
     SELECT gt.tenant_id, $1, gt.gate_number, gt.title, gt.checklist
       FROM projects.gate_templates gt
      WHERE gt.tenant_id = $2
      ORDER BY gt.gate_number
     RETURNING 1 AS n`,
    [projectId, ctx.staff.tenantId],
  );

  let budgetLineCount = 0;
  if (body.estimate_import_id) {
    const imported = await ctx.db.query<{
      contract_version: string;
      payload: unknown;
    }>(
      `SELECT contract_version, payload FROM projects.estimate_imports WHERE id = $1`,
      [body.estimate_import_id],
    );
    const row = imported.rows[0];
    // RLS already scoped this to the tenant, so a missing row is either a bad
    // id or another tenant's import. Both are not_found.
    if (!row) throw notFound("Estimate import not found");

    const payload = parseEstimatePayload(row.contract_version, row.payload);
    const lines = await deriveBudgetLines(ctx.db, payload);
    for (const line of lines) {
      await ctx.db.query(
        `INSERT INTO projects.budget_lines
           (tenant_id, project_id, cost_code_id, cost_type, budget_amount, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          ctx.staff.tenantId,
          projectId,
          line.costCodeId,
          line.costType,
          line.amount,
          line.note,
        ],
      );
    }
    budgetLineCount = lines.length;
  }

  // §3.1: create also seeds "a draw schedule from the tenant default".
  // draw_templates carries it — 30/30/30/10 with the last as retainage on the
  // shipped default, per tenant and editable. Seeds nothing if the account has
  // no template, rather than inventing a schedule.
  const drawsCreated =
    body.contract_value === null
      ? 0
      : await seedDrawSchedule(
          ctx.db,
          ctx.staff.tenantId,
          projectId,
          body.contract_value,
        );

  const tasksCreated = await seedPreconTasks(
    ctx.db,
    ctx.staff.tenantId,
    projectId,
    (project.scheduled_start as string | null) ?? null,
  );

  return {
    ...(await projectPayload(ctx.db, projectId, project)),
    id: projectId,
    gates_created: gates.rowCount || gates.rows.length,
    budget_lines_created: budgetLineCount,
    draws_created: drawsCreated,
    tasks_created: tasksCreated,
  };
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function serialiseProjectSummary(row: Record<string, unknown>) {
  return serialiseProject(row);
}

function serialiseProject(row: Record<string, unknown>) {
  const rest = { ...row };
  const releasedAt = rest.field_released_at;
  const note = rest.field_release_note;
  const releasedByName = rest.field_released_by_name;
  delete rest.field_released_by;
  delete rest.field_released_at;
  delete rest.field_release_note;
  delete rest.field_released_by_name;
  const fieldStart = presentFieldStart(rest);
  delete rest.field_start;
  delete rest.field_start_source;
  delete rest.field_start_appointment_id;
  delete rest.field_start_observed_at;
  delete rest.field_start_set_by;
  const precon = preconCountsFromRow(rest);
  delete rest.precon_open;
  delete rest.precon_overdue;
  return {
    ...rest,
    contract_value: num(row.contract_value),
    target_margin: num(row.target_margin),
    field_release: presentFieldRelease({
      released_at: releasedAt,
      released_by: typeof releasedByName === 'string' ? releasedByName : null,
      note,
    }),
    field_start: fieldStart,
    ...(precon ? { precon } : {}),
  };
}

async function projectPayload(
  db: SqlClient,
  projectId: string,
  row: Record<string, unknown>,
  withHistory = false,
) {
  const base = serialiseProject(row);
  const counts =
    base.precon ?? (await preconCounts(db, projectId));
  return {
    ...base,
    field_release: await readFieldRelease(db, projectId, withHistory),
    precon: {
      open: counts.open,
      overdue: counts.overdue,
      tasks: await listPreconTasks(db, projectId),
    },
  };
}
