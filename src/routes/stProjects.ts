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
import {
  applyTechnicianDirectory,
  PAID_LABOR_LOOKBACK_DAYS,
  readPaidLabor,
  readTechnicianDirectory,
  storeJobLabor,
  withResolvedTechnicianNames,
  type LaborJobResult,
  type PaidLaborRead,
  type TechnicianDirectory,
} from "../domain/laborActuals.js";
import { sourceWindowStart } from "../domain/sourceFloor.js";
import {
  readStoredReconciliation,
  writeFinancialReconciliation,
} from "../domain/projectSync.js";
import { applyResolvedLaborCode, resolveStLaborCode, type StLaborResolve } from "../domain/stLaborCode.js";
import { AR_READ_REFUSED, storeProjectAr, type ArRead } from "../domain/arMatch.js";
import type { ServiceTitanReadAdapter } from "../adapters/serviceTitan.js";
import { applyInboundStatus } from "../domain/stStatusSync.js";
import {
  collectPlanAppointments,
  collectedFromReads,
  refreshProjectPlanAppointments,
  type CollectedPlanAppointments,
  type PlanJobRead,
} from "../domain/planAppointments.js";
import { statusSnapshotFromProject, type StStatusCatalog } from "../domain/stStatusMap.js";
import {
  pickFieldStart,
  presentFieldStart,
  storeComputedFieldStart,
  type FieldStartPick,
} from "../domain/fieldStart.js";
type Details = Awaited<
  ReturnType<ServiceTitanReadAdapter["readProjectDetails"]>
>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The stored snapshot. A failed contact read keeps the phone, email, and
 * contact lists from the previous snapshot instead of wiping them.
 */
