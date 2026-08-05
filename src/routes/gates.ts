import { Router } from 'express';
import { z } from 'zod';
import { sendData } from '../http/envelope.js';
import { ApiError, notFound } from '../http/errors.js';
import { staffRoute, type StaffContext, type StaffRouterDeps } from '../http/staffSession.js';
import { loadVisibleProject, parseBody, parseUuidParam } from './shared.js';
import type { StaffRole } from '../http/capabilities.js';

/**
 * A checklist item. Tenants author these on gate_templates.checklist; the
 * project's copy carries the answers. `key` is what a PATCH addresses, so it
 * has to survive a template edit — label changes are cosmetic, key changes are
 * not, and that is worth saying somewhere the next person will read it.
 */
export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  done_by?: string | null;
  done_at?: string | null;
}

const checklistPatchSchema = z.object({
  key: z.string().min(1),
  done: z.boolean(),
});

const rejectSchema = z.object({
  // Required, and required to say something. A rejection with an empty note is
  // a gate that reopens with no record of why it closed.
  note: z.string().trim().min(1, 'A rejection note is required'),
});

export function gateRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    '/projects/:id/gates',
    staffRoute(deps, async (ctx) => {
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT g.id, g.gate_number, g.title, g.status::text AS status, g.checklist,
                g.approved_by, g.approved_at, g.rejected_note,
                gt.approver_role::text AS approver_role,
                gt.freezes_baseline
           FROM projects.stage_gates g
           LEFT JOIN projects.gate_templates gt
                  ON gt.tenant_id = g.tenant_id AND gt.gate_number = g.gate_number
          WHERE g.project_id = $1
          ORDER BY g.gate_number`,
        [projectId],
      );
      sendData(
        ctx.res,
        rows.map((row) => ({
          ...row,
          checklist: normaliseChecklist(row.checklist),
        })),
      );
    }),
  );

  router.patch(
    '/projects/:id/gates/:n/checklist',
    staffRoute(deps, async (ctx) => {
      const { projectId, gate } = await loadGate(ctx);
      const body = parseBody(checklistPatchSchema, ctx.req.body);

      if (gate.status === 'approved') {
        throw new ApiError(
          'conflict',
          'This gate is approved. Reopen it by rejecting it before editing the checklist.',
          { gate_number: gate.gate_number },
        );
      }

      const checklist = normaliseChecklist(gate.checklist);
      const item = checklist.find((i) => i.key === body.key);
      if (!item) {
        throw notFound(`Checklist item ${body.key} not found on gate ${gate.gate_number}`);
      }
      item.done = body.done;
      item.done_by = body.done ? ctx.staff.staffId : null;
      item.done_at = body.done ? new Date().toISOString() : null;

      const { rows } = await ctx.db.query<{ checklist: unknown }>(
        `UPDATE projects.stage_gates SET checklist = $3::jsonb
          WHERE project_id = $1 AND gate_number = $2
          RETURNING checklist`,
        [projectId, gate.gate_number, JSON.stringify(checklist)],
      );
      sendData(ctx.res, {
        gate_number: gate.gate_number,
        checklist: normaliseChecklist(rows[0]?.checklist),
      });
    }),
  );

  router.post(
    '/projects/:id/gates/:n/approve',
    staffRoute(deps, async (ctx) => {
      const { projectId, gate } = await loadGate(ctx);
      assertApprover(ctx.staff.role, gate.approver_role, gate.gate_number);

      const outstanding = normaliseChecklist(gate.checklist).filter((i) => !i.done);
      if (outstanding.length > 0) {
        throw new ApiError(
          'gate_not_satisfied',
          `Gate ${gate.gate_number} has ${outstanding.length} checklist item(s) outstanding.`,
          { items: outstanding.map((i) => ({ key: i.key, label: i.label })) },
        );
      }

      // Approving the gate flagged freezes_baseline copies budget_amount to
      // baseline_amount — via the database trigger, deliberately not here.
      // Two implementations of a freeze is one implementation that is wrong.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.stage_gates
            SET status = 'approved', approved_by = $3, approved_at = now(), rejected_note = NULL
          WHERE project_id = $1 AND gate_number = $2
          RETURNING id, gate_number, title, status::text AS status,
                    approved_by, approved_at`,
        [projectId, gate.gate_number, ctx.staff.staffId],
      );

      const frozen = await ctx.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.budget_lines
          WHERE project_id = $1 AND baseline_amount IS NOT NULL`,
        [projectId],
      );

      sendData(ctx.res, {
        ...rows[0],
        freezes_baseline: gate.freezes_baseline,
        baseline_lines: Number(frozen.rows[0]?.n ?? 0),
      });
    }),
  );

  router.post(
    '/projects/:id/gates/:n/reject',
    staffRoute(deps, async (ctx) => {
      const { projectId, gate } = await loadGate(ctx);
      assertApprover(ctx.staff.role, gate.approver_role, gate.gate_number);
      const { note } = parseBody(rejectSchema, ctx.req.body);

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.stage_gates
            SET status = 'rejected', rejected_note = $3,
                approved_by = NULL, approved_at = NULL
          WHERE project_id = $1 AND gate_number = $2
          RETURNING id, gate_number, title, status::text AS status, rejected_note`,
        [projectId, gate.gate_number, note],
      );
      // Note what this does NOT do: a baseline already frozen by an earlier
      // approval stays frozen. Un-freezing a baseline because a gate was
      // reopened would let a project quietly re-baseline against its overrun.
      sendData(ctx.res, rows[0]);
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------

