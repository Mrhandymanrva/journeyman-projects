import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PortfolioFeedConfig } from "../adapters/portfolioFeed.js";
import type { Database, SqlClient } from "../db/database.js";
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
const MAX_DECODED_BYTES = 8 * 1024 * 1024;
const uploadSchema = z
  .object({
    kind: z.enum(kinds),
    coverage_kinds: coverageSchema.optional(),
    issued_on: z.string().date().nullish(),
    expires_on: z.string().date().nullish(),
    file_name: z.string().min(1).max(200),
    media_type: z.enum(["application/pdf", "image/png", "image/jpeg"]),
    // Above the decoded cap so an oversized file reaches the size check
    // instead of failing as a generic string-length error. The JSON parser
    // on this route is 12 MB, which is the outer bound.
    content: z.string().min(1).max(11_500_000),
    notes: z.string().max(20000).nullish(),
  })
  .strict();

/**
 * Audit name for the portfolio bearer. Command Center presents that secret as
 * JOURNEYMAN_TOKEN; this service stores it as PM_PORTFOLIO_TOKEN. One token.
 */
export const JOURNEYMAN_SERVICE_TOKEN_IDENTITY = "JOURNEYMAN_TOKEN";

const VERIFICATION_BODY_KEYS = [
  "verify_method",
  "verified_by",
  "verified_at",
  "verified",
] as const;

function stripVerificationFields(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const copy = { ...(body as Record<string, unknown>) };
  for (const key of VERIFICATION_BODY_KEYS) delete copy[key];
  return copy;
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

async function saveVendorDocumentUpload(
  db: SqlClient,
  tenantId: string,
  vendorId: string,
  body: unknown,
  audit: { tokenFingerprint: string } | null,
): Promise<Record<string, unknown>> {
  if (
    !(
      await db.query("SELECT id FROM projects.vendors WHERE id=$1", [vendorId])
    ).rows.length
  )
    throw notFound("Vendor not found");
  const b = parseBody(uploadSchema, body);
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
  if (bytes.length > MAX_DECODED_BYTES)
    throw new ApiError(
      "payload_too_large",
      "Decoded file is larger than 8 MB.",
    );
  const valid =
    b.media_type === "application/pdf"
      ? bytes.subarray(0, 5).toString() === "%PDF-"
      : b.media_type === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!valid || bytes.length < 8)
    throw new ApiError(
      "validation_failed",
      "Choose a valid PDF, PNG or JPEG up to 8 MB.",
    );
  const name = b.file_name.replace(/[\x00-\x1f\\/]/g, "_");
  const row = (
    await db.query<Record<string, unknown>>(
      `INSERT INTO projects.vendor_documents(
         tenant_id,vendor_id,kind,issued_on,expires_on,file_name,media_type,file_data,file_size,coverage_kinds,notes,
         verified_by,verified_at,verify_method)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::projects.doc_kind[],$11,NULL,NULL,NULL)
       RETURNING id,kind,file_name,expires_on,file_size,coverage_kinds::text[] AS coverage_kinds,notes,verified_by,verified_at,verify_method`,
      [
        tenantId,
        vendorId,
        b.kind,
        b.issued_on ?? null,
        b.expires_on ?? null,
        name,
        b.media_type,
        bytes,
        bytes.length,
        "{" + (b.coverage_kinds ?? []).join(",") + "}",
        b.notes ?? null,
      ],
    )
  ).rows[0]!;
  if (audit) {
    await db.query(
      `INSERT INTO projects.audit_log(tenant_id,actor_type,actor_id,entity_table,entity_id,action,after_data)
       VALUES($1,'system',NULL,'vendor_documents',$2,'vendor_document_token_upload',$3::jsonb)`,
      [
        tenantId,
        row.id,
        JSON.stringify({
          token_identity: JOURNEYMAN_SERVICE_TOKEN_IDENTITY,
          token_fingerprint: audit.tokenFingerprint,
          vendor_id: vendorId,
          doc_type: b.kind,
          size: bytes.length,
          expires_on: b.expires_on ?? null,
          uploaded_at: new Date().toISOString(),
        }),
      ],
    );
  }
  return row;
}

/**
 * Service-token upload for vendor documents only. Verification columns are
 * written as NULL even when the body names them: review stays a staff action.
 * Every accepted upload appends one audit_log row and does not update prior rows.
 */
export async function serviceVendorDocumentUpload(
  database: Database,
  config: PortfolioFeedConfig,
  req: Request,
  res: Response,
): Promise<void> {
  const vendorId = parseUuidParam(
    Array.isArray(req.params.id) ? req.params.id[0] : req.params.id,
    "Vendor",
  );
  const row = await database.withTenant(config.tenantId, (db) =>
    saveVendorDocumentUpload(
      db,
      config.tenantId,
      vendorId,
      stripVerificationFields(req.body),
      { tokenFingerprint: tokenFingerprint(config.token) },
    ),
  );
  res.set("Cache-Control", "no-store");
  sendData(res, row, undefined, 201);
}

export function vendorIntakeRoutes(deps: StaffRouterDeps) {
  const router = Router();
  router.post(
    "/vendors/:id/documents/upload",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_vendors");
      const id = parseUuidParam(ctx.req.params.id, "Vendor");
      const row = await saveVendorDocumentUpload(
        ctx.db,
        ctx.staff.tenantId,
        id,
        ctx.req.body,
        null,
      );
      sendData(ctx.res, row, undefined, 201);
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
