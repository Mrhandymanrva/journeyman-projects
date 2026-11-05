import type { TokenScopedRequest } from "./harness.js";

/** Tick every open checklist item so an approve call can reach the gate itself. */
export async function tickGate(
  as: TokenScopedRequest,
  projectId: string,
  gateNumber: number,
): Promise<void> {
  const gates = await as.get(`/api/v1/projects/projects/${projectId}/gates`);
  if (gates.status !== 200) {
    throw new Error(`gates ${gates.status} ${JSON.stringify(gates.body)}`);
  }
  const gate = (
    gates.body.data as Array<{
      gate_number: number;
      checklist: Array<{ key: string; done: boolean }>;
    }>
  ).find((row) => row.gate_number === gateNumber);
  if (!gate) throw new Error(`gate ${gateNumber} missing`);
  for (const item of gate.checklist ?? []) {
    if (item.done) continue;
    const ticked = await as
      .patch(
        `/api/v1/projects/projects/${projectId}/gates/${gateNumber}/checklist`,
      )
      .send({ key: item.key, done: true });
    if (ticked.status !== 200) {
      throw new Error(
        `tick ${item.key} ${ticked.status} ${JSON.stringify(ticked.body)}`,
      );
    }
  }
}
