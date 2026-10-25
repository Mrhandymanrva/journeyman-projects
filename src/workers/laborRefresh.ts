import type { SourceConnections } from "../adapters/sourceConnections.js";
import type { AdvisoryLock, Database } from "../db/database.js";
import {
  readLaborJobs,
  readTechnicianDirectory,
  saveLaborRefresh,
} from "../domain/laborActuals.js";

const HOUR_MS = 60 * 60 * 1000;
const FIRST_TICK_MS = 15_000;
const GAP_MS = 250;
export const LABOR_REFRESH_LOCK_KEY = "journeyman.labor_auto_refresh";

type ServiceTitanSource = NonNullable<SourceConnections["serviceTitan"]>;

export interface LaborRefreshFailure {
  projectId: string;
  projectNumber: string;
  message: string;
}

export interface LaborRefreshReport {
  skipped: "locked" | null;
  refreshed: string[];
  failed: LaborRefreshFailure[];
}

export interface LaborRefreshOptions {
  /** Pause between projects. Tests pass 0. The hourly job waits a quarter second. */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to a session advisory lock so only one replica runs. */
  tryLock?: (key: string) => Promise<AdvisoryLock | null>;
  now?: () => Date;
}

/**
 * The same read the Refresh hours button runs, for every project that is not
 * complete or cancelled. Projects run one after another on one ServiceTitan
 * client, so they share one token. A failure is logged and the next project
 * still runs. ServiceTitan is only read.
 */
export async function runHourlyLaborRefresh(
  db: Database,
  connection: ServiceTitanSource,
  options: LaborRefreshOptions = {},
): Promise<LaborRefreshReport> {
  const tryLock = options.tryLock ?? ((key: string) => db.tryAdvisoryLock(key));
  const lock = await tryLock(LABOR_REFRESH_LOCK_KEY);
  if (!lock) return { skipped: "locked", refreshed: [], failed: [] };

  try {
    const projects = await db.withTenant(connection.tenantId, (client) =>
      client.query<{ id: string; project_number: string }>(
        `SELECT id::text AS id, project_number
           FROM projects.projects
          WHERE stage NOT IN ('complete', 'cancelled')
          ORDER BY project_number`,
      ),
    );
    const gapMs = options.gapMs ?? GAP_MS;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }));
    const refreshed: string[] = [];
    const failed: LaborRefreshFailure[] = [];
    for (let index = 0; index < projects.rows.length; index += 1) {
      const project = projects.rows[index]!;
      try {
        await refreshProject(
          db,
          connection,
          project.id,
          options.now?.() ?? new Date(),
        );
        refreshed.push(project.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Labor refresh failed for ${project.project_number}: ${message}`);
        failed.push({
          projectId: project.id,
          projectNumber: project.project_number,
          message,
        });
      }
      if (gapMs > 0 && index < projects.rows.length - 1) await sleep(gapMs);
    }
    return { skipped: null, refreshed, failed };
  } finally {
    await lock.release();
  }
}

async function refreshProject(
  db: Database,
  connection: ServiceTitanSource,
  projectId: string,
  observedAt: Date,
): Promise<void> {
  const readJobTimesheets = connection.client.readJobTimesheets;
  if (!readJobTimesheets) {
    throw new Error("ServiceTitan timesheet read is not configured.");
  }
  const jobs = await db.withTenant(connection.tenantId, (client) =>
    client.query<{ id: string; external_job_id: string }>(
      `SELECT id::text AS id, external_job_id
         FROM projects.project_job_links
        WHERE project_id = $1
          AND external_system_id = $2
          AND source_active
        ORDER BY external_job_id`,
      [projectId, connection.externalSystemId],
    ),
  );
  const results = await readLaborJobs(
    jobs.rows.map((job) => job.external_job_id),
    {
      readJobTimesheets: (jobId) => readJobTimesheets(jobId),
      readJob: (jobId) => connection.client.readJob(jobId),
    },
  );
  const directory = await readTechnicianDirectory({
    readTechnicians: connection.client.readTechnicians?.bind(connection.client),
  });
  await db.withTenant(connection.tenantId, (client) =>
    saveLaborRefresh(client, {
      tenantId: connection.tenantId,
      projectId,
      jobs: jobs.rows,
      results,
      directory,
      source: "auto-hourly",
      observedAt,
    }),
  );
}

/**
 * Once an hour, beside the health snapshot. The first tick is shortly after
 * boot and does not delay listen. No ServiceTitan settings means the job
 * stays off. A second replica finds the advisory lock taken and leaves.
 */
export function startLaborRefreshScheduler(
  db: Database,
  sources: SourceConnections,
): ReturnType<typeof setInterval> | undefined {
  const serviceTitan = sources.serviceTitan;
  if (!serviceTitan?.client.readJobTimesheets) {
    console.log("Labor refresh is off. ServiceTitan is not configured.");
    return undefined;
  }
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const report = await runHourlyLaborRefresh(db, serviceTitan);
      if (report.skipped === "locked") {
        console.log("Labor refresh skipped. Another replica holds the lock.");
        return;
      }
      console.log(
        `Labor refresh finished. ${report.refreshed.length} project(s) updated, ${report.failed.length} failed.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Labor refresh did not run. ${message}`);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void tick(), FIRST_TICK_MS);
  first.unref();
  const timer = setInterval(() => void tick(), HOUR_MS);
  timer.unref();
  return timer;
}