interface GateRow {
  gate_number: number;
  title: string;
  status: string;
  checklist: unknown;
  approver_role: StaffRole | null;
  freezes_baseline: boolean | null;
}

async function loadGate(ctx: StaffContext): Promise<{ projectId: string; gate: GateRow }> {
  const projectId = parseUuidParam(ctx.req.params.id, 'Project');
  await loadVisibleProject(ctx, projectId, 'id');

  const raw = ctx.req.params.n;
  const gateNumber = Number(raw);
  if (!/^\d+$/.test(raw ?? '') || !Number.isInteger(gateNumber)) {
    throw notFound('Gate not found');
  }

  const { rows } = await ctx.db.query<GateRow>(
    `SELECT g.gate_number, g.title, g.status::text AS status, g.checklist,
            gt.approver_role::text AS approver_role, gt.freezes_baseline
       FROM projects.stage_gates g
       LEFT JOIN projects.gate_templates gt
              ON gt.tenant_id = g.tenant_id AND gt.gate_number = g.gate_number
      WHERE g.project_id = $1 AND g.gate_number = $2`,
    [projectId, gateNumber],
  );
  const gate = rows[0];
  if (!gate) throw notFound('Gate not found');
  return { projectId, gate };
}

/**
 * The approver is not a hardcoded role. It comes from
 * gate_templates.approver_role for that tenant and gate number, because a
 * tenant may assign preconstruction to a project_manager where the shipped
 * default gives it to a manager (§2.1).
 *
 * Owner is allowed unconditionally. If the template row is missing — the gate
 * was created and the template later deleted — nobody but owner can approve,
 * which fails closed rather than falling back to "anyone".
 */
function assertApprover(role: StaffRole, approverRole: StaffRole | null, gateNumber: number): void {
  if (role === 'owner') return;
  if (approverRole && role === approverRole) return;
  throw new ApiError(
    'forbidden',
    approverRole
      ? `Gate ${gateNumber} is approved by ${approverRole}, not ${role}.`
      : `Gate ${gateNumber} has no approver role configured; only an owner can act on it.`,
    { gate_number: gateNumber, approver_role: approverRole, role },
  );
}

export function normaliseChecklist(value: unknown): ChecklistItem[] {
  const raw =
    typeof value === 'string'
      ? (safeParse(value) ?? [])
      : Array.isArray(value)
        ? value
        : [];
  return raw.map((entry, index): ChecklistItem => {
    // Tenants author these by hand. A bare string is the shape people
    // actually write, so accept it rather than reject a whole template.
    if (typeof entry === 'string') {
      return { key: `item_${index + 1}`, label: entry, done: false };
    }
    const obj = (entry ?? {}) as Record<string, unknown>;
    return {
      key: typeof obj.key === 'string' && obj.key ? obj.key : `item_${index + 1}`,
      label: typeof obj.label === 'string' ? obj.label : String(obj.key ?? `Item ${index + 1}`),
      done: obj.done === true,
      done_by: typeof obj.done_by === 'string' ? obj.done_by : null,
      done_at: typeof obj.done_at === 'string' ? obj.done_at : null,
    };
  });
}

function safeParse(value: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
