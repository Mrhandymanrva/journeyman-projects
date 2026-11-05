import type { SqlClient } from "../db/database.js";

/**
 * Agree-or-none rule for a ServiceTitan visit. Pass the phases stated by the
 * tasks that link the same job (non-cancelled plan tasks and WBS tasks).
 * Null when none of them states a phase, or when they name more than one.
 * Callers must not invent a phase from a title, a date, or a parent work package.
 */
export function phaseFromPlanTaskLinks(
  phases: readonly (string | null | undefined)[],
): string | null {
  const unique = new Set<string>();
  for (const phase of phases) {
    const text = (phase ?? "").trim();
    if (text) unique.add(text);
  }
  if (unique.size !== 1) return null;
  return [...unique][0] ?? null;
}

export interface AppointmentPhaseRow {
  project_id?: string | null;
  external_job_id?: string | null;
  job_link_id?: string | null;
  phase?: string | null;
}

/**
 * Writes `phase` onto each appointment from active job links and the tasks
 * that point at them. Also fills `job_link_id` when the project has exactly
 * one active link for that ServiceTitan job.
 *
 * Plan phases come from non-cancelled schedule items. WBS phases come from
 * active project-control tasks (`data.phase` on the task that stores
 * `data.job_link_id`). A blank WBS phase is not a phase. A parent work
 * package contributes only when that package itself is linked to the job
 * and states a phase — the child's phase is never copied from its parent.
 */
export async function assignAppointmentPhases(
  db: SqlClient,
  rows: AppointmentPhaseRow[],
): Promise<void> {
  if (!rows.length) return;
  const projectIds = [
    ...new Set(rows.map((row) => row.project_id).filter((id): id is string => !!id)),
  ];
  const found = projectIds.length
    ? await db.query<{
        job_link_id: string;
        project_id: string;
        external_job_id: string;
        phase: string | null;
      }>(
        `SELECT j.id::text AS job_link_id,
                j.project_id::text AS project_id,
                j.external_job_id,
                s.phase
           FROM projects.project_job_links j
           LEFT JOIN projects.schedule_items s
             ON s.job_link_id = j.id
            AND s.project_id = j.project_id
            AND s.status <> 'cancelled'
            AND s.phase IS NOT NULL
            AND length(btrim(s.phase)) > 0
          WHERE j.source_active
            AND j.project_id = ANY($1::uuid[])`,
        [projectIds],
      )
    : { rows: [] };
  const wbs = projectIds.length
    ? await db.query<{
        job_link_id: string;
        project_id: string;
        external_job_id: string;
        phase: string | null;
      }>(
        `SELECT j.id::text AS job_link_id,
                j.project_id::text AS project_id,
                j.external_job_id,
                btrim(c.data->>'phase') AS phase
           FROM projects.project_controls c
           JOIN projects.project_job_links j
             ON j.project_id = c.project_id
            AND j.source_active
            AND lower(j.id::text) = lower(c.data->>'job_link_id')
          WHERE c.kind = 'task'
            AND c.active
            AND c.project_id = ANY($1::uuid[])
            AND length(btrim(coalesce(c.data->>'phase', ''))) > 0`,
        [projectIds],
      )
    : { rows: [] };
  const byJob = new Map<string, { links: Set<string>; phases: string[] }>();
  const byLink = new Map<string, string[]>();
  const remember = (row: {
    job_link_id: string;
    project_id: string;
    external_job_id: string;
    phase: string | null;
  }) => {
    const key = row.project_id + "\0" + row.external_job_id;
    const bucket = byJob.get(key) ?? { links: new Set<string>(), phases: [] };
    bucket.links.add(row.job_link_id);
    if (row.phase) bucket.phases.push(row.phase);
    byJob.set(key, bucket);
    if (row.phase) {
      const list = byLink.get(row.job_link_id) ?? [];
      list.push(row.phase);
      byLink.set(row.job_link_id, list);
    }
  };
  for (const row of found.rows) remember(row);
  for (const row of wbs.rows) remember(row);
  for (const row of rows) {
    if (row.project_id && row.external_job_id) {
      const bucket = byJob.get(row.project_id + "\0" + row.external_job_id);
      row.phase = phaseFromPlanTaskLinks(bucket?.phases ?? []);
      if (!row.job_link_id && bucket?.links.size === 1) {
        row.job_link_id = [...bucket.links][0] ?? null;
      }
      continue;
    }
    row.phase = row.job_link_id
      ? phaseFromPlanTaskLinks(byLink.get(row.job_link_id) ?? [])
      : null;
  }
}
