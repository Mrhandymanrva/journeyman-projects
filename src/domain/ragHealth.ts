import type { HealthScore, ReasonBand } from "./projectHealth.js";

/**
 * RAG schedule and cost are not typed beside project health.
 * Schedule follows the health reasons that are about time (field start, precon).
 * Cost follows the budget reason. No reason means green, the same band health uses
 * when nothing is wrong. Yellow health is amber on the report.
 */

export type RagBand = "green" | "amber" | "red";

const SCHEDULE_CODES = new Set(["field_start", "precon"]);
const COST_CODES = new Set(["budget"]);

function worst(bands: ReasonBand[]): RagBand {
  if (bands.includes("red")) return "red";
  if (bands.includes("yellow")) return "amber";
  return "green";
}

export function ragScheduleAndCost(health: HealthScore | null | undefined): {
  schedule: RagBand;
  cost: RagBand;
} {
  const reasons = health?.reasons ?? [];
  return {
    schedule: worst(
      reasons
        .filter((reason) => SCHEDULE_CODES.has(reason.code))
        .map((reason) => reason.band),
    ),
    cost: worst(
      reasons
        .filter((reason) => COST_CODES.has(reason.code))
        .map((reason) => reason.band),
    ),
  };
}
