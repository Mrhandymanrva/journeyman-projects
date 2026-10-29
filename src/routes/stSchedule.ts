import { Router } from "express";
import { z } from "zod";
import {
  staffExternalRoute,
  staffRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import { requireCapability, unitFilter } from "../http/capabilities.js";
import { ApiError } from "../http/errors.js";
import { sendData } from "../http/envelope.js";
import { loadVisibleProject, parseBody, parseUuidParam } from "./shared.js";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import { assignAppointmentPhases } from "../domain/planPhase.js";
import {
  appointmentSkipWarning,
  claimPlanAppointmentRefresh,
  finishPlanAppointmentRefresh,
  planAppointmentMessage,
  readPlanLinkStatus,
  refreshProjectPlanAppointments,
} from "../domain/planAppointments.js";
type Target = {
  id: string;
  name: string;
  project_number: string;
  external_project_id: string | null;
  connection_key: string | null;
};
export function stScheduleRoutes(
  deps: StaffRouterDeps,
  sources: SourceConnections = {},
) {
  const router = Router();
  const zone = "America/New_York";
  const localDate = (v: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(v));
  async function prepare(ctx: StaffContext) {
    const id = ctx.req.params.id
      ? parseUuidParam(ctx.req.params.id, "Project")
      : null;
    if (id) await loadVisibleProject(ctx, id, "id");
    const q = parseBody(
      z
        .object({ from: z.string().date(), to: z.string().date() })
        .refine(
          (q) =>
            q.to >= q.from &&
            Date.parse(q.to) - Date.parse(q.from) <= 62 * 86400000,
          { message: "Choose a date range of up to 63 days." },
        ),
      ctx.req.query,
    );
    const c = sources.serviceTitan;
    if (!c || c.tenantId !== ctx.staff.tenantId)
      return { id, q, c: null, targets: [] as Target[], links: [] as any[] };
    if (
      !(
        await ctx.db.query(
          "SELECT id FROM projects.external_systems WHERE id=$1 AND active AND adapter_key='servicetitan'",
          [c.externalSystemId],
        )
      ).rows.length
    )
      return { id, q, c: null, targets: [] as Target[], links: [] as any[] };
    const unit = unitFilter(
      ctx.staff.businessUnitId,
      ctx.settings.enforceBusinessUnitScoping,
    );
    const targets = (
      await ctx.db.query<Target>(
        `SELECT p.id,p.name,p.project_number,s.external_project_id,s.connection_key FROM projects.projects p LEFT JOIN projects.st_project_connections s ON s.project_id=p.id AND s.external_system_id=$1 WHERE ($2::uuid IS NULL OR p.id=$2) AND ($3::uuid IS NULL OR p.business_unit_id=$3) AND (s.project_id IS NOT NULL OR EXISTS(SELECT 1 FROM projects.project_job_links j WHERE j.project_id=p.id AND j.external_system_id=$1 AND j.source_active)) ORDER BY p.id`,
        [c.externalSystemId, id, unit],
      )
    ).rows;
    if (targets.some((t) => t.connection_key && t.connection_key !== c.key))
      throw new ApiError(
        "conflict",
        "The ST account changed. Reconnect the project before reading its schedule.",
      );
    const links = (
      await ctx.db.query<{
        id: string;
        project_id: string;
        external_job_id: string;
      }>(
        `SELECT id,project_id,external_job_id FROM projects.project_job_links WHERE project_id=ANY($1::uuid[]) AND external_system_id=$2 AND source_active ORDER BY id`,
        [targets.map((t) => t.id), c.externalSystemId],
      )
    ).rows;
    return { id, q, c, targets, links };
  }
  const handler = staffExternalRoute(
    deps,
    prepare,
    async (p) => {
      const rows: any[] = [];
      if (!p.c) return rows;
      for (const target of p.targets) {
        const project = target.external_project_id
          ? await p.c.client.readProject!(target.external_project_id)
          : null;
        const ids =
          project?.project.jobIds ??
          p.links
            .filter((l) => l.project_id === target.id)
            .map((l) => l.external_job_id);
        for (let offset = 0; offset < ids.length; offset += 4) {
          const jobs = await Promise.all(
            ids.slice(offset, offset + 4).map((id) => p.c!.client.readJob(id)),
          );
          for (const result of jobs) {
            if (
              target.external_project_id &&
              result.job.projectId != null &&
              result.job.projectId !== target.external_project_id
            )
              throw Error("ST job membership changed.");
            if (/cancel/i.test(result.job.jobStatus)) continue;
            for (const a of result.appointments) {
              if (!a.active || /cancel/i.test(a.status)) continue;
              if (Date.parse(a.end) <= Date.parse(a.start))
                throw Error("Invalid appointment window.");
              const start = localDate(a.start),
                end = localDate(new Date(Date.parse(a.end) - 1).toISOString());
              if (start > p.q.to || end < p.q.from) continue;
              const people = [
                ...new Map(
                  result.assignments
                    .filter(
                      (x) =>
                        x.active &&
                        x.appointmentId === a.id &&
                        !/cancel|unassign/i.test(x.status),
                    )
                    .map((x) => [
                      x.technicianId,
                      {
                        id: "st-tech:" + x.technicianId,
                        name: x.technicianName,
                        kind: "employee",
                        trade: "ServiceTitan",
                        schedulable: true,
                      },
                    ]),
                ).values(),
              ];
              rows.push({
                id: "st:" + target.id + ":" + a.id,
                source: "servicetitan",
                project_id: target.id,
                project_name: target.name,
                project_number: target.project_number,
                job_link_id:
                  p.links.find(
                    (l) =>
                      l.project_id === target.id &&
                      l.external_job_id === result.job.id,
                  )?.id ?? null,
                external_job_id: result.job.id,
                appointment_id: a.id,
                appointment_number: a.appointmentNumber,
                title:
                  "ST job " +
                  result.job.jobNumber +
                  " · " +
                  a.appointmentNumber,
                summary: result.job.summary ?? null,
                phase: null,
                window_start: start,
                window_end: end,
                appointment_start: a.start,
                appointment_end: a.end,
                time_zone: zone,
                source_status: a.status,
                status: /done|complete/i.test(a.status)
                  ? "complete"
                  : /working|dispatched|progress/i.test(a.status)
                    ? "in_progress"
                    : "confirmed",
                resources: people,
              });
            }
          }
        }
        if (project) {
          const latest = await p.c.client.readProject!(
            target.external_project_id!,
          );
          if (
            JSON.stringify([...latest.project.jobIds].sort()) !==
            JSON.stringify([...project.project.jobIds].sort())
          )
            throw Error("ST project changed while reading schedule.");
        }
      }
      return rows.sort((a, b) =>
        a.appointment_start.localeCompare(b.appointment_start),
      );
    },
    async (ctx, p, rows) => {
      const fresh = await prepare(ctx);
      if (
        fresh.c?.key !== p.c?.key ||
        JSON.stringify(fresh.targets) !== JSON.stringify(p.targets) ||
        JSON.stringify(fresh.links) !== JSON.stringify(p.links)
      )
        throw new ApiError(
          "conflict",
          "Project access or ST links changed during refresh. Try again.",
        );
      await assignAppointmentPhases(ctx.db, rows);
      sendData(ctx.res, {
        configured: !!p.c,
        linkedProjects: p.targets.length,
        rows,
        observedAt: new Date().toISOString(),
        timeZone: zone,
      });
    },
  );
  router.get("/projects/:id/servicetitan/schedule", handler);
  router.get("/servicetitan/schedule", handler);
  router.get(
    "/projects/:id/plan-appointments",
    staffRoute(deps, async (ctx) => {
      const id = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, id, "id");
      sendData(ctx.res, await storedAppointments(ctx, id, ctx.req.query));
    }),
  );
  router.get(
    "/plan-appointments",
    staffRoute(deps, async (ctx) => {
      sendData(ctx.res, await storedAppointments(ctx, null, ctx.req.query));
    }),
  );
  router.post(
    "/projects/:id/plan-appointments/refresh",
    staffExternalRoute(
      deps,
      async (ctx) => {
        const id = parseUuidParam(ctx.req.params.id, "Project");
        await loadVisibleProject(ctx, id, "id");
        requireCapability(ctx.staff.role, "refresh_labor");
        const source = sources.serviceTitan;
        if (!source || source.tenantId !== ctx.staff.tenantId || !source.client.readJob) {
          throw new ApiError(
            "conflict",
            "ServiceTitan is not configured for this account. Existing appointments were left as they are.",
          );
        }
        const link = await readPlanLinkStatus(ctx.db, id, null);
        if (!link.linkedProjects) {
          throw new ApiError(
            "conflict",
            "Connect this project to ServiceTitan to include technician jobs.",
          );
        }
        const jobs = await ctx.db.query<{ external_job_id: string }>(
          `SELECT external_job_id
             FROM projects.project_job_links
            WHERE project_id = $1
              AND external_system_id = $2
              AND source_active
            ORDER BY external_job_id`,
          [id, source.externalSystemId],
        );
        const gate = claimPlanAppointmentRefresh(`${ctx.staff.tenantId}:${id}`);
        if (gate !== "ok") {
          throw new ApiError(
            "rate_limited",
            "Wait a few seconds before refreshing ServiceTitan jobs again.",
          );
        }
        return {
          id,
          tenantId: ctx.staff.tenantId,
          jobs: jobs.rows,
          readJob: (jobId: string) => source.client.readJob(jobId),
        };
      },
      async (prepared) => {
        try {
          return await refreshProjectPlanAppointments(deps.database, {
            tenantId: prepared.tenantId,
            projectId: prepared.id,
            jobs: prepared.jobs,
            readJob: prepared.readJob,
          });
        } finally {
          finishPlanAppointmentRefresh(`${prepared.tenantId}:${prepared.id}`);
        }
      },
      async (ctx, prepared, result) => {
        requireCapability(ctx.staff.role, "refresh_labor");
        await loadVisibleProject(ctx, prepared.id, "id");
        sendData(ctx.res, {
          stored: result.stored,
          skipped: result.skipped,
          failedJobs: result.failedJobs,
          warnings: result.warnings,
          readAt: result.readAt,
          error: result.error,
        });
      },
    ),
  );
  return router;
}

