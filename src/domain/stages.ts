import { ApiError } from '../http/errors.js';

export type ProjectStage =
  | 'handoff'
  | 'precon'
  | 'mobilization'
  | 'execution'
  | 'closeout'
  | 'complete'
  | 'cancelled';

/** Forward order. `cancelled` is not in it — it is reachable from anywhere. */
export const STAGE_ORDER: ProjectStage[] = [
  'handoff',
  'precon',
  'mobilization',
  'execution',
  'closeout',
  'complete',
];

export function stageOrdinal(stage: ProjectStage): number {
  return STAGE_ORDER.indexOf(stage);
}

export function nextStage(stage: ProjectStage): ProjectStage | null {
  const i = stageOrdinal(stage);
  if (i < 0) return null;
  return STAGE_ORDER[i + 1] ?? null;
}

export interface GateState {
  gate_number: number;
  title: string;
  status: 'open' | 'submitted' | 'approved' | 'rejected';
}

/**
 * Which gates must be approved before a project may leave `from`.
 *
 * OPEN ITEM — see docs/OPEN_ITEMS.md #1. Nothing in the schema maps a gate to
 * a stage. The rule here is: leaving the stage at ordinal N requires every
 * gate numbered N or lower to be approved. Against the shipped default that is
 * exactly the intended chain (gate 0 Qualification and handoff → leave
 * handoff, gate 1 Preconstruction → leave precon, and so on), and it degrades
 * sanely for a tenant who configures fewer gates.
 *
 * It is wrong for a tenant who configures MORE gates than there are stages:
 * gates 6 and up would never block anything. Since gate count is explicitly
 * tenant configuration, the durable fix is a `gate_templates.advances_to_stage
 * project_stage` column so the mapping is data rather than arithmetic. That is
 * a schema change and needs Mason, so it is flagged rather than assumed.
 */
export function gatesBlocking(from: ProjectStage, gates: GateState[]): GateState[] {
  const ordinal = stageOrdinal(from);
  if (ordinal < 0) return [];
  return gates
    .filter((g) => g.gate_number <= ordinal && g.status !== 'approved')
    .sort((a, b) => a.gate_number - b.gate_number);
}

export function assertStageAdvanceAllowed(
  from: ProjectStage,
  to: ProjectStage,
  gates: GateState[],
): void {
  if (from === 'cancelled') {
    throw new ApiError('conflict', 'A cancelled project cannot change stage.');
  }
  if (to === 'cancelled') return;

  const expected = nextStage(from);
  if (expected === null) {
    throw new ApiError('conflict', `A project at stage ${from} has no next stage.`);
  }
  if (to !== expected) {
    // No skipping and no reversing. A stage that can be set to anything is a
    // label, not a control, and the gates hang off it.
    throw new ApiError(
      'conflict',
      `A project at stage ${from} can only advance to ${expected}, not ${to}.`,
      { from, to, expected },
    );
  }

  const blocking = gatesBlocking(from, gates);
  if (blocking.length > 0) {
    throw new ApiError(
      'gate_not_satisfied',
      `Gate ${blocking[0]!.gate_number} (${blocking[0]!.title}) is ${blocking[0]!.status}.`,
      {
        gates: blocking.map((g) => ({
          gate_number: g.gate_number,
          title: g.title,
          status: g.status,
        })),
      },
    );
  }
}
