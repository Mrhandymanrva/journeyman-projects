import type { SqlClient } from '../db/database.js';
import { ApiError } from '../http/errors.js';

export interface FreezeState {
  frozen: boolean;
  gateNumber: number | null;
  gateTitle: string | null;
  approvedAt: string | null;
}

/**
 * Is this project's budget baseline frozen?
 *
 * The condition is "a gate whose template says freezes_baseline has been
 * approved" — not "budget lines have a baseline_amount". Those look equivalent
 * and are not: the trigger only stamps lines that existed at approval time, so
 * a line added afterwards has a null baseline and would read as unfrozen. That
 * is the exact case the freeze exists to prevent, so it must not be the case
 * that slips through the check.
 *
 * Which gate freezes is tenant configuration, so this reads the template rather
 * than assuming gate 1.
 */
export async function freezeState(db: SqlClient, projectId: string): Promise<FreezeState> {
  const { rows } = await db.query<{
    gate_number: number;
    title: string;
    approved_at: string | null;
  }>(
    `SELECT g.gate_number, g.title, g.approved_at
       FROM projects.stage_gates g
       JOIN projects.gate_templates gt
         ON gt.tenant_id = g.tenant_id AND gt.gate_number = g.gate_number
      WHERE g.project_id = $1
        AND gt.freezes_baseline
        AND g.status = 'approved'
      ORDER BY g.gate_number
      LIMIT 1`,
    [projectId],
  );
  const row = rows[0];
  return {
    frozen: Boolean(row),
    gateNumber: row?.gate_number ?? null,
    gateTitle: row?.title ?? null,
    approvedAt: row?.approved_at ?? null,
  };
}

export async function assertBaselineNotFrozen(db: SqlClient, projectId: string): Promise<void> {
  const state = await freezeState(db, projectId);
  if (!state.frozen) return;
  throw new ApiError(
    'baseline_frozen',
    `The budget was frozen when gate ${state.gateNumber} (${state.gateTitle}) was approved. ` +
      `Changes after the freeze belong on a change order.`,
    {
      gate_number: state.gateNumber,
      approved_at: state.approvedAt,
    },
  );
}
