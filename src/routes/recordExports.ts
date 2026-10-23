import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  staffRoute,
  staffExternalRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import { requireCapability } from "../http/capabilities.js";
import { ApiError, notFound } from "../http/errors.js";
import { sendData } from "../http/envelope.js";
import { loadVisibleProject, parseBody, parseUuidParam } from "./shared.js";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import type { ControlRecord } from "../domain/projectControls.js";
import {
  documentHtml,
  recordContent,
  renderDocumentPdf,
  type ExportModel,
} from "../domain/documentExport.js";

export function recordExportRoutes(
  deps: StaffRouterDeps,
  sources: SourceConnections = {},
) {
  const router = Router();
  const base = "/projects/:id/controls/:recordId";
  async function record(ctx: StaffContext, write = false) {
    const projectId = parseUuidParam(ctx.req.params.id, "Project");
    const project = await loadVisibleProject(ctx, projectId);
    const row = (
      await ctx.db.query<ControlRecord>(
        "SELECT * FROM projects.project_controls WHERE id=$1 AND project_id=$2",
        [parseUuidParam(ctx.req.params.recordId, "Record"), projectId],
      )
    ).rows[0];
    if (!row) throw notFound("Project record not found");
    if (row.kind === "reserve")
      requireCapability(ctx.staff.role, "view_margin");
    if (write) {
      requireCapability(
        ctx.staff.role,
        row.kind === "document"
          ? "manage_project_documents"
          : row.kind === "reserve"
            ? "manage_project_reserves"
            : "manage_project_controls",
      );
      if (!row.active)
        throw new ApiError("conflict", "Archived records cannot be published.");
    }
    return { projectId, project, row };
  }
  async function model(
    ctx: StaffContext,
    p: Awaited<ReturnType<typeof record>>,
  ): Promise<ExportModel> {
    const company =
      (
        await ctx.db.query<{ name: string }>(
          "SELECT display_name AS name FROM projects.tenants WHERE id=$1",
          [ctx.staff.tenantId],
        )
      ).rows[0]?.name ?? "Journeyman Projects";
    const owner = p.row.data.owner_id
      ? ((
          await ctx.db.query<{ full_name: string }>(
            "SELECT full_name FROM projects.staff WHERE id=$1",
            [p.row.data.owner_id],
          )
        ).rows[0]?.full_name ?? "Unassigned")
      : "Unassigned";
    const data = { ...p.row.data };
    if (p.row.kind !== "document") {
      const linked = (
        await ctx.db.query<{ id: string; data: { title: string } }>(
          "SELECT id,data FROM projects.project_controls WHERE project_id=$1",
          [p.projectId],
        )
      ).rows;
      for (const key of ["parent_id", "milestone_id", "goal_id", "risk_id"]) {
        if (data[key])
          data[key.replace("_id", "")] =
            linked.find((r) => r.id === data[key])?.data.title ??
            "Record unavailable";
        delete data[key];
      }
      if (data.dependency_ids?.length)
        data.predecessors = data.dependency_ids
          .map(
            (id: string) =>
              linked.find((r) => r.id === id)?.data.title ??
              "Record unavailable",
          )
          .join("\n");
      delete data.dependency_ids;
      delete data.sort_order;
      for (const [key, table, column, label] of [
        ["resource_id", "scheduling_resources", "name", "assigned_crew"],
        ["job_link_id", "project_job_links", "external_job_id", "st_job"],
      ] as const) {
        if (data[key])
          data[label] =
            (
              await ctx.db.query<Record<string, string>>(
                `SELECT ${column} FROM projects.${table} WHERE id=$1`,
                [data[key]],
              )
            ).rows[0]?.[column] ?? "Unavailable";
        delete data[key];
      }
      if (p.row.kind === "reserve")
        for (const key of ["allocated", "drawn"])
          data[key] = Number(data[key]).toLocaleString("en-US", {
            style: "currency",
            currency: String(p.project.currency || "USD"),
          });
    }
    return {
      title: String(p.row.data.title),
      project: String(p.project.name ?? ""),
      number: String(p.project.project_number ?? ""),
      address: [
        p.project.address_line1,
        p.project.city,
        p.project.region,
        p.project.postal_code,
      ]
        .filter(Boolean)
        .join(", "),
      company,
      revision: p.row.version,
      updated: new Date(p.row.updated_at).toISOString().slice(0, 10),
      owner,
      category: String(p.row.data.folder ?? p.row.kind).replaceAll("_", " "),
      content: recordContent({ ...p.row, data }),
    };
  }
  const fileName = (title: string) =>
    title
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._ -]/gu, "_")
      .slice(0, 100) || "Project-record";
  router.get(
    base + "/preview",
    staffRoute(deps, async (ctx) => {
      const p = await record(ctx);
      ctx.res.set("Cache-Control", "no-store");
      sendData(ctx.res, {
        html: documentHtml(await model(ctx, p)),
        version: p.row.version,
      });
    }),
  );
  router.get(
    base + "/pdf",
    staffRoute(deps, async (ctx) => {
      const p = await record(ctx);
      const bytes = await renderDocumentPdf(await model(ctx, p));
      ctx.res.set("Cache-Control", "no-store");
      sendData(ctx.res, {
        file_name: `${fileName(String(p.row.data.title))}-r${p.row.version}.pdf`,
        media_type: "application/pdf",
        content: bytes.toString("base64"),
      });
    }),
  );
  async function binding(ctx: StaffContext, projectId: string) {
    const c = sources.serviceTitan;
    const link = (
      await ctx.db.query<{
        external_project_id: string;
        connection_key: string;
        external_system_id: string;
      }>(
        "SELECT c.external_project_id,c.connection_key,c.external_system_id FROM projects.st_project_connections c JOIN projects.external_systems e ON e.id=c.external_system_id AND e.active AND e.adapter_key='servicetitan' WHERE c.project_id=$1",
        [projectId],
      )
    ).rows[0];
    if (
      !c ||
      c.tenantId !== ctx.staff.tenantId ||
      !link ||
      link.connection_key !== c.key ||
      link.external_system_id !== c.externalSystemId ||
      !c.client.publishRecord ||
      !c.client.recordReceipts ||
      !c.client.readProjectDetails
    )
      throw new ApiError(
        "conflict",
        "Connect this project to the configured ST account before publishing.",
      );
    return { c, link };
  }
  type DocumentLink = {
    id: string;
    external_project_id: string;
    state: string;
    updated_at: string;
    url: string;
    note_text: string;
    record_version: number;
  };
  router.post(
    base + "/sync-link",
    staffExternalRoute(
      deps,
      async (ctx) => {
        const p = await record(ctx, true);
        if (p.row.kind !== "document") throw notFound("Document not found");
        const b = await binding(ctx, p.projectId);
        if (
          !b.c.writesEnabled ||
          !b.c.client.publishProjectNote ||
          !b.c.client.projectNoteReceipt
        )
          throw new ApiError(
            "conflict",
            "ST project note synchronization is not configured.",
          );
        const input = parseBody(
          z.object({ version: z.number().int().positive() }).strict(),
          ctx.req.body,
        );
        await ctx.db.query(
          "SELECT id FROM projects.projects WHERE id=$1 FOR UPDATE",
          [p.projectId],
        );
        const fresh = await record(ctx, true);
        if (input.version !== fresh.row.version)
          throw new ApiError(
            "conflict",
            "Document changed. Refresh before syncing its link.",
          );
        let link = (
          await ctx.db.query<DocumentLink>(
            "SELECT * FROM projects.document_links WHERE record_id=$1 AND record_version=$2 AND connection_key=$3 AND external_project_id=$4",
            [p.row.id, input.version, b.c.key, b.link.external_project_id],
          )
        ).rows[0];
        if (
          link?.state === "publishing" &&
          Date.now() - new Date(link.updated_at).getTime() < 120000
        )
          throw new ApiError(
            "conflict",
            "Link sync is in progress. Check again in two minutes.",
          );
        const checkOnly =
          link && ["publishing", "uncertain"].includes(link.state);
        const skip = link?.state === "confirmed";
        if (!link) {
          const origin =
            process.env.PM_PUBLIC_APP_URL ||
            (process.env.RAILWAY_PUBLIC_DOMAIN
              ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
              : "");
          let publicUrl: URL;
          try {
            publicUrl = new URL(origin);
          } catch {
            throw new ApiError(
              "conflict",
              "Set PM_PUBLIC_APP_URL before syncing document links.",
            );
          }
          if (
            publicUrl.protocol !== "https:" ||
            publicUrl.username ||
            publicUrl.password
          )
            throw new ApiError(
              "conflict",
              "PM_PUBLIC_APP_URL must be a public HTTPS address.",
            );
          const id = randomUUID();
          const url =
            publicUrl.origin +
            "/?project=" +
            p.projectId +
            "&document=" +
            p.row.id +
            "#documents";
          const file = (
            await ctx.db.query(
              "SELECT file_name FROM projects.project_control_files WHERE record_id=$1",
              [p.row.id],
            )
          ).rows[0];
          const note = `PM DOCUMENT [${id}]\n${fresh.row.data.title}\n${String(fresh.row.data.description || "Project document").slice(0, 2000)}\nRevision ${input.version}${file ? " - " + file.file_name : ""}\nOpen document: ${url}\nPM sign-in required. Link opens the current document; this note describes revision ${input.version}.`;
          link = (
            await ctx.db.query<DocumentLink>(
              "INSERT INTO projects.document_links(id,tenant_id,project_id,record_id,record_version,connection_key,external_project_id,url,note_text,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'publishing') RETURNING *",
              [
                id,
                ctx.staff.tenantId,
                p.projectId,
                p.row.id,
                input.version,
                b.c.key,
                b.link.external_project_id,
                url,
                note,
              ],
            )
          ).rows[0];
        } else if (!skip && !checkOnly)
          await ctx.db.query(
            "UPDATE projects.document_links SET state='publishing',updated_at=now() WHERE id=$1",
            [link.id],
          );
        if (!link)
          throw new ApiError("conflict", "Link record could not be saved.");
        return { ...p, ...b, link, skip, checkOnly };
      },
      async (p) => {
        if (p.skip)
          return {
            state: "confirmed",
            message: "Document link is already synchronized.",
          };
        const found = await p.c.client.projectNoteReceipt!(
          p.link.external_project_id,
          `PM DOCUMENT [${p.link.id}]`,
        );
        if (found)
          return {
            state: "confirmed",
            message: "Document link verified in ST project notes.",
          };
        if (p.checkOnly)
          return {
            state: "uncertain",
            message:
              "Note not confirmed. Check ST before another write; no duplicate was sent.",
          };
        return p.c.client.publishProjectNote!(
          p.link.external_project_id,
          p.link.note_text,
        );
      },
      async (ctx, p, result) => {
        await ctx.db.query(
          "UPDATE projects.document_links SET state=$2,message=$3,updated_at=now() WHERE id=$1",
          [p.link.id, result.state, result.message],
        );
        await ctx.db.query(
          "INSERT INTO projects.audit_log(tenant_id,actor_type,actor_id,entity_table,entity_id,action,after_data) VALUES($1,'staff',$2,'project_controls',$3,'st_document_link',$4::jsonb)",
          [
            ctx.staff.tenantId,
            ctx.staff.staffId,
            p.row.id,
            JSON.stringify({ state: result.state, url: p.link.url }),
          ],
        );
        sendData(ctx.res, {
          ...result,
          url: p.link.url,
          version: p.link.record_version,
        });
      },
    ),
  );
  const publicColumns =
    "id,record_version,format,external_project_id,external_job_id,state,file_name,sha256,attachment_id,message,created_at,updated_at";
  router.get(
    base + "/publications",
    staffRoute(deps, async (ctx) => {
      const p = await record(ctx);
      sendData(
        ctx.res,
        (
          await ctx.db.query(
            `SELECT ${publicColumns} FROM projects.record_publications WHERE record_id=$1 AND project_id=$2 ORDER BY created_at DESC`,
            [p.row.id, p.projectId],
          )
        ).rows,
      );
    }),
  );
  router.get(
    base + "/publish-targets",
    staffExternalRoute(
      deps,
      async (ctx) => {
        const p = await record(ctx, true);
        const b = await binding(ctx, p.projectId);
        return { ...p, ...b };
      },
      async (p) => {
        const result = await p.c.client.readProjectDetails!(
          p.link.external_project_id,
        );
        let accessError: string | null = null;
        if (result.jobs[0])
          try {
            await p.c.client.recordReceipts!(
              result.project.id,
              result.jobs[0].id,
              "__permission_check__",
              "__permission_check__",
            );
          } catch {
            accessError =
              "ST record access is unavailable. Enable Forms Jobs Read/Write and JPM Projects Read/Write on the connected ST developer app, then try again.";
          }
        return { ...result, accessError };
      },
      async (ctx, p, result) => {
        await record(ctx, true);
        await binding(ctx, p.projectId);
        sendData(ctx.res, {
          project: {
            id: result.project.id,
            number: result.project.number,
            name: result.project.name,
          },
          jobs: result.jobs
            .filter((j) => j.projectId === result.project.id)
            .map((j) => ({
              id: j.id,
              number: j.jobNumber,
              summary: j.summary,
            })),
          writesEnabled: p.c.writesEnabled === true && !result.accessError,
          accessError: result.accessError,
        });
      },
    ),
  );
  router.post(
    base + "/publish",
    staffExternalRoute(
      deps,
      async (ctx) => {
        const p = await record(ctx, true),
          b = await binding(ctx, p.projectId);
        if (!b.c.writesEnabled)
          throw new ApiError(
            "conflict",
            "ST publishing is disabled for this account.",
          );
        const input = parseBody(
          z
            .object({
              version: z.number().int().positive(),
              job_id: z.string().regex(/^\d+$/),
              format: z.enum(["pdf", "original"]),
            })
            .strict(),
          ctx.req.body,
        );
        await ctx.db.query(
          "SELECT id FROM projects.projects WHERE id=$1 FOR UPDATE",
          [p.projectId],
        );
        const current = await record(ctx, true);
        if (input.version !== current.row.version)
          throw new ApiError(
            "conflict",
            "Record changed. Refresh and review the current revision before publishing.",
          );
        let publication = (
          await ctx.db.query(
            "SELECT * FROM projects.record_publications WHERE record_id=$1 AND record_version=$2 AND format=$3 AND connection_key=$4 AND external_job_id=$5",
            [p.row.id, input.version, input.format, b.c.key, input.job_id],
          )
        ).rows[0];
        if (
          publication &&
          ["publishing", "uncertain"].includes(String(publication.state))
        )
          throw new ApiError(
            "conflict",
            "This revision has an unconfirmed ST write. Check ST receipt; it will not be uploaded again automatically.",
          );
        if (publication?.state === "confirmed")
          return { ...current, ...b, publication, skip: true };
        if (!publication) {
          const id = randomUUID();
          let bytes: Buffer, name: string, mediaType: string;
          if (input.format === "original") {
            const f = (
              await ctx.db.query<{
                file_data: Buffer;
                file_name: string;
                media_type: string;
              }>(
                "SELECT file_data,file_name,media_type FROM projects.project_control_files WHERE record_id=$1",
                [p.row.id],
              )
            ).rows[0];
            if (!f) throw notFound("Original attachment not found");
            bytes = Buffer.from(f.file_data);
            name = f.file_name;
            mediaType = f.media_type;
          } else {
            bytes = await renderDocumentPdf(await model(ctx, current));
            name = fileName(String(current.row.data.title)) + ".pdf";
            mediaType = "application/pdf";
          }
          if (bytes.length > 8388608)
            throw new ApiError(
              "validation_failed",
              "This PDF exceeds the 8 MB publishing limit. Split it into smaller records.",
            );
          name = `PM-r${input.version}-${id.slice(0, 8)}-${name}`;
          const hash = createHash("sha256").update(bytes).digest("hex");
          const note = `PM RECORD [${id}]\n${current.row.data.title}\nRevision ${input.version} · ${input.format === "pdf" ? "Formatted PDF" : "Original attachment"}\nProject ${current.project.project_number} · ST project ${b.link.external_project_id}\nStored on ST job ${input.job_id}\nFile: ${name}\nSHA-256: ${hash}\nPM record: ${p.row.id}\nThis is a revision snapshot. Required approvals are recorded separately.`;
          publication = (
            await ctx.db.query(
              `INSERT INTO projects.record_publications(id,tenant_id,project_id,record_id,record_version,format,connection_key,external_project_id,external_job_id,state,file_name,media_type,file_data,sha256,note_text,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'publishing',$10,$11,$12,$13,$14,$15) RETURNING *`,
              [
                id,
                ctx.staff.tenantId,
                p.projectId,
                p.row.id,
                input.version,
                input.format,
                b.c.key,
                b.link.external_project_id,
                input.job_id,
                name,
                mediaType,
                bytes,
                hash,
                note,
                ctx.staff.staffId,
              ],
            )
          ).rows[0]!;
        } else
          await ctx.db.query(
            "UPDATE projects.record_publications SET state='publishing',updated_at=now() WHERE id=$1",
            [publication.id],
          );
        return { ...current, ...b, publication, skip: false };
      },
      async (p) => {
        const q = p.publication;
        if (p.skip)
          return {
            state: "confirmed",
            attachmentId: q.attachment_id as string | null,
            message: String(q.message),
          };
        return p.c.client.publishRecord!({
          projectId: String(q.external_project_id),
          jobId: String(q.external_job_id),
          fileName: String(q.file_name),
          mediaType: String(q.media_type),
          bytes: Buffer.from(q.file_data as Uint8Array),
          note: String(q.note_text),
          attachmentId: q.attachment_id as string | null,
        });
      },
      async (ctx, p, result) => {
        // Persist the external outcome even if the editable draft changed during the transfer.
        const updated = await ctx.db.query(
          `UPDATE projects.record_publications SET state=$2,attachment_id=$3,message=$4,updated_at=now() WHERE id=$1 RETURNING ${publicColumns}`,
          [p.publication.id, result.state, result.attachmentId, result.message],
        );
        await ctx.db.query(
          `INSERT INTO projects.audit_log(tenant_id,actor_type,actor_id,entity_table,entity_id,action,after_data) VALUES($1,'staff',$2,'project_controls',$3,'st_published',$4::jsonb)`,
          [
            ctx.staff.tenantId,
            ctx.staff.staffId,
            p.row.id,
            JSON.stringify(updated.rows[0]),
          ],
        );
        sendData(ctx.res, updated.rows[0]);
      },
    ),
  );
  router.post(
    base + "/publications/:publicationId/check",
    staffExternalRoute(
      deps,
      async (ctx) => {
        const p = await record(ctx, true),
          b = await binding(ctx, p.projectId);
        const q = (
          await ctx.db.query(
            "SELECT * FROM projects.record_publications WHERE id=$1 AND record_id=$2 AND project_id=$3",
            [
              parseUuidParam(ctx.req.params.publicationId, "Publication"),
              p.row.id,
              p.projectId,
            ],
          )
        ).rows[0];
        if (
          !q ||
          q.connection_key !== b.c.key ||
          q.external_project_id !== b.link.external_project_id
        )
          throw notFound("Publication not found");
        if (
          q.state === "publishing" &&
          Date.now() - new Date(String(q.updated_at)).getTime() < 120000
        )
          throw new ApiError(
            "conflict",
            "Publishing is still in progress. Check again in two minutes.",
          );
        return { ...p, ...b, q };
      },
      async (p) =>
        p.c.client.recordReceipts!(
          String(p.q.external_project_id),
          String(p.q.external_job_id),
          String(p.q.file_name),
          `PM RECORD [${p.q.id}]`,
        ),
      async (ctx, p, receipt) => {
        const state =
          receipt.attachmentId && receipt.noteConfirmed
            ? "confirmed"
            : "uncertain";
        const message =
          state === "confirmed"
            ? "ST attachment and project note verified."
            : receipt.attachmentId
              ? "File found on ST job; project note not confirmed. Check ST before another write."
              : "ST receipt not confirmed. Check ST manually before another write.";
        const q = await ctx.db.query(
          `UPDATE projects.record_publications SET state=$2,attachment_id=COALESCE($3,attachment_id),message=$4,updated_at=now() WHERE id=$1 RETURNING ${publicColumns}`,
          [p.q.id, state, receipt.attachmentId, message],
        );
        sendData(ctx.res, q.rows[0]);
      },
    ),
  );
  return router;
}
