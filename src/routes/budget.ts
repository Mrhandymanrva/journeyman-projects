import { Router } from 'express';
import { z } from 'zod';
import { sendData } from '../http/envelope.js';
import { notFound } from '../http/errors.js';
import { requireCapability } from '../http/capabilities.js';
import { staffRoute, type StaffRouterDeps } from '../http/staffSession.js';
import {
  loadVisibleProject,
  num,
  parseBody,
  parseUuidParam,
  requireOwnedRow,
} from './shared.js';
import { assertBaselineNotFrozen, freezeState } from '../domain/baseline.js';
import { toCsv } from '../http/csv.js';

const budgetLineSchema = z.object({
  cost_code_id: z.string().uuid(),
  cost_type: z.enum(['L', 'M', 'S', 'O']),
  budget_amount: z.number().min(0),
  note: z.string().nullish(),
});

const budgetPatchSchema = z.object({
  budget_amount: z.number().min(0).optional(),
  note: z.string().nullish(),
});

export function budgetRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    '/projects/:id/budget',
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');

      const freeze = await freezeState(ctx.db, projectId);
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT b.id, b.cost_code_id, cc.code, cc.description, cc.division_name,
                b.cost_type::text AS cost_type, b.budget_amount, b.baseline_amount, b.note
           FROM projects.budget_lines b
           JOIN projects.cost_codes cc ON cc.id = b.cost_code_id
          WHERE b.project_id = $1
          ORDER BY cc.sort_order, cc.code`,
        [projectId],
      );

      sendData(ctx.res, {
        baseline_frozen: freeze.frozen,
        frozen_by_gate: freeze.gateNumber,
        frozen_at: freeze.approvedAt,
        lines: rows.map((r) => ({
          ...r,
          budget_amount: num(r.budget_amount),
          baseline_amount: num(r.baseline_amount),
        })),
      });
    }),
  );

  router.post(
    '/projects/:id/budget',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'edit_budget_before_freeze');
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
      const body = parseBody(budgetLineSchema, ctx.req.body);

      // Adding a line after the freeze is blocked, not just editing one. A new
      // line would have a null baseline_amount, and v_cost_position falls back
      // to budget_amount when baseline is null — so an unblocked add becomes
      // its own baseline and the variance it should have produced is zero.
      await assertBaselineNotFrozen(ctx.db, projectId);
      await requireOwnedRow(ctx.db, 'cost_codes', body.cost_code_id, 'cost_code_id', 'AND active');

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `INSERT INTO projects.budget_lines
           (tenant_id, project_id, cost_code_id, cost_type, budget_amount, note)
         VALUES ($1,$2,$3,$4::projects.cost_type,$5,$6)
         RETURNING id, cost_code_id, cost_type::text AS cost_type, budget_amount,
                   baseline_amount, note`,
        [
          ctx.staff.tenantId,
          projectId,
          body.cost_code_id,
          body.cost_type,
          body.budget_amount,
          body.note ?? null,
        ],
      );
      sendData(
        ctx.res,
        { ...rows[0], budget_amount: num(rows[0]!.budget_amount) },
        undefined,
        201,
      );
    }),
  );

  router.patch(
    '/projects/:id/budget/:lineId',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'edit_budget_before_freeze');
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      const lineId = parseUuidParam(ctx.req.params.lineId, 'Budget line');
      await loadVisibleProject(ctx, projectId, 'id');
      const body = parseBody(budgetPatchSchema, ctx.req.body);

      await assertBaselineNotFrozen(ctx.db, projectId);

      const entries = Object.entries({
        budget_amount: body.budget_amount,
        note: body.note,
      }).filter(([, v]) => v !== undefined);

      if (entries.length === 0) {
        const { rows } = await ctx.db.query<Record<string, unknown>>(
          `SELECT id, cost_code_id, cost_type::text AS cost_type, budget_amount,
                  baseline_amount, note
             FROM projects.budget_lines WHERE id = $1 AND project_id = $2`,
          [lineId, projectId],
        );
        if (!rows[0]) throw notFound('Budget line not found');
        sendData(ctx.res, { ...rows[0], budget_amount: num(rows[0].budget_amount) });
        return;
      }

      const sets = entries.map(([k], i) => `${k} = $${i + 3}`).join(', ');
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.budget_lines SET ${sets}
          WHERE id = $1 AND project_id = $2
          RETURNING id, cost_code_id, cost_type::text AS cost_type, budget_amount,
                    baseline_amount, note`,
        [lineId, projectId, ...entries.map(([, v]) => v)],
      );
      if (!rows[0]) throw notFound('Budget line not found');
      sendData(ctx.res, { ...rows[0], budget_amount: num(rows[0].budget_amount) });
    }),
  );

  // ---------------------------------------------------------- exceptions ---
  router.get(
    '/projects/:id/exceptions',
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');

      const [budget, permits, draws, logs] = await Promise.all([
        ctx.db.query(
          `SELECT cost_code, description, baseline, total_committed, variance, pct_over
             FROM projects.v_budget_exceptions WHERE project_id = $1 ORDER BY pct_over DESC`,
          [projectId],
        ),
        ctx.db.query(
          `SELECT id, jurisdiction, milestone, due_on, days_overdue
             FROM projects.v_permit_exceptions WHERE project_id = $1 ORDER BY days_overdue DESC`,
          [projectId],
        ),
        ctx.db.query(
          `SELECT draw_id, label, amount, approved_at, days_since_approval
             FROM projects.v_draw_exceptions WHERE project_id = $1
            ORDER BY days_since_approval DESC`,
          [projectId],
        ),
        ctx.db.query(
          `SELECT project_id, project_number, pm_id
             FROM projects.v_missing_daily_logs WHERE project_id = $1`,
          [projectId],
        ),
      ]);

      sendData(ctx.res, {
        budget: budget.rows.map((r: Record<string, unknown>) => ({
          ...r,
          baseline: num(r.baseline),
          total_committed: num(r.total_committed),
          variance: num(r.variance),
          pct_over: num(r.pct_over),
        })),
        permits: permits.rows,
        draws: draws.rows.map((r: Record<string, unknown>) => ({ ...r, amount: num(r.amount) })),
        // A view row means yesterday's log is missing. Reported as a boolean
        // rather than a list of one, because that is the question being asked.
        missing_daily_log: logs.rows.length > 0,
      });
    }),
  );

  // -------------------------------------------------------------- exports ---
  router.get(
    '/projects/:id/export/cost',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'export_cost_data');
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      const project = await loadVisibleProject<{ project_number: string }>(
        ctx,
        projectId,
        'project_number',
      );

      // Division order, as in GET /cost-position — see the note there.
      // The left join keeps the Unbudgeted labor row, which has no cost code.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT v.cost_code, v.description, v.cost_type::text AS cost_type,
                v.baseline, v.budget_amount, v.actual_cost, v.committed_open,
                v.total_committed, v.variance
           FROM projects.v_cost_position v
           LEFT JOIN projects.cost_codes cc ON cc.code = v.cost_code
          WHERE v.project_id = $1
          ORDER BY cc.sort_order NULLS LAST, v.cost_code NULLS LAST`,
        [projectId],
      );

      const csv = toCsv(
        [
          'cost_code',
          'description',
          'cost_type',
          'baseline',
          'budget_amount',
          'actual_cost',
          'committed_open',
          'total_committed',
          'variance',
        ],
        rows,
      );
      ctx.res
        .status(200)
        .type('text/csv')
        .setHeader(
          'Content-Disposition',
          `attachment; filename="cost-position-${project.project_number}.csv"`,
        );
      ctx.res.send(csv);
    }),
  );

  router.get(
    '/export/vendor-bills',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'export_cost_data');

      // The accounting handoff. Grouped by the ledger label so a bookkeeper can
      // enter it, and nothing here posts to a ledger — the module never writes
      // to an external system in any configuration.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT vb.id, p.project_number, p.name AS project_name,
                cc.ledger_account, cc.code AS cost_code, cc.description AS cost_code_description,
                po.po_number, COALESCE(v.legal_name, po.supplier_name) AS vendor,
                vb.vendor_invoice_number, vb.amount, vb.retention_held,
                vb.status::text AS status, vb.received_at, vb.approved_at, vb.paid_at,
                vb.exported_at
           FROM projects.vendor_bills vb
           JOIN projects.purchase_orders po ON po.id = vb.po_id
           JOIN projects.projects p         ON p.id  = po.project_id
           JOIN projects.cost_codes cc      ON cc.id = po.cost_code_id
           LEFT JOIN projects.vendors v     ON v.id  = po.vendor_id
          WHERE vb.status IN ('approved','paid')
          ORDER BY cc.ledger_account, p.project_number, vb.received_at`,
      );

      const csv = toCsv(
        [
          'ledger_account',
          'project_number',
          'project_name',
          'cost_code',
          'cost_code_description',
          'po_number',
          'vendor',
          'vendor_invoice_number',
          'amount',
          'retention_held',
          'status',
          'received_at',
          'approved_at',
          'paid_at',
        ],
        rows,
      );
      ctx.res
        .status(200)
        .type('text/csv')
        .setHeader('Content-Disposition', 'attachment; filename="vendor-bills.csv"');
      ctx.res.send(csv);
    }),
  );

  return router;
}
