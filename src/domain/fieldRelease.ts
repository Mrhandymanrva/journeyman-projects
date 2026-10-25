import type { SqlClient } from '../db/database.js';

/**
 * Current field-release flag for a project.
 *
 * `released_by` is the staff member's name. `scheduled_start` on the same
 * project payload is the committed start date (a calendar date). `actual_start`
 * is when work began. This flag does not block either one.
 */
export interface FieldRelease {
  released: boolean;
  released_by: string | null;
  released_at: string | null;
  note: string | null;
}

export interface FieldReleaseEvent {
  action: 'release' | 'undo';
  note: string | null;
  actor: string | null;
  occurred_at: string;
}

export type FieldReleaseView = FieldRelease & { history?: FieldReleaseEvent[] };

export function isoTimestamp(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

export function presentFieldRelease(input: {
  released_at: unknown;
  released_by: string | null;
  note: unknown;
}): FieldRelease {
  const released_at = isoTimestamp(input.released_at);
  const released = released_at !== null;
  const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note : null;
  return {
    released,
    released_by: released ? input.released_by : null,
    released_at,
    note: released ? note : null,
  };
}

export async function readFieldRelease(
  db: SqlClient,
  projectId: string,
  withHistory: boolean,
): Promise<FieldReleaseView> {
  const current = await db.query<{
    released_at: unknown;
    note: string | null;
    released_by: string | null;
  }>(
    `SELECT p.field_released_at AS released_at,
            p.field_release_note AS note,
            s.full_name AS released_by
       FROM projects.projects p
       LEFT JOIN projects.staff s ON s.id = p.field_released_by
      WHERE p.id = $1`,
    [projectId],
  );
  const row = current.rows[0];
  const release = presentFieldRelease({
    released_at: row?.released_at,
    released_by: row?.released_by ?? null,
    note: row?.note,
  });
  if (!withHistory) return release;

  const events = await db.query<{
    action: 'release' | 'undo';
    note: string | null;
    actor: string | null;
    occurred_at: unknown;
  }>(
    `SELECT e.action, e.note, s.full_name AS actor, e.occurred_at
       FROM projects.field_release_events e
       LEFT JOIN projects.staff s ON s.id = e.actor_id
      WHERE e.project_id = $1
      ORDER BY e.occurred_at ASC, e.id ASC`,
    [projectId],
  );
  return {
    ...release,
    history: events.rows.map((event) => ({
      action: event.action,
      note: event.note,
      actor: event.actor,
      occurred_at: isoTimestamp(event.occurred_at) ?? '',
    })),
  };
}
