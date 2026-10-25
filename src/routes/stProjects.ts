import { Router } from "express";
import { z } from "zod";
import {
  staffRoute,
  staffExternalRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import { can, requireCapability } from "../http/capabilities.js";
import { ApiError } from "../http/errors.js";
import { sendData } from "../http/envelope.js";
import {
  assertUnitWritable,
  requireOwnedRow,
  loadVisibleProject,
  parseBody,
  parseUuidParam,
} from "./shared.js";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import { createProject } from "./projects.js";
import { readLaborJobs, stampLaborCodes, storeJobLabor, type LaborJobResult } from "../domain/laborActuals.js";
import { AR_READ_REFUSED, storeProjectAr, type ArRead } from "../domain/arMatch.js";
import type { ServiceTitanReadAdapter } from "../adapters/serviceTitan.js";
import {
  pickFieldStart,
  presentFieldStart,
  storeComputedFieldStart,
} from "../domain/fieldStart.js";
type Details = Awaited<
  ReturnType<ServiceTitanReadAdapter["readProjectDetails"]>
>;
export function stProjectRoutes(
  deps: StaffRouterDeps,
  sources: SourceConnections = {},
) {
  const router = Router();
  async function binding(ctx: StaffContext) {
    const c = sources.serviceTitan;
    if (
      !c ||
      c.tenantId !== ctx.staff.tenantId ||
      !c.client.listProjects ||
      !c.client.readProjectDetails
    )
      throw new ApiError(
        "conflict",
        "ServiceTitan project connector is not configured for this account.",
      );
    const r = await ctx.db.query(
      "SELECT id FROM projects.external_systems WHERE id=$1 AND active AND adapter_key='servicetitan'",
      [c.externalSystemId],
    );
    if (!r.rows.length)
      throw new ApiError("conflict", "ServiceTitan source is inactive.");
    return c;
  }
  async function applySource(
    ctx: StaffContext,
    id: string,
    c: NonNullable<SourceConnections["serviceTitan"]>,
    result: Details,
  ) {
    await ctx.db.query(
      "SELECT id FROM projects.projects WHERE id=$1 FOR UPDATE",
      [id],
    );
    const prior = await ctx.db.query<{
      external_project_id: string;
      connection_key: string;
      observed_at: string;
    }>(
      "SELECT external_project_id,connection_key,observed_at FROM projects.st_project_connections WHERE project_id=$1",
      [id],
    );
    if (
      prior.rows[0] &&
      (prior.rows[0].external_project_id !== result.project.id ||
        prior.rows[0].connection_key !== c.key)
    )
      throw new ApiError(
        "conflict",
        "This PM project is already connected to another ST project. Its existing association was preserved.",
      );
    if (
      prior.rows[0] &&
      new Date(prior.rows[0].observed_at) >= new Date(result.observedAt)
    )
      throw new ApiError(
        "conflict",
        "A newer ST snapshot has already been saved.",
      );
    const duplicate = await ctx.db.query(
      "SELECT project_id FROM projects.st_project_connections WHERE external_system_id=$1 AND external_project_id=$2 AND project_id<>$3",
      [c.externalSystemId, result.project.id, id],
    );
    if (duplicate.rows.length)
      throw new ApiError(
        "conflict",
        "That ST project is already connected to another PM project.",
      );
    const conflicting = await ctx.db.query(
      "SELECT id FROM projects.project_job_links WHERE external_system_id=$1 AND external_job_id=ANY($2::text[]) AND project_id<>$3",
      [c.externalSystemId, result.project.jobIds, id],
    );
    if (conflicting.rows.length)
      throw new ApiError(
        "conflict",
        "An ST job is already linked to another PM project. Resolve that link before connecting this project.",
      );
    await ctx.db.query(
      `INSERT INTO projects.st_project_connections(project_id,tenant_id,external_system_id,external_project_id,connection_key,snapshot,observed_at,linked_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(project_id) DO UPDATE SET snapshot=excluded.snapshot,observed_at=excluded.observed_at`,
      [
        id,
        ctx.staff.tenantId,
        c.externalSystemId,
        result.project.id,
        c.key,
        JSON.stringify({
          ...result.project,
          customer: result.customer,
          location: result.location,
        }),
        result.observedAt,
        ctx.staff.staffId,
      ],
    );

    const a = result.location.address;
    await ctx.db.query(
      `UPDATE projects.projects SET project_number=$2,name=$3,address_line1=$4,city=$5,region=$6,postal_code=$7,external_system_id=$8,external_customer_id=$9,scheduled_end=$10,source_customer_name=$11,source_location_name=$12,source_project_status=$13,source_project_summary=$14 WHERE id=$1`,
      [
        id,
        result.project.number,
        result.project.name || "ST project " + result.project.number,
        [a.street, a.unit].filter(Boolean).join(" "),
        a.city,
        a.state,
        a.zip,
        c.externalSystemId,
        result.customer.id,
        result.project.targetCompletionDate?.slice(0, 10) || null,
        result.customer.name,
        result.location.name,
        result.project.status ?? null,
        result.project.summary ?? null,
      ],
    );
    await ctx.db.query(
      "UPDATE projects.project_job_links SET source_managed=true,source_active=false WHERE project_id=$1 AND external_system_id=$2",
      [id, c.externalSystemId],
    );
    for (const job of result.jobs) {
      const linked = await ctx.db.query(
        `INSERT INTO projects.project_job_links(tenant_id,project_id,external_system_id,external_job_id,title,source_managed,source_active,source_job_number,source_job_status,source_summary) VALUES($1,$2,$3,$4,$5,true,true,$6,$7,$8) ON CONFLICT(tenant_id,external_system_id,external_job_id) DO UPDATE SET title=excluded.title,source_managed=true,source_active=true,source_job_number=excluded.source_job_number,source_job_status=excluded.source_job_status,source_summary=excluded.source_summary WHERE project_job_links.project_id=excluded.project_id RETURNING id`,
        [
          ctx.staff.tenantId,
          id,
          c.externalSystemId,
          job.id,
          "Job " + job.jobNumber,
          job.jobNumber,
          job.jobStatus,
          job.summary ?? null,
        ],
      );
      if (!linked.rows.length)
        throw new ApiError(
          "conflict",
          "An ST job was linked elsewhere during refresh. No changes were saved.",
        );
    }
  }
  router.post(
    "/servicetitan/projects/import",
    staffExternalRoute(
      deps,
      async (ctx) => {
        requireCapability(ctx.staff.role, "create_project");
        const b = parseBody(
          z
            .object({
              external_project_id: z.string().regex(/^\d+$/),
              business_unit_id: z.string().uuid().nullish(),
            })
            .strict(),
          ctx.req.body,
        );
        if (ctx.settings.enforceBusinessUnitScoping && !b.business_unit_id)
          throw new ApiError(
            "validation_failed",
            "Choose a business unit for this project.",
          );
        assertUnitWritable(ctx, b.business_unit_id ?? null);
        await requireOwnedRow(
          ctx.db,
          "business_units",
          b.business_unit_id,
          "business_unit_id",
        );
        const c = await binding(ctx);
        const existing = await ctx.db.query<{ field_start_source: string | null }>(
          `SELECT p.field_start_source
             FROM projects.st_project_connections s
             JOIN projects.projects p ON p.id = s.project_id
            WHERE s.external_system_id = $1 AND s.external_project_id = $2`,
          [c.externalSystemId, b.external_project_id],
        );
        const since = await ctx.db.query<{ observed_at: Date | null }>(
          `SELECT max(i.observed_at) AS observed_at
             FROM projects.st_project_connections s
             JOIN projects.st_invoice_observations i ON i.project_id = s.project_id
            WHERE s.external_system_id = $1 AND s.external_project_id = $2`,
          [c.externalSystemId, b.external_project_id],
        );
        return {
          b,
          c,
          manual: existing.rows[0]?.field_start_source === "manual",
          modifiedSince: since.rows[0]?.observed_at?.toISOString() ?? null,
        };
      },
      async (p) => {
        const details = await p.c.client.readProjectDetails!(
          p.b.external_project_id,
        );
        const fieldStart = p.manual
          ? null
          : await pickFieldStart(
              details.jobs.map((job) => job.id),
              (id) => p.c.client.readJob(id),
              details.project.id,
            );
        const labor = await readLinkedLabor(
          p.c.client,
          details.jobs.map((job) => job.id),
        );
        const ar = await readLinkedAr(p.c.client, p.modifiedSince);
        return { details, fieldStart, labor, ar };
      },
      async (ctx, p, result) => {
        requireCapability(ctx.staff.role, "create_project");
        if(ctx.settings.enforceBusinessUnitScoping&&!p.b.business_unit_id)throw new ApiError("validation_failed","Choose a business unit for this project.");
        assertUnitWritable(ctx, p.b.business_unit_id ?? null);
        await requireOwnedRow(
          ctx.db,
          "business_units",
          p.b.business_unit_id,
          "business_unit_id",
        );
        const c = await binding(ctx);
        if (c.key !== p.c.key || c.externalSystemId !== p.c.externalSystemId)
          throw new ApiError("conflict", "ST connection changed; try again.");
        // Serialize imports of the same source record, including the initial creation.
        await ctx.db.query(
          "SELECT id FROM projects.external_systems WHERE id=$1 FOR UPDATE",
          [c.externalSystemId],
        );
        const existing = await ctx.db.query<{ project_id: string }>(
          "SELECT project_id FROM projects.st_project_connections WHERE external_system_id=$1 AND external_project_id=$2",
          [c.externalSystemId, result.details.project.id],
        );
        let id = existing.rows[0]?.project_id;
        if (id) await loadVisibleProject(ctx, id, "id");
        else {
          const a = result.details.location.address;
          const created = await createProject(ctx, {
            project_number: result.details.project.number,
            name: result.details.project.name || "ST project " + result.details.project.number,
            address_line1: [a.street, a.unit].filter(Boolean).join(" "),
            city: a.city,
            region: a.state,
            postal_code: a.zip,
            external_system_id: c.externalSystemId,
            external_customer_id: result.details.customer.id,
            business_unit_id: p.b.business_unit_id ?? null,
            contract_value: null,
            target_margin: null,
            currency: "USD",
            source_kind: "external",
          });
          id = created.id as string;
        }
        await applySource(ctx, id, c, result.details);
        await storeReadLabor(ctx, id, result.labor);
        await storeReadAr(ctx, id, c.externalSystemId, result.details.jobs.map((job) => job.id), result.ar);
        if (!p.manual) {
          await storeComputedFieldStart(ctx.db, id, result.fieldStart);
        }
        sendData(
          ctx.res,
          {
            id,
            project: result.details.project,
            linkedJobs: result.details.jobs.length,
            ...arNotice(result.ar),
          },
          undefined,
          existing.rows.length ? 200 : 201,
        );
      },
    ),
  );
  router.get(
    "/servicetitan/projects",
    staffExternalRoute(
      deps,
      async (ctx) => {
        if(!can(ctx.staff.role,"create_project"))requireCapability(ctx.staff.role, "advance_stage");
        const c = await binding(ctx);
        const q = parseBody(
          z.object({
            page: z.coerce.number().int().min(1).max(10000).default(1),
            number: z.string().max(100).optional(),
          }),
          ctx.req.query,
        );
        return { c, q };
      },
      (p) => p.c.client.listProjects!(p.q.page, p.q.number),
      async (ctx, _p, result) => {
        if(!can(ctx.staff.role,"create_project"))requireCapability(ctx.staff.role, "advance_stage");
        await binding(ctx);
        sendData(ctx.res, result);
      },
    ),
  );
  router.get(
    "/projects/:id/servicetitan",
    staffRoute(deps, async (ctx) => {
      const id = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, id, "id");
      const r = await ctx.db.query(
        "SELECT external_project_id,external_system_id,connection_key,snapshot,observed_at FROM projects.st_project_connections WHERE project_id=$1",
        [id],
      );
      let configured = false;
      try {
        await binding(ctx);
        configured = true;
      } catch {}
      const c = sources.serviceTitan;
      sendData(ctx.res, {
        configured,
        connection: r.rows[0] ?? null,
        connectionMatches:
          !!r.rows[0] &&
          r.rows[0].connection_key === c?.key &&
          r.rows[0].external_system_id === c?.externalSystemId,
      });
    }),
  );
  router.post(
    "/projects/:id/servicetitan",
    staffExternalRoute(
      deps,
      async (ctx) => {
        requireCapability(ctx.staff.role, "advance_stage");
        const id = parseUuidParam(ctx.req.params.id, "Project");
        const project = await loadVisibleProject<{
          field_start_source: string | null;
        }>(ctx, id, "id, field_start_source");
        const b = parseBody(
          z.object({ external_project_id: z.string().regex(/^\d+$/) }).strict(),
          ctx.req.body,
        );
        const c = await binding(ctx);
        const since = await ctx.db.query<{ observed_at: Date | null }>(
          `SELECT max(observed_at) AS observed_at FROM projects.st_invoice_observations WHERE project_id = $1`,
          [id],
        );
        return {
          id,
          b,
          c,
          manual: project.field_start_source === "manual",
          modifiedSince: since.rows[0]?.observed_at?.toISOString() ?? null,
        };
      },
      async (p) => {
        const details = await p.c.client.readProjectDetails!(
          p.b.external_project_id,
        );
        const fieldStart = p.manual
          ? null
          : await pickFieldStart(
              details.jobs.map((job) => job.id),
              (id) => p.c.client.readJob(id),
              details.project.id,
            );
        const labor = await readLinkedLabor(
          p.c.client,
          details.jobs.map((job) => job.id),
        );
        const ar = await readLinkedAr(p.c.client, p.modifiedSince);
        return { details, fieldStart, labor, ar };
      },
      async (ctx, p, result) => {
        requireCapability(ctx.staff.role, "advance_stage");
        await loadVisibleProject(ctx, p.id, "id");
        const c = await binding(ctx);
        if (c.key !== p.c.key || c.externalSystemId !== p.c.externalSystemId)
          throw new ApiError(
            "conflict",
            "ServiceTitan connection changed; refresh before linking.",
          );
        await applySource(ctx, p.id, c, result.details);
        await storeReadLabor(ctx, p.id, result.labor);
        await storeReadAr(
          ctx,
          p.id,
          c.externalSystemId,
          result.details.jobs.map((job) => job.id),
          result.ar,
        );
        if (!p.manual) {
          await storeComputedFieldStart(ctx.db, p.id, result.fieldStart);
        }
        sendData(ctx.res, {
          project: result.details.project,
          observedAt: result.details.observedAt,
          linkedJobs: result.details.project.jobIds.length,
          ...arNotice(result.ar),
        });
      },
    ),
  );
  router.post(
    "/projects/:id/field-start/refresh",
    staffExternalRoute(
      deps,
      async (ctx) => {
        requireCapability(ctx.staff.role, "refresh_field_start");
        const id = parseUuidParam(ctx.req.params.id, "Project");
        const project = await loadVisibleProject<{
          field_start_source: string | null;
        }>(ctx, id, "id, field_start_source");
        if (project.field_start_source === "manual") {
          return {
            id,
            manual: true,
            jobIds: [] as string[],
            externalProjectId: null as string | null,
            readJob: null as
              | ((jobId: string) => Promise<Awaited<ReturnType<ServiceTitanReadAdapter["readJob"]>>>)
              | null,
          };
        }
        const c = await binding(ctx);
        const linked = await ctx.db.query<{
          connection_key: string | null;
          external_project_id: string;
        }>(
          `SELECT connection_key, external_project_id
             FROM projects.st_project_connections
            WHERE project_id = $1 AND external_system_id = $2`,
          [id, c.externalSystemId],
        );
        if (
          linked.rows[0]?.connection_key &&
          linked.rows[0].connection_key !== c.key
        ) {
          throw new ApiError(
            "conflict",
            "The ST account changed. Reconnect the project before refreshing field start.",
          );
        }
        const jobs = await ctx.db.query<{ external_job_id: string }>(
          `SELECT external_job_id
             FROM projects.project_job_links
            WHERE project_id = $1 AND external_system_id = $2 AND source_active
            ORDER BY external_job_id`,
          [id, c.externalSystemId],
        );
        return {
          id,
          manual: false,
          jobIds: jobs.rows.map((row) => row.external_job_id),
          externalProjectId: linked.rows[0]?.external_project_id ?? null,
          readJob: (jobId: string) => c.client.readJob(jobId),
        };
      },
      async (prepared) => {
        if (prepared.manual || !prepared.readJob) return null;
        return pickFieldStart(
          prepared.jobIds,
          prepared.readJob,
          prepared.externalProjectId,
        );
      },
      async (ctx, prepared, picked) => {
        requireCapability(ctx.staff.role, "refresh_field_start");
        await loadVisibleProject(ctx, prepared.id, "id");
        if (!prepared.manual) {
          const c = await binding(ctx);
          if (!sources.serviceTitan || c.key !== sources.serviceTitan.key) {
            throw new ApiError(
              "conflict",
              "ServiceTitan connection changed; refresh before linking.",
            );
          }
          await storeComputedFieldStart(ctx.db, prepared.id, picked);
        }
        const row = await loadVisibleProject<Record<string, unknown>>(
          ctx,
          prepared.id,
        );
        sendData(ctx.res, { field_start: presentFieldStart(row) });
      },
    ),
  );
  router.post(
    "/projects/:id/servicetitan/ar-refresh",
    staffExternalRoute(
      deps,
      async (ctx) => {
        const id = parseUuidParam(ctx.req.params.id, "Project");
        await loadVisibleProject(ctx, id, "id");
        requireCapability(ctx.staff.role, "refresh_ar");
        const source = sources.serviceTitan;
        if (
          !source ||
          source.tenantId !== ctx.staff.tenantId ||
          !source.client.readInvoices ||
          !source.client.readPayments ||
          !source.client.readEstimates
        ) {
          throw new ApiError(
            "conflict",
            "ServiceTitan invoice read is not configured. Existing invoices were left as they are.",
          );
        }
        const jobs = await ctx.db.query<{ external_job_id: string }>(
          `SELECT external_job_id FROM projects.project_job_links
            WHERE project_id = $1 AND external_system_id = $2 AND source_active
            ORDER BY external_job_id`,
          [id, source.externalSystemId],
        );
        const since = await ctx.db.query<{ observed_at: Date | null }>(
          `SELECT max(observed_at) AS observed_at FROM projects.st_invoice_observations WHERE project_id = $1`,
          [id],
        );
        return {
          id,
          externalSystemId: source.externalSystemId,
          jobIds: jobs.rows.map((row) => row.external_job_id),
          modifiedSince: since.rows[0]?.observed_at?.toISOString() ?? null,
          readInvoices: source.client.readInvoices.bind(source.client),
          readPayments: source.client.readPayments.bind(source.client),
          readEstimates: source.client.readEstimates.bind(source.client),
        };
      },
      async (prepared) =>
        readLinkedAr(
          {
            readInvoices: prepared.readInvoices,
            readPayments: prepared.readPayments,
            readEstimates: prepared.readEstimates,
          },
          prepared.modifiedSince,
        ),
      async (ctx, prepared, ar) => {
        requireCapability(ctx.staff.role, "refresh_ar");
        await loadVisibleProject(ctx, prepared.id, "id");
        if (!ar) {
          throw new ApiError(
            "conflict",
            "ServiceTitan invoice read is not configured. Existing invoices were left as they are.",
          );
        }
        await storeReadAr(ctx, prepared.id, prepared.externalSystemId, prepared.jobIds, ar);
        sendData(ctx.res, {
          refreshed: !ar.forbidden,
          ...(ar.forbidden ? { message: AR_READ_REFUSED } : {}),
        });
      },
    ),
  );
  return router;
}