async function storedAppointments(
  ctx: StaffContext,
  projectId: string | null,
  query: StaffContext["req"]["query"],
) {
  const q = parseBody(
    z.object({ from: z.string().date(), to: z.string().date() }).refine(
      (value) => value.to >= value.from && Date.parse(value.to) - Date.parse(value.from) <= 370 * 86400000,
      { message: "Choose a date range of up to a year." },
    ),
    query,
  );
  const zone = "America/New_York";
  const localDate = (value: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(value));
  const unit = unitFilter(ctx.staff.businessUnitId, ctx.settings.enforceBusinessUnitScoping);
  const rows = await ctx.db.query<{
    project_id: string;
    project_name: string;
    project_number: string;
    external_job_id: string;
    external_appointment_id: string;
    job_number: string;
    appointment_number: string;
    job_status: string;
    starts_at: Date;
    ends_at: Date;
    status: string;
    technicians: Array<{ id: string; name: string }> | string;
  }>(
    `SELECT a.project_id::text, p.name AS project_name, p.project_number,
            a.external_job_id, a.external_appointment_id, a.job_number,
            a.appointment_number, a.job_status, a.starts_at, a.ends_at,
            a.status, a.technicians
       FROM projects.st_plan_appointments a
       JOIN projects.projects p ON p.id = a.project_id
      WHERE a.active
        AND a.status !~* 'cancel'
        AND a.job_status !~* 'cancel'
        AND ($1::uuid IS NULL OR a.project_id = $1)
        AND ($2::uuid IS NULL OR p.business_unit_id = $2)
      ORDER BY a.starts_at`,
    [projectId, unit],
  );
  const visible = rows.rows.flatMap((row) => {
    const start = row.starts_at.toISOString();
    const end = row.ends_at.toISOString();
    const windowStart = localDate(start);
    const windowEnd = localDate(new Date(Date.parse(end) - 1).toISOString());
    if (windowStart > q.to || windowEnd < q.from) return [];
    const people = (Array.isArray(row.technicians) ? row.technicians : []).map((tech) => ({
      id: "st-tech:" + tech.id,
      name: tech.name,
      kind: "employee",
      trade: "ServiceTitan",
      schedulable: true,
    }));
    return [{
      id: "st:" + row.project_id + ":" + row.external_appointment_id,
      source: "servicetitan",
      project_id: row.project_id,
      project_name: row.project_name,
      project_number: row.project_number,
      external_job_id: row.external_job_id,
      appointment_id: row.external_appointment_id,
      appointment_number: row.appointment_number,
      title: "ST job " + row.job_number + " · " + row.appointment_number,
      job_link_id: null as string | null,
      phase: null as string | null,
      window_start: windowStart,
      window_end: windowEnd,
      appointment_start: start,
      appointment_end: end,
      time_zone: zone,
      source_status: row.status,
      status: /done|complete/i.test(row.status) ? "complete" : "confirmed",
      resources: people,
      read_only: true,
    }];
  });
  await assignAppointmentPhases(ctx.db, visible);
  const link = await readPlanLinkStatus(ctx.db, projectId, unit);
  const message = planAppointmentMessage({
    configured: link.configured,
    linkedProjects: link.linkedProjects,
    inRange: visible.length,
    readAt: link.readAt,
    skipped: link.skipped,
    failedJobs: link.failedJobs,
    readError: link.readError,
  });
  return {
    configured: link.configured,
    linkedProjects: link.linkedProjects,
    rows: visible,
    observedAt: link.readAt,
    appointmentsReadAt: link.readAt,
    skippedAppointments: link.skipped,
    failedJobs: link.failedJobs,
    warnings: [
      appointmentSkipWarning(link.skipped),
      ...link.failedJobs.map((job) => `Job ${job.jobId} appointments: ${job.message}`),
      link.failedJobs.length === 0 ? link.readError : null,
    ].filter((warning): warning is string => !!warning),
    readError: link.readError,
    message,
    timeZone: zone,
    readOnly: true,
  };
}
