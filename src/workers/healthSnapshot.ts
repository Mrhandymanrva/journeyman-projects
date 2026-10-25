import type { Database, SqlClient } from "../db/database.js";
import { newYorkDate } from "../domain/fieldStart.js";
import {
  includeInDailySnapshot,
  loadProjectHealth,
  type ProjectHealthRow,
} from "../domain/projectHealth.js";

const HOUR_MS = 60 * 60 * 1000;
const LOCK_SQL = `SELECT pg_try_advisory_xact_lock(hashtext('journeyman.project_health_snapshots')::bigint) AS locked`;

export interface SnapshotRun {
  written: number;
  skipped: "locked" | "already_ran" | null;
}

/**
 * Writes today's health rows from local tables.
 * The first run of a New York day inserts them. Later automatic runs leave
 * that day alone. An owner run replaces the day.
 * This function does not open a network socket.
 */
export async function writeHealthSnapshots(
  db: SqlClient,
  options: { today: string; replace: boolean },
): Promise<SnapshotRun> {
  const locked = await db.query<{ locked: boolean }>(LOCK_SQL);
  if (locked.rows[0]?.locked !== true) return { written: 0, skipped: "locked" };

  if (!options.replace) {
    const existing = await db.query(
      `SELECT 1 FROM projects.project_health_snapshots WHERE snapshot_on = $1::date LIMIT 1`,
      [options.today],
    );
    if (existing.rows.length > 0) return { written: 0, skipped: "already_ran" };
  } else {
    await db.query(
      `DELETE FROM projects.project_health_snapshots WHERE snapshot_on = $1::date`,
      [options.today],
    );
  }

  const rows = await loadProjectHealth(db, options.today);
  const prior = await db.query<{ project_id: string }>(
    `SELECT project_id::text AS project_id
       FROM projects.project_health_snapshots
      WHERE snapshot_on < $1::date`,
    [options.today],
  );
  const priorIds = new Set(prior.rows.map((row) => row.project_id));
  const writing = rows.filter((row) =>
    includeInDailySnapshot(row, options.today, priorIds),
  );
  for (const row of writing) await insertSnapshot(db, options.today, row);
  return { written: writing.length, skipped: null };
}

async function insertSnapshot(
  db: SqlClient,
  today: string,
  row: ProjectHealthRow,
): Promise<void> {
  await db.query(
    `INSERT INTO projects.project_health_snapshots (
       tenant_id, project_id, snapshot_on, score, band, reasons,
       projected_margin_pct, billing_position, billing_amount,
       revised_contract, committed_cost, projected_cost
     ) VALUES (
       projects.current_tenant(), $1, $2::date, $3, $4, $5::jsonb,
       $6, $7, $8, $9, $10, $11
     )`,
    [
      row.project_id,
      today,
      row.health.score,
      row.health.band,
      JSON.stringify(row.health.reasons),
      row.projected_margin_pct,
      row.billing.position,
      row.billing.amount,
      row.revised_contract,
      row.committed_cost,
      row.projected_cost,
    ],
  );
}

/** One tenant, named by PM_PORTFOLIO_TENANT_ID. No tenant means the job stays off. */
export async function runHealthSnapshots(
  db: Database,
  tenantId: string,
  options: { today?: string; replace?: boolean } = {},
): Promise<SnapshotRun> {
  const today = options.today ?? newYorkDate(new Date().toISOString());
  return db.withTenant(tenantId, (client) =>
    writeHealthSnapshots(client, { today, replace: options.replace === true }),
  );
}

/**
 * Once an hour, beside the accounting worker. The first tick of a New York
 * day writes the rows. A second replica finds the advisory lock taken and
 * leaves them. Local tables only.
 */
export function startHealthSnapshotScheduler(
  db: Database,
  tenantId: string | undefined,
): ReturnType<typeof setInterval> | undefined {
  if (!tenantId) return undefined;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runHealthSnapshots(db, tenantId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Health snapshot did not run. ${message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), HOUR_MS);
  timer.unref();
  void tick();
  return timer;
}
