import { Router } from "express";
import { z } from "zod";
import {
  staffExternalRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import { unitFilter } from "../http/capabilities.js";
import { ApiError } from "../http/errors.js";
import { sendData } from "../http/envelope.js";
import { loadVisibleProject, parseBody, parseUuidParam } from "./shared.js";
import type { SourceConnections } from "../adapters/sourceConnections.js";
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
                phase: "ServiceTitan jobs",
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
  return router;
}