function connectionSnapshot(result: Details, priorSnapshot: unknown) {
  const prior = asRecord(priorSnapshot);
  const priorCustomer = asRecord(prior.customer);
  const priorLocation = asRecord(prior.location);
  const customer: Record<string, unknown> = {
    id: result.customer.id,
    name: result.customer.name,
  };
  const location: Record<string, unknown> = { ...result.location };
  delete location.contacts;
  if (result.customer.contactsRead === false) {
    if ("phone" in priorCustomer) customer.phone = priorCustomer.phone;
    if ("email" in priorCustomer) customer.email = priorCustomer.email;
    if ("contacts" in priorCustomer) customer.contacts = priorCustomer.contacts;
    if ("contacts" in priorLocation) location.contacts = priorLocation.contacts;
  } else if (result.customer.contactsRead === true) {
    customer.phone = result.customer.phone;
    customer.email = result.customer.email;
    customer.contacts = result.customer.contacts ?? [];
    location.contacts = result.location.contacts ?? [];
  } else {
    if (result.customer.phone != null) customer.phone = result.customer.phone;
    if (result.customer.email != null) customer.email = result.customer.email;
    if (result.customer.contacts) customer.contacts = result.customer.contacts;
    if (result.location.contacts) location.contacts = result.location.contacts;
  }
  return { ...result.project, customer, location };
}
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
  async function statusCatalog(client: {
    readStatusCatalog?: () => Promise<StStatusCatalog>;
  }): Promise<StStatusCatalog | null> {
    if (!client.readStatusCatalog) return null;
    try {
      return await client.readStatusCatalog();
    } catch {
      return null;
    }
  }
  async function applySource(
    ctx: StaffContext,
    id: string,
    c: NonNullable<SourceConnections["serviceTitan"]>,
    result: Details,
    catalog: StStatusCatalog | null = null,
  ) {
    await ctx.db.query(
      "SELECT id FROM projects.projects WHERE id=$1 FOR UPDATE",
      [id],
    );
    const prior = await ctx.db.query<{
      external_project_id: string;
      connection_key: string;
      observed_at: string;
      snapshot: unknown;
    }>(
      "SELECT external_project_id,connection_key,observed_at,snapshot FROM projects.st_project_connections WHERE project_id=$1",
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
        JSON.stringify(connectionSnapshot(result, prior.rows[0]?.snapshot)),
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
    await applyInboundStatus(ctx.db, {
      tenantId: ctx.staff.tenantId,
      projectId: id,
      actor: { type: "staff", id: ctx.staff.staffId, name: ctx.staff.fullName },
      snapshot: statusSnapshotFromProject(result.project),
      catalog,
    });
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
        const read = await readOptionalSources(
          p.c.client,
          p.b.external_project_id,
          p.manual,
          p.modifiedSince,
        );
        return {
          ...read,
          catalog: await statusCatalog(p.c.client),
          planAppointments: read.planAppointments,
        };
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
        await applySource(ctx, id, c, result.details, result.catalog);
        await recordPlanAppointments(ctx, id, result.details.jobs, result.planAppointments, result.warnings);
        await storeReadLabor(ctx, id, result.labor, result.directory, result.laborCode);
        await storeReadAr(ctx, id, c.externalSystemId, result.details.jobs.map((job) => job.id), result.ar);
        if (!p.manual && result.fieldStartRead !== "failed") {
          await storeComputedFieldStart(ctx.db, id, result.fieldStart);
        }
        await recordSourceWarnings(ctx, id, result.warnings);
        sendData(
          ctx.res,
          {
            id,
            project: result.details.project,
            linkedJobs: result.details.jobs.length,
            warnings: result.warnings,
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
        const read = await readOptionalSources(
          p.c.client,
          p.b.external_project_id,
          p.manual,
          p.modifiedSince,
        );
        return {
          ...read,
          catalog: await statusCatalog(p.c.client),
          planAppointments: read.planAppointments,
        };
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
        await applySource(ctx, p.id, c, result.details, result.catalog);
        await recordPlanAppointments(ctx, p.id, result.details.jobs, result.planAppointments, result.warnings);
        await storeReadLabor(ctx, p.id, result.labor, result.directory, result.laborCode);
        await storeReadAr(
          ctx,
          p.id,
          c.externalSystemId,
          result.details.jobs.map((job) => job.id),
          result.ar,
        );
        if (!p.manual && result.fieldStartRead !== "failed") {
          await storeComputedFieldStart(ctx.db, p.id, result.fieldStart);
        }
        await recordSourceWarnings(ctx, p.id, result.warnings);
        sendData(ctx.res, {
          project: result.details.project,
          observedAt: result.details.observedAt,
          linkedJobs: result.details.project.jobIds.length,
          warnings: result.warnings,
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
          !source.client.readInvoicesForJobs ||
          !source.client.readPaymentsAppliedTo ||
          !source.client.readEstimatesForProject
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
        const link = await ctx.db.query<{ external_project_id: string }>(
          `SELECT external_project_id FROM projects.st_project_connections
            WHERE project_id = $1 AND external_system_id = $2`,
          [id, source.externalSystemId],
        );
        if (!link.rows[0]) {
          throw new ApiError(
            "conflict",
            "This project is not linked to ServiceTitan. Existing invoices were left as they are.",
          );
        }
        const since = await ctx.db.query<{ observed_at: Date | null }>(
          `SELECT max(observed_at) AS observed_at FROM projects.st_invoice_observations WHERE project_id = $1`,
          [id],
        );
        return {
          id,
          externalSystemId: source.externalSystemId,
          jobIds: jobs.rows.map((row) => row.external_job_id),
          projectId: link.rows[0].external_project_id,
          modifiedSince: since.rows[0]?.observed_at?.toISOString() ?? null,
          client: source.client,
        };
      },
      async (prepared) =>
        readLinkedAr(prepared.client, {
          jobIds: prepared.jobIds,
          projectId: prepared.projectId,
          modifiedSince: prepared.modifiedSince,
        }),
      async (ctx, prepared, result) => {
        requireCapability(ctx.staff.role, "refresh_ar");
        await loadVisibleProject(ctx, prepared.id, "id");
        if (!result.ar) {
          if (result.warnings.length) await recordSourceWarnings(ctx, prepared.id, result.warnings);
          sendData(ctx.res, {
            refreshed: false,
            message: result.warnings.join("; ") || "ServiceTitan invoice read is not configured. Existing invoices were left as they are.",
          });
          return;
        }
        if (!result.ar.forbidden) {
          await storeReadAr(ctx, prepared.id, prepared.externalSystemId, prepared.jobIds, result.ar);
        }
        if (result.warnings.length) await recordSourceWarnings(ctx, prepared.id, result.warnings);
        sendData(ctx.res, {
          refreshed: !result.ar.forbidden,
          ...(result.ar.forbidden ? { message: AR_READ_REFUSED } : {}),
          ...(result.warnings.length ? { warnings: result.warnings } : {}),
        });
      },
    ),
  );
  return router;
}

type StClient = NonNullable<SourceConnections["serviceTitan"]>["client"];

function sourceText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function recordPlanAppointments(
  ctx: StaffContext,
  projectId: string,
  jobs: readonly { id: string }[],
  collected: CollectedPlanAppointments,
  warnings: string[],
): Promise<void> {
  await ctx.db.query("SAVEPOINT plan_appointments");
  try {
    const saved = await refreshProjectPlanAppointments(ctx.db, {
      tenantId: ctx.staff.tenantId,
      projectId,
      jobs: jobs.map((job) => ({ external_job_id: job.id })),
      collected,
    });
    await ctx.db.query("RELEASE SAVEPOINT plan_appointments");
    for (const warning of saved.warnings) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  } catch (err) {
    await ctx.db.query("ROLLBACK TO SAVEPOINT plan_appointments");
    warnings.push(`Appointments: ${sourceText(err)}`);
  }
}

function laborWindow(jobs: readonly { createdOn?: string | null }[]): { start: string; missingCreatedOn: boolean } {
  let earliest: number | null = null;
  for (const job of jobs) {
    const created = job.createdOn ? Date.parse(job.createdOn) : NaN;
    if (Number.isFinite(created) && (earliest == null || created < earliest)) earliest = created;
  }
  return {
    missingCreatedOn: earliest == null,
    start: sourceWindowStart(
      earliest == null ? null : earliest - 86_400_000,
      Date.now(),
      PAID_LABOR_LOOKBACK_DAYS * 86_400_000,
    ).toISOString(),
  };
}

async function readOptionalSources(
  client: StClient,
  externalProjectId: string,
  manual: boolean,
  modifiedSince: string | null,
): Promise<{
  details: Details;
  fieldStart: FieldStartPick | null;
  fieldStartRead: "ok" | "failed";
  labor: LaborJobResult[] | null;
  directory: TechnicianDirectory;
  laborCode: StLaborResolve;
  ar: ArRead | null;
  warnings: string[];
  planAppointments: CollectedPlanAppointments;
}> {
  const details = await client.readProjectDetails!(externalProjectId);
  const warnings = [...(details.warnings ?? [])];
  const jobIds = details.jobs.map((job) => job.id);
  const planJobs = jobIds.map((id) => ({ external_job_id: id }));
  const planReads = new Map<string, PlanJobRead>();
  const planFailed: { jobId: string; message: string }[] = [];
  let fieldStart: FieldStartPick | null = null;
  let fieldStartRead: "ok" | "failed" = "ok";
  if (!manual) {
    try {
      const knownJobs = new Map(details.jobs.map((job) => [job.id, job]));
      fieldStart = await pickFieldStart(
        jobIds,
        async (id) => {
          try {
            const read = client.readJobSchedule
              ? await client.readJobSchedule(id, knownJobs.get(id) ?? null)
              : await client.readJob(id);
            planReads.set(id, read);
            return read;
          } catch (err) {
            const message = sourceText(err);
            warnings.push(`Job ${id} appointments: ${message}`);
            planFailed.push({ jobId: id, message });
            return {
              job: { id, jobStatus: "Unknown", projectId: details.project.id },
              appointments: [],
              observedAt: new Date().toISOString(),
            };
          }
        },
        details.project.id,
      );
    } catch (err) {
      fieldStartRead = "failed";
      warnings.push(`Field start: ${sourceText(err)}`);
    }
  }
  let planAppointments: CollectedPlanAppointments;
  try {
    planAppointments = manual
      ? await collectPlanAppointments((jobId) => client.readJob(jobId), planJobs)
      : collectedFromReads(planJobs, planReads, planFailed);
  } catch (err) {
    const message = sourceText(err);
    planAppointments = {
      appointments: [],
      skipped: 0,
      failedJobs: planJobs.map((job) => ({ jobId: job.external_job_id, message })),
      warnings: [`Appointments: ${message}`],
    };
  }
  warnings.push(...planAppointments.warnings.filter((warning) => !warnings.includes(warning)));
  let labor: LaborJobResult[] | null = null;
  try {
    const window = laborWindow(details.jobs);
    if (client.readGrossPayItems && window.missingCreatedOn) {
      warnings.push(
        "Payroll gross pay items: no job creation date was returned, so the window is the last 120 days.",
      );
    }
    const paid = await readLinkedLabor(client, details.jobs, window.start);
    if (paid) {
      labor = paid.results;
      warnings.push(...paid.warnings);
    }
  } catch (err) {
    warnings.push(`Payroll gross pay items: ${sourceText(err)} Stored hours kept.`);
    labor = jobIds.map((jobId) => ({ jobId, outcome: "keep", drafts: [], failed: true }));
  }
  let directory: TechnicianDirectory = { read: false, forbidden: false, technicians: [] };
  try {
    directory = await readTechnicianDirectory(client);
  } catch (err) {
    warnings.push(`Technicians: ${sourceText(err)}`);
  }
  if (labor) {
    try {
      labor = await withResolvedTechnicianNames(
        labor,
        directory.technicians,
        client.readStaffName?.bind(client),
      );
    } catch (err) {
      warnings.push(`Technician names: ${sourceText(err)}`);
    }
  }
  const laborCode = await resolveStLaborCode(client);
  let ar: ArRead | null = null;
  try {
    const linked = await readLinkedAr(client, {
      jobIds,
      projectId: externalProjectId,
      modifiedSince,
    });
    ar = linked.ar;
    warnings.push(...linked.warnings);
  } catch (err) {
    warnings.push(`Invoices: ${sourceText(err)}`);
  }
  return { details, fieldStart, fieldStartRead, labor, directory, laborCode, ar, warnings, planAppointments };
}

async function recordSourceWarnings(ctx: StaffContext, projectId: string, warnings: string[]): Promise<void> {
  if (!warnings.length) return;
  const prior = await readStoredReconciliation(ctx.db, projectId);
  await writeFinancialReconciliation(ctx.db, {
    tenantId: ctx.staff.tenantId,
    projectId,
    observedAt: new Date(),
    lines: prior?.lines ?? [],
    technicians: prior?.technicians ?? [],
    error: warnings.join("; "),
  });
}

async function readLinkedLabor(
  client: StClient,
  jobs: readonly { id: string; jobStatus?: string | null }[],
  dateOnOrAfter: string,
): Promise<PaidLaborRead | null> {
  if (!client?.readJobTimesheets && !client?.readJobTimesheetsForJobs && !client?.readGrossPayItems) return null;
  return readPaidLabor(
    jobs.map((job) => job.id),
    {
      readGrossPayItems: client.readGrossPayItems
        ? (query) => client.readGrossPayItems!(query)
        : undefined,
      readJobTimesheets: client.readJobTimesheets
        ? (jobId) => client.readJobTimesheets!(jobId)
        : undefined,
      readJob: (jobId) => client.readJob(jobId),
    },
    { dateOnOrAfter },
  );
}

async function storeReadLabor(
  ctx: StaffContext,
  projectId: string,
  labor: LaborJobResult[] | null,
  directory: TechnicianDirectory,
  laborCode: StLaborResolve,
): Promise<void> {
  const observedAt = new Date();
  if (labor?.length) {
    const links = await ctx.db.query<{ id: string; external_job_id: string }>(
      `SELECT id, external_job_id FROM projects.project_job_links WHERE project_id = $1`,
      [projectId],
    );
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
  }
  await applyTechnicianDirectory(ctx.db, ctx.staff.tenantId, directory, observedAt);
  await applyResolvedLaborCode(ctx.db, ctx.staff.tenantId, laborCode);
}

async function readLinkedAr(
  client: StClient,
  input: { jobIds: string[]; projectId: string; modifiedSince: string | null },
): Promise<{ ar: ArRead | null; warnings: string[] }> {
  if (!client.readInvoicesForJobs || !client.readPaymentsAppliedTo || !client.readEstimatesForProject) {
    return { ar: null, warnings: [] };
  }
  const warnings: string[] = [];
  let invoices: Awaited<ReturnType<NonNullable<StClient["readInvoicesForJobs"]>>>;
  try {
    invoices = await client.readInvoicesForJobs(input.jobIds, input.modifiedSince);
  } catch (err) {
    return { ar: null, warnings: [`Invoices: ${sourceText(err)}`] };
  }
  warnings.push(...invoices.warnings);
  if (invoices.forbidden) {
    return { ar: { forbidden: true, invoices: [], payments: [], estimates: [] }, warnings };
  }
  if (invoices.incomplete) {
    if (!warnings.length) warnings.push("Invoices: the project invoice read was incomplete. Existing invoices were left as they are.");
    return { ar: null, warnings };
  }
  let payments: Awaited<ReturnType<NonNullable<StClient["readPaymentsAppliedTo"]>>>;
  try {
    payments = await client.readPaymentsAppliedTo(
      invoices.invoices.map((row) => row.externalInvoiceId),
      input.modifiedSince,
    );
  } catch (err) {
    warnings.push(`Payments: ${sourceText(err)} Existing invoices were left as they are.`);
    return { ar: null, warnings };
  }
  if (payments.forbidden) {
    return { ar: { forbidden: true, invoices: [], payments: [], estimates: [] }, warnings };
  }
  if (payments.capped) {
    warnings.push("Payments: pagination limit reached. Existing invoices were left as they are.");
    return { ar: null, warnings };
  }
  let estimates: Awaited<ReturnType<NonNullable<StClient["readEstimatesForProject"]>>>;
  try {
    estimates = await client.readEstimatesForProject(input.projectId, input.modifiedSince);
  } catch (err) {
    warnings.push(`Estimates: ${sourceText(err)} Existing invoices were left as they are.`);
    return { ar: null, warnings };
  }
  if (estimates.forbidden) {
    return { ar: { forbidden: true, invoices: [], payments: [], estimates: [] }, warnings };
  }
  if (estimates.capped) {
    warnings.push("Estimates: pagination limit reached. Existing invoices were left as they are.");
    return { ar: null, warnings };
  }
  if (invoices.capped) {
    warnings.push("Invoices: pagination limit reached. Existing invoices were left as they are.");
    return { ar: null, warnings };
  }
  return {
    ar: {
      forbidden: false,
      invoices: invoices.invoices,
      payments: payments.payments,
      estimates: estimates.estimates,
    },
    warnings,
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
