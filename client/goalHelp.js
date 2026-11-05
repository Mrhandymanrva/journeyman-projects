export const GOAL_KEY_RESULT_EXAMPLE =
  "Pass final inspection: start 0, target 1, current 0, unit inspections.";

/** Shown on the goal form. A goal may be saved with no key results. */
export function goalKeyResultHelpHtml() {
  return `<p class="hint" id="goal-key-result-help">Key results are optional. Each one is a number you type in: <strong>start</strong> is where the count begins, <strong>target</strong> is the number that means done, <strong>current</strong> is where it stands now, and <strong>unit</strong> is what you are counting. Example: ${GOAL_KEY_RESULT_EXAMPLE} Save the goal with none when you are not measuring it with a number yet.</p>`;
}
