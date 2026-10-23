export type PlanRow = {
  id: string;
  title: string;
  window_start: string;
  window_end: string;
  status: string;
  dependencies: { predecessor_id: string; lag_days: number }[];
};
const day = (d: string, n: number) =>
  new Date(Date.parse(d + "T12:00:00Z") + 86400000 * n)
    .toISOString()
    .slice(0, 10);
const weekday = (d: string) =>
  ![0, 6].includes(new Date(d + "T12:00:00Z").getUTCDay());
function nextWork(d: string) {
  let n = d;
  while (!weekday(n)) n = day(n, 1);
  return n;
}
function duration(a: string, b: string) {
  let count = 0;
  for (let d = a; d <= b; d = day(d, 1)) {
    if (weekday(d)) count++;
    if (count > 3660) throw Error("Activity too long");
  }
  return Math.max(1, count);
}
function endAt(start: string, length: number) {
  let d = start;
  for (let n = 1; n < length;) {
    d = day(d, 1);
    if (weekday(d)) n++;
  }
  return d;
}
/** Mon-Fri forecast with calendar-day dependency lag. Baseline dates are not overwritten. */
export function proposePlan(rows: PlanRow[], rootId: string, start: string) {
  const map = new Map(rows.map((r) => [r.id, { ...r }]));
  const root = map.get(rootId);
  if (!root) throw Error("Activity not found");
  if (["complete", "cancelled"].includes(root.status))
    throw Error("Completed or cancelled work cannot be moved");
  root.window_start = nextWork(start);
  root.window_end = endAt(
    root.window_start,
    duration(
      rows.find((r) => r.id === rootId)!.window_start,
      rows.find((r) => r.id === rootId)!.window_end,
    ),
  );
  const affected = new Set([rootId]);
  const visiting = new Set<string>(),
    done = new Set<string>();
  function visit(id: string) {
    if (done.has(id)) return;
    if (visiting.has(id)) throw Error("Dependency cycle");
    visiting.add(id);
    const r = map.get(id)!;
    for (const dep of r.dependencies) {
      if (map.has(dep.predecessor_id)) visit(dep.predecessor_id);
    }
    if (
      id !== rootId &&
      r.dependencies.some((d) => affected.has(d.predecessor_id)) &&
      !["complete", "cancelled"].includes(r.status)
    ) {
      affected.add(id);
      const starts = r.dependencies
        .map((d) => map.get(d.predecessor_id))
        .filter(Boolean);
      let required = r.window_start;
      for (const dep of r.dependencies) {
        const p = map.get(dep.predecessor_id);
        if (p) {
          const min = nextWork(day(p.window_end, dep.lag_days + 1));
          if (min > required) required = min;
        }
      }
      if (required > r.window_start) {
        const count = duration(r.window_start, r.window_end);
        r.window_start = required;
        r.window_end = endAt(required, count);
      }
    }
    visiting.delete(id);
    done.add(id);
  }
  rows.forEach((r) => visit(r.id));
  return rows.flatMap((old) => {
    const updated = map.get(old.id)!;
    return old.window_start !== updated.window_start ||
      old.window_end !== updated.window_end
      ? [
          {
            id: old.id,
            title: old.title,
            before: { start: old.window_start, end: old.window_end },
            after: { start: updated.window_start, end: updated.window_end },
          },
        ]
      : [];
  });
}