async function readLinkedLabor(
  client: SourceConnections["serviceTitan"] extends infer T
    ? T extends { client: infer C }
      ? C
      : never
    : never,
  jobIds: string[],
): Promise<LaborJobResult[] | null> {
  if (!client?.readJobTimesheets) return null;
  return readLaborJobs(jobIds, {
    readJobTimesheets: (jobId) => client.readJobTimesheets!(jobId),
    readJob: (jobId) => client.readJob(jobId),
  });
}

async function storeReadLabor(
  ctx: StaffContext,
  projectId: string,
  labor: LaborJobResult[] | null,
): Promise<void> {
  if (!labor?.length) return;
  const links = await ctx.db.query<{ id: string; external_job_id: string }>(
    `SELECT id, external_job_id FROM projects.project_job_links WHERE project_id = $1`,
    [projectId],
  );
  const observedAt = new Date();
  for (const result of labor) {
    const link = links.rows.find((row) => row.external_job_id === result.jobId);
    await storeJobLabor(ctx.db, {
      tenantId: ctx.staff.tenantId,
      projectId,
      jobId: result.jobId,
      jobLinkId: link?.id ?? null,
      result,
      observedAt,
    });
  }
  await stampLaborCodes(ctx.db, ctx.staff.tenantId, projectId);
}

