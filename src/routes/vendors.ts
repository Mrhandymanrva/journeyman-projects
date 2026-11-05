import {queueVendor} from "../adapters/quickbooks.js";
import { Router } from "express";
import { z } from "zod";
import { sendData } from "../http/envelope.js";
import { ApiError, notFound } from "../http/errors.js";
import { requireCapability } from "../http/capabilities.js";
import {
  staffRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import { num, parseBody, parsePagination, parseUuidParam } from "./shared.js";

const DOC_KINDS = [
  "master_agreement",
  "tax_form",
  "license",
  "gl_insurance",
  "wc_insurance",
  "auto_insurance",
  "lien_waiver_conditional",
  "lien_waiver_unconditional",
  "other",
] as const;

const createVendorSchema = z.object({
  legal_name: z.string().min(1),
  dba_name: z.string().nullish(),
  primary_contact: z.string().nullish(),
  email: z.string().email(),
  phone: z.string().nullish(),
  address: z.string().nullish(),
  trades: z.array(z.string().min(1)).default([]),
  license_number: z.string().nullish(),
  license_class: z.string().nullish(),
  // Not hardcoded to any one state's regulator. 'VA DPOR' is a value, not a
  // concept the schema knows about.
  license_authority: z.string().nullish(),
  service_area: z.string().nullish(),
  notes: z.string().max(20000).nullish(),
  specialties: z.array(z.string().min(1).max(120)).max(50).default([]),
  availability_status: z
    .enum(["unknown", "available", "limited", "booked", "unavailable"])
    .default("unknown"),
  available_from: z.string().date().nullish(),
  availability_notes: z.string().max(5000).nullish(),
  license_expires_on: z.string().date().nullish(),
});

const patchVendorSchema = createVendorSchema
  .partial()
  .extend({ archived: z.boolean().optional() });

const createDocumentSchema = z.object({
  kind: z.enum(DOC_KINDS),
  issued_on: z.string().date().nullish(),
  expires_on: z.string().date().nullish(),
  file_key: z.string().min(1).nullish(),
});

const verifyDocumentSchema = z.object({
  verify_method: z.string().min(1),
});

const scoreSchema = z.object({
  project_id: z.string().uuid(),
  schedule_score: z.number().int().min(1).max(5).nullish(),
  quality_score: z.number().int().min(1).max(5).nullish(),
  change_order_score: z.number().int().min(1).max(5).nullish(),
  conduct_score: z.number().int().min(1).max(5).nullish(),
  note: z.string().nullish(),
});

export function vendorRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.get(
    "/vendors",
    staffRoute(deps, async (ctx) => {
      const { page, perPage, offset } = parsePagination(
        ctx.req.query as Record<string, unknown>,
      );
      const q =
        typeof ctx.req.query.q === "string" ? ctx.req.query.q.trim() : "";
      const trade =
        typeof ctx.req.query.trade === "string"
          ? ctx.req.query.trade.trim()
          : "";

      const where = `
        WHERE ($1::text IS NULL OR v.legal_name ILIKE '%'||$1||'%' OR v.primary_contact ILIKE '%'||$1||'%' OR v.email ILIKE '%'||$1||'%' OR array_to_string(v.specialties, ', ') ILIKE '%'||$1||'%' OR v.dba_name ILIKE '%'||$1||'%')
          AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM unnest(v.trades) AS trade_name WHERE lower(trade_name)=lower($2)))
          AND ($3::bool IS NULL OR v.active = $3::bool) AND (${ctx.req.query.include_archived === "true" ? "true" : "NOT v.archived"})`;
      const params = [
        q || null,
        trade || null,
        boolOrNull(ctx.req.query.active),
      ];

      const total = await ctx.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.vendors v ${where}`,
        params,
      );
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT v.id, v.legal_name, v.dba_name, v.email, v.phone, v.trades,
                v.license_number, v.license_class, v.license_authority,
                v.service_area, v.archived, v.active, v.onboarded_at,v.primary_contact,v.address,v.specialties,v.availability_status,v.available_from,v.availability_notes,
                COALESCE(e.schedulable, false) AS schedulable,
                COALESCE(e.expired_count, 0)   AS expired_count,
                COALESCE(e.missing_count, 0)   AS missing_count,
                COALESCE(e.expiring_count, 0)  AS expiring_count,
                e.next_expiry
           FROM projects.vendors v
           LEFT JOIN projects.v_vendor_eligibility e ON e.vendor_id = v.id
           ${where}
          ORDER BY ${ctx.req.query.sort === "trade" ? "array_to_string(v.trades, ', ')," : ""} v.legal_name, v.id
          LIMIT $4 OFFSET $5`,
        [...params, perPage, offset],
      );

      sendData(ctx.res, rows, {
        page,
        per_page: perPage,
        total: Number(total.rows[0]?.n ?? 0),
      });
    }),
  );

  router.post(
    "/vendors",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_vendors");
      const body = parseBody(createVendorSchema, ctx.req.body);
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `INSERT INTO projects.vendors
           (tenant_id, legal_name, dba_name, primary_contact, email, phone, address,
            trades, license_number, license_class, license_authority, service_area, notes,specialties,availability_status,available_from,availability_notes,license_expires_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING id, legal_name, email, phone, address, trades, active`,
        [
          ctx.staff.tenantId,
          body.legal_name,
          body.dba_name ?? null,
          body.primary_contact ?? null,
          body.email,
          body.phone ?? null,
          body.address ?? null,
          body.trades,
          body.license_number ?? null,
          body.license_class ?? null,
          body.license_authority ?? null,
          body.service_area ?? null,
          body.notes ?? null,
          body.specialties,
          body.availability_status,
          body.available_from ?? null,
          body.availability_notes ?? null,
          body.license_expires_on ?? null,
        ],
      );
      await queueVendor(ctx.db,ctx.staff.tenantId,rows[0]!);
      // active defaults false in the schema and is not settable here. A vendor
      // becomes active through POST /vendors/:id/activate, which checks the
      // documents — otherwise "active" means "somebody typed a name".
      sendData(ctx.res, rows[0], undefined, 201);
    }),
  );

  router.get(
    "/vendors/expiring",
    staffRoute(deps, async (ctx) => {
      // Declared before /vendors/:id so that "expiring" is not read as a uuid.
      // Drives the weekly exception report; warn_days is per tenant per kind.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT c.vendor_id, c.legal_name, c.kind::text AS kind, c.expires_on,
                c.state, c.blocks_scheduling,
                (c.expires_on - CURRENT_DATE) AS days_remaining
           FROM projects.v_vendor_compliance c
          WHERE c.state IN ('expiring','expired','missing')
          ORDER BY c.expires_on NULLS FIRST, c.legal_name`,
      );
      sendData(ctx.res, rows);
    }),
  );

  router.get(
    "/vendors/:id",
    staffRoute(deps, async (ctx) => {
      const vendorId = parseUuidParam(ctx.req.params.id, "Vendor");
      const vendor = await loadVendor(ctx, vendorId);

      const documents = await ctx.db.query<Record<string, unknown>>(
        `SELECT d.id, d.kind::text AS kind, d.coverage_kinds::text[] AS coverage_kinds, d.issued_on, d.expires_on, d.file_key,
                d.verified_by, d.verified_at, d.verify_method, d.notes, d.created_at,d.file_name,d.media_type,d.file_size,(d.file_data IS NOT NULL) AS has_file
           FROM projects.vendor_documents d
          WHERE d.vendor_id = $1
          ORDER BY d.kind, d.expires_on DESC NULLS LAST`,
        [vendorId],
      );
      const compliance = await ctx.db.query<Record<string, unknown>>(
        `SELECT kind::text AS kind, state, expires_on, blocks_scheduling
           FROM projects.v_vendor_compliance WHERE vendor_id = $1 ORDER BY kind`,
        [vendorId],
      );
      const eligibility = await ctx.db.query<Record<string, unknown>>(
        `SELECT schedulable, expired_count, missing_count, expiring_count, next_expiry
           FROM projects.v_vendor_eligibility WHERE vendor_id = $1`,
        [vendorId],
      );

      sendData(ctx.res, {
        ...vendor,
        documents: documents.rows,
        compliance: compliance.rows,
        eligibility: eligibility.rows[0] ?? {
          schedulable: false,
          expired_count: 0,
          missing_count: 0,
          expiring_count: 0,
          next_expiry: null,
        },
      });
    }),
  );

  router.patch(
    "/vendors/:id",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_vendors");
      const vendorId = parseUuidParam(ctx.req.params.id, "Vendor");
      await loadVendor(ctx, vendorId);
      const body = parseBody(patchVendorSchema, ctx.req.body);

      const entries = Object.entries(body).filter(([, v]) => v !== undefined);
      if (entries.length === 0) {
        sendData(ctx.res, await loadVendor(ctx, vendorId));
        return;
      }
      const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(", ");
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.vendors SET ${sets} WHERE id = $1 RETURNING *`,
        [vendorId, ...entries.map(([, v]) => v)],
      );
      if (body.archived === true) {
        await ctx.db.query(
          "UPDATE projects.vendors SET active=false WHERE id=$1",
          [vendorId],
        );
        await ctx.db.query(
          "UPDATE projects.scheduling_resources SET active=false WHERE vendor_id=$1",
          [vendorId],
        );
        rows[0]!.active = false;
      }
      sendData(ctx.res, rows[0]);
    }),
  );

  // ----------------------------------------------------------- documents ---
  router.post(
    "/vendors/:id/documents",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_vendors");
      const vendorId = parseUuidParam(ctx.req.params.id, "Vendor");
      await loadVendor(ctx, vendorId);
      const body = parseBody(createDocumentSchema, ctx.req.body);

      // OPEN ITEM — docs/OPEN_ITEMS.md #7. §3.4 specifies this route returns a
      // signed PUT URL so the file never transits the API. No storage provider
      // is chosen yet, so for now the caller supplies an already-uploaded
      // file_key. The column is an opaque key and never a URL, which is the
      // part that has to be right now; who stores the bytes can change later
      // without touching the schema.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `INSERT INTO projects.vendor_documents
           (tenant_id, vendor_id, kind, issued_on, expires_on, file_key)
         VALUES ($1,$2,$3::projects.doc_kind,$4,$5,$6)
         RETURNING id, kind::text AS kind, issued_on, expires_on, file_key, created_at`,
        [
          ctx.staff.tenantId,
          vendorId,
          body.kind,
          body.issued_on ?? null,
          body.expires_on ?? null,
          body.file_key ?? null,
        ],
      );
      sendData(ctx.res, rows[0], undefined, 201);
    }),
  );

  router.patch(
    "/vendors/:id/documents/:docId",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_vendors");
      const vendorId = parseUuidParam(ctx.req.params.id, "Vendor");
      const docId = parseUuidParam(ctx.req.params.docId, "Document");
      await loadVendor(ctx, vendorId);
      const body = parseBody(verifyDocumentSchema, ctx.req.body);

      // Verification records WHO checked and HOW — "called the carrier",
      // "checked DPOR online". A verified_at with no method is a checkbox.
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.vendor_documents
            SET verified_by = $3, verified_at = now(), verify_method = $4
          WHERE id = $1 AND vendor_id = $2
          RETURNING id, kind::text AS kind, verified_by, verified_at, verify_method`,
        [docId, vendorId, ctx.staff.staffId, body.verify_method],
      );
      if (!rows[0]) throw notFound("Document not found");
      sendData(ctx.res, rows[0]);
    }),
  );

  router.post(
    "/vendors/:id/activate",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_vendors");
      const vendorId = parseUuidParam(ctx.req.params.id, "Vendor");
      const vendor = await loadVendor(ctx, vendorId);
      if (vendor.archived)
        throw new ApiError(
          "conflict",
          "Restore this company before activating it.",
        );

      const outstanding = await ctx.db.query<{ kind: string; state: string }>(
        `SELECT kind::text AS kind, state FROM projects.v_vendor_compliance
          WHERE vendor_id = $1 AND blocks_scheduling AND state IN ('missing','expired')`,
        [vendorId],
      );
      if (outstanding.rows.length > 0) {
        throw new ApiError(
          "compliance_blocked",
          `${vendor.legal_name} cannot be activated: ` +
            outstanding.rows.map((d) => `${d.kind} ${d.state}`).join(", ") +
            ".",
          { vendor_id: vendorId, documents: outstanding.rows },
        );
      }

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.vendors SET active = true, onboarded_at = COALESCE(onboarded_at, now())
          WHERE id = $1 RETURNING id, legal_name, active, onboarded_at`,
        [vendorId],
      );
      sendData(ctx.res, rows[0]);
    }),
  );

  router.post(
    "/vendors/:id/deactivate",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_vendors");
      const vendorId = parseUuidParam(ctx.req.params.id, "Vendor");
      await loadVendor(ctx, vendorId);
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.vendors SET active = false WHERE id = $1
         RETURNING id, legal_name, active`,
        [vendorId],
      );
      sendData(ctx.res, rows[0]);
    }),
  );

  router.post(
    "/vendors/:id/scores",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_vendors");
      const vendorId = parseUuidParam(ctx.req.params.id, "Vendor");
      await loadVendor(ctx, vendorId);
      const body = parseBody(scoreSchema, ctx.req.body);

      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `INSERT INTO projects.vendor_scores
           (tenant_id, vendor_id, project_id, schedule_score, quality_score,
            change_order_score, conduct_score, note, scored_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (vendor_id, project_id) DO UPDATE
           SET schedule_score = EXCLUDED.schedule_score,
               quality_score = EXCLUDED.quality_score,
               change_order_score = EXCLUDED.change_order_score,
               conduct_score = EXCLUDED.conduct_score,
               note = EXCLUDED.note,
               scored_by = EXCLUDED.scored_by,
               scored_at = now()
         RETURNING id, vendor_id, project_id, schedule_score, quality_score,
                   change_order_score, conduct_score, note, scored_at`,
        [
          ctx.staff.tenantId,
          vendorId,
          body.project_id,
          body.schedule_score ?? null,
          body.quality_score ?? null,
          body.change_order_score ?? null,
          body.conduct_score ?? null,
          body.note ?? null,
          ctx.staff.staffId,
        ],
      );
      sendData(ctx.res, rows[0], undefined, 201);
    }),
  );

  // ---------------------------------------------------- tenant compliance ---
  router.get(
    "/compliance-requirements",
    staffRoute(deps, async (ctx) => {
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `SELECT kind::text AS kind, required, warn_days, blocks_scheduling
           FROM projects.compliance_requirements ORDER BY kind`,
      );
      sendData(ctx.res, rows);
    }),
  );

  router.patch(
    "/compliance-requirements/:kind",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_vendors");
      const kind = ctx.req.params.kind;
      if (!kind || !(DOC_KINDS as readonly string[]).includes(kind)) {
        throw notFound("Requirement not found");
      }
      const body = parseBody(
        z.object({
          required: z.boolean().optional(),
          warn_days: z.number().int().min(0).max(365).optional(),
          blocks_scheduling: z.boolean().optional(),
        }),
        ctx.req.body,
      );
      const entries = Object.entries(body).filter(([, v]) => v !== undefined);
      if (entries.length === 0)
        throw new ApiError("validation_failed", "Nothing to change.");

      const sets = entries.map(([k], i) => `${k} = $${i + 3}`).join(", ");
      const { rows } = await ctx.db.query<Record<string, unknown>>(
        `UPDATE projects.compliance_requirements SET ${sets}
          WHERE tenant_id = $1 AND kind = $2::projects.doc_kind
          RETURNING kind::text AS kind, required, warn_days, blocks_scheduling`,
        [ctx.staff.tenantId, kind, ...entries.map(([, v]) => v)],
      );
      if (!rows[0]) throw notFound("Requirement not found");
      sendData(ctx.res, rows[0]);
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------

interface VendorRow extends Record<string, unknown> {
  id: string;
  legal_name: string;
}

async function loadVendor(
  ctx: StaffContext,
  vendorId: string,
): Promise<VendorRow> {
  const { rows } = await ctx.db.query<VendorRow>(
    `SELECT id, qbo_id, legal_name, dba_name, primary_contact, email, phone, address, trades,
            license_number, license_class, license_authority, service_area,
            archived, active, onboarded_at, notes, created_at,specialties,availability_status,available_from,availability_notes,license_expires_on
       FROM projects.vendors WHERE id = $1`,
    [vendorId],
  );
  const vendor = rows[0];
  // Vendors are tenant-wide, not project-scoped, so RLS is the whole check
  // here. Nothing to add — and adding a tenant_id predicate would be testing
  // the handler's idea of the tenant instead of the session's.
  if (!vendor) throw notFound("Vendor not found");
  return vendor;
}

function boolOrNull(v: unknown): boolean | null {
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

export { num };
