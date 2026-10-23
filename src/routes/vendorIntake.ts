import { Router } from "express";
import { z } from "zod";
import { staffRoute, type StaffRouterDeps } from "../http/staffSession.js";
import { requireCapability, unitFilter } from "../http/capabilities.js";
import { ApiError, notFound } from "../http/errors.js";
import { sendData } from "../http/envelope.js";
import { parseBody, parseUuidParam } from "./shared.js";
const kinds = [
  "tax_form",
  "gl_insurance",
  "wc_insurance",
  "auto_insurance",
  "license",
  "master_agreement",
  "other",
] as const;
const coverageSchema = z
  .array(z.enum(["gl_insurance", "wc_insurance", "auto_insurance"]))
  .min(1)
  .max(3)
  .refine(
    (values) => new Set(values).size === values.length,
    "Select each coverage once.",
  );
export function vendorIntakeRoutes(deps: StaffRouterDeps) {
  const router = Router();
  router.post(
    "/vendors/:id/documents/upload",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_vendors");
      const id = parseUuidParam(ctx.req.params.id, "Vendor");
      if (
        !(
          await ctx.db.query("SELECT id FROM projects.vendors WHERE id=$1", [
            id,
          ])
        ).rows.length
      )
        throw notFound("Vendor not found");
      const b = parseBody(
        z
          .object({
            kind: z.enum(kinds),
            coverage_kinds: coverageSchema.optional(),
            issued_on: z.string().date().nullish(),
            expires_on: z.string().date().nullish(),
            file_name: z.string().min(1).max(200),
            media_type: z.enum(["application/pdf", "image/png", "image/jpeg"]),
            content: z.string().min(1).max(11184812),
          })
          .strict(),
        ctx.req.body,
      );
      if (b.coverage_kinds && !b.coverage_kinds.some((kind) => kind === b.kind))
        throw new ApiError(
          "validation_failed",
          "Coverage must include the selected insurance category.",
        );
      if (b.kind.endsWith("_insurance") && !b.expires_on)
        throw new ApiError(
          "validation_failed",
          "An insurance expiration date is required.",
        );
      if (b.expires_on && b.issued_on && b.expires_on < b.issued_on)
        throw new ApiError(
          "validation_failed",
          "Expiration must be on or after the issue date.",
        );
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b.content))
        throw new ApiError("validation_failed", "Invalid file encoding.");
      const bytes = Buffer.from(b.content, "base64");
      const valid =
        b.media_type === "application/pdf"
          ? bytes.subarray(0, 5).toString() === "%PDF-"
          : b.media_type === "image/png"
            ? bytes
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!valid || bytes.length > 8388608 || bytes.length < 8)
        throw new ApiError(
          "validation_failed",
          "Choose a valid PDF, PNG or JPEG up to 8 MB.",
        );
      const name = b.file_name.replace(/[\x00-\x1f\\/]/g, "_");
      const r = await ctx.db.query(
        `INSERT INTO projects.vendor_documents(tenant_id,vendor_id,kind,issued_on,expires_on,file_name,media_type,file_data,file_size,coverage_kinds) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::projects.doc_kind[]) RETURNING id,kind,file_name,expires_on,file_size,coverage_kinds::text[] AS coverage_kinds`,
        [
          ctx.staff.tenantId,
          id,
          b.kind,
          b.issued_on ?? null,
          b.expires_on ?? null,
          name,
          b.media_type,
          bytes,
          bytes.length,
          "{" + (b.coverage_kinds ?? []).join(",") + "}",
        ],
      );
      sendData(ctx.res, r.rows[0], undefined, 201);
    }),
  );
  router.patch(
    "/vendors/:id/documents/:docId/coverage",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_vendors");
      const id = parseUuidParam(ctx.req.params.id, "Vendor");
      const docId = parseUuidParam(ctx.req.params.docId, "Document");
      const b = parseBody(
        z.object({ coverage_kinds: coverageSchema }).strict(),
        ctx.req.body,
      );
      const old = (
        await ctx.db.query<{ kind: string; expires_on: string | null }>(
          "SELECT kind,expires_on FROM projects.vendor_documents WHERE id=$1 AND vendor_id=$2 FOR UPDATE",
          [docId, id],
        )
      ).rows[0];
      if (!old) throw notFound("Document not found");
      if (!old.kind.endsWith("_insurance") || !old.expires_on)
        throw new ApiError(
          "validation_failed",
          "Coverage can only be assigned to an insurance document with an expiration date.",
        );
      const result = await ctx.db.query(
        `UPDATE projects.vendor_documents SET kind=$3,coverage_kinds=$4::projects.doc_kind[],verified_by=NULL,verified_at=NULL,verify_method=NULL
         WHERE id=$1 AND vendor_id=$2 RETURNING id,kind,coverage_kinds::text[] AS coverage_kinds`,
        [docId, id, b.coverage_kinds[0], "{" + b.coverage_kinds.join(",") + "}"],
      );
      sendData(ctx.res, result.rows[0]);
    }),
  );
  router.get(
    "/vendors/:id/documents/:docId/file",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_vendors");
      const id = parseUuidParam(ctx.req.params.id, "Vendor"),
        docId = parseUuidParam(ctx.req.params.docId, "Document");
      const r = await ctx.db.query<{
        file_name: string;
        media_type: string;
        content: string;
      }>(
        "SELECT file_name,media_type,encode(file_data,'base64') AS content FROM projects.vendor_documents WHERE id=$1 AND vendor_id=$2 AND file_data IS NOT NULL",
        [docId, id],
      );
      if (!r.rows[0]) throw notFound("Document not found");
      ctx.res.setHeader("Cache-Control", "no-store");
      sendData(ctx.res, r.rows[0]);
    }),
  );
  router.get(
    "/vendor-work-totals",
    staffRoute(deps, async (ctx) => {
      const unit = unitFilter(
        ctx.staff.businessUnitId,
        ctx.settings.enforceBusinessUnitScoping,
      );
      const r = await ctx.db.query(
        `SELECT po.vendor_id,p.currency,count(*)::int AS contract_count,count(DISTINCT po.project_id)::int AS project_count,sum(po.amount)::text AS contracted_total FROM projects.purchase_orders po JOIN projects.projects p ON p.id=po.project_id WHERE po.vendor_id IS NOT NULL AND po.status IN ('issued','partially_billed','closed') AND ($1::uuid IS NULL OR p.business_unit_id=$1) GROUP BY po.vendor_id,p.currency`,
        [unit],
      );
      sendData(ctx.res, r.rows);
    }),
  );
  router.get(
    "/vendors/:id/work",
    staffRoute(deps, async (ctx) => {
      const id = parseUuidParam(ctx.req.params.id, "Vendor");
      if (
        !(
          await ctx.db.query("SELECT id FROM projects.vendors WHERE id=$1", [
            id,
          ])
        ).rows.length
      )
        throw notFound("Vendor not found");
      const unit = unitFilter(
        ctx.staff.businessUnitId,
        ctx.settings.enforceBusinessUnitScoping,
      );
      const r = await ctx.db.query(
        `SELECT po.id,po.project_id,po.po_number,po.amount::text,po.status,po.scope_text,po.window_start,po.window_end,p.name AS project_name,p.currency FROM projects.purchase_orders po JOIN projects.projects p ON p.id=po.project_id WHERE po.vendor_id=$1 AND ($2::uuid IS NULL OR p.business_unit_id=$2) ORDER BY po.issued_at DESC NULLS LAST,po.po_number`,
        [id, unit],
      );
      sendData(ctx.res, r.rows);
    }),
  );
  return router;
}