async function readLinkedAr(
  client: {
    readInvoices?: (modifiedSince: string | null) => Promise<{ forbidden: boolean; invoices: ArRead["invoices"] }>;
    readPayments?: (modifiedSince: string | null) => Promise<{ forbidden: boolean; payments: ArRead["payments"] }>;
    readEstimates?: (modifiedSince: string | null) => Promise<{ forbidden: boolean; estimates: ArRead["estimates"] }>;
  },
  modifiedSince: string | null,
): Promise<ArRead | null> {
  if (!client.readInvoices || !client.readPayments || !client.readEstimates) return null;
  const [invoices, payments, estimates] = await Promise.all([
    client.readInvoices(modifiedSince),
    client.readPayments(modifiedSince),
    client.readEstimates(modifiedSince),
  ]);
  if (invoices.forbidden || payments.forbidden || estimates.forbidden) {
    return { forbidden: true, invoices: [], payments: [], estimates: [] };
  }
  return {
    forbidden: false,
    invoices: invoices.invoices,
    payments: payments.payments,
    estimates: estimates.estimates,
  };
}

async function storeReadAr(
  ctx: StaffContext,
  projectId: string,
  externalSystemId: string,
  jobIds: string[],
  ar: ArRead | null,
): Promise<void> {
  if (!ar) return;
  await storeProjectAr(ctx.db, {
    tenantId: ctx.staff.tenantId,
    projectId,
    externalSystemId,
    jobIds,
    read: ar,
  });
}

function arNotice(ar: ArRead | null): { ar?: { refreshed: boolean; message?: string } } {
  if (!ar) return {};
  return ar.forbidden
    ? { ar: { refreshed: false, message: AR_READ_REFUSED } }
    : { ar: { refreshed: true } };
}
