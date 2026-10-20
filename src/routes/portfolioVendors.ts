import { Router } from "express";
import { z } from "zod";
import type { PortfolioFeedConfig } from "../adapters/portfolioFeed.js";
import type { Database, SqlClient } from "../db/database.js";
import { sendData } from "../http/envelope.js";
import { ApiError } from "../http/errors.js";

/**
 * The subcontractor half of the portfolio feed: the tenant's vendor directory, readable and writable by the owner's
 * dashboard under the same bearer token as /summary. Every vendor carries updated_at; the dashboard keeps its own
 * copy with its own updated_at and the newer side wins, so a write here is accepted only when the caller's timestamp
 * is newer than the row's. Documents are read here but uploaded in Journeyman, where the file lives.
 */
const VENDOR_FIELDS = z.object({
  legal_name: z.string().min(1).max(200),
  dba_name: z.string().max(200).nullish(),
  primary_contact: z.string().max(200).nullish(),
  email: z.string().email().max(200),
  phone: z.string().max(60).nullish(),
  address: z.string().max(500).nullish(),
  trades: z.array(z.string().min(1).max(120)).max(50).default([]),
  specialties: z.array(z.string().min(1).max(120)).max(50).default([]),
  license_number: z.string().max(120).nullish(),
  license_class: z.string().max(120).nullish(),
  license_authority: z.string().max(120).nullish(),
  license_expires_on: z.string().date().nullish(),
  service_area: z.string().max(500).nullish(),
  availability_status: z.enum(["unknown", "available", "limited", "booked", "unavailable"]).default("unknown"),
  available_from: z.string().date().nullish(),
  availability_notes: z.string().max(5000).nullish(),
  notes: z.string().max(20000).nullish(),
  active: z.boolean().default(false),
  archived: z.boolean().default(false),
});
const UPSERT = VENDOR_FIELDS.extend({ updated_at: z.string().datetime({ offset: true }) });
const CREATE = VENDOR_FIELDS.extend({ updated_at: z.string().datetime({ offset: true }).optional() });

const COLS = Object.keys(VENDOR_FIELDS.shape) as Array<keyof z.infer<typeof VENDOR_FIELDS>>;

const SELECT = `
  SELECT v.id, v.legal_name, v.dba_name, v.primary_contact, v.email, v.phone, v.address, v.trades, v.specialties,
         v.license_number, v.license_class, v.license_authority, v.license_expires_on::text AS license_expires_on, v.service_area,
         v.availability_status, v.available_from::text AS available_from, v.availability_notes, v.notes, v.active, v.archived,
         v.onboarded_at, v.qbo_id, v.created_at, v.updated_at,
         COALESCE(e.schedulable, false) AS schedulable, COALESCE(e.expired_count, 0)::int AS expired_count,
         COALESCE(e.missing_count, 0)::int AS missing_count, COALESCE(e.expiring_count, 0)::int AS expiring_count, e.next_expiry::text AS next_expiry,
         COALESCE((SELECT json_agg(json_build_object('kind', c.kind::text, 'state', c.state, 'expires_on', c.expires_on::text, 'blocks', c.blocks_scheduling) ORDER BY c.kind)
                     FROM projects.v_vendor_compliance c WHERE c.vendor_id = v.id), '[]'::json) AS compliance,
         COALESCE((SELECT json_agg(json_build_object('kind', d.kind::text, 'issued_on', d.issued_on::text, 'expires_on', d.expires_on::text, 'verified_at', d.verified_at, 'has_file', d.file_data IS NOT NULL OR d.file_key IS NOT NULL) ORDER BY d.kind, d.expires_on DESC NULLS LAST)
                     FROM projects.vendor_documents d WHERE d.vendor_id = v.id), '[]'::json) AS documents
    FROM projects.vendors v
    LEFT JOIN projects.v_vendor_eligibility e ON e.vendor_id = v.id`;

async function loadOne(db: SqlClient, id: string) {
  const { rows } = await db.query<Record<string, unknown>>(`${SELECT} WHERE v.id = $1`, [id]);
  return rows[0] ?? null;
}

export function portfolioVendorRoutes(database: Database, config: PortfolioFeedConfig): Router {
  const router = Router();

  router.get("/vendors", (_req, res, next) => {
    database
      .withTenant(config.tenantId, async (db) => (await db.query<Record<string, unknown>>(`${SELECT} ORDER BY v.legal_name, v.id`)).rows)
      .then((rows) => sendData(res, { generated_at: new Date().toISOString(), vendors: rows }))
      .catch(next);
  });

  router.post("/vendors", (req, res, next) => {
    const parsed = CREATE.safeParse(req.body);
    if (!parsed.success) { next(new ApiError("validation_failed", "Vendor is not valid.", parsed.error.flatten())); return; }
    const b = parsed.data;
    database
      .withTenant(config.tenantId, async (db) => {
        const dup = await db.query<{ id: string }>(`SELECT id FROM projects.vendors WHERE lower(email) = lower($1)`, [b.email]);
        if (dup.rows[0]) throw new ApiError("conflict", "A vendor with that email already exists.", { id: dup.rows[0].id });
        const vals = COLS.map((k) => b[k] ?? null);
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO projects.vendors (tenant_id, ${COLS.join(", ")}, updated_at)
           VALUES ($1, ${COLS.map((_, i) => `$${i + 2}`).join(", ")}, COALESCE($${COLS.length + 2}::timestamptz, now())) RETURNING id`,
          [config.tenantId, ...vals, b.updated_at ?? null],
        );
        return loadOne(db, rows[0]!.id);
      })
      .then((row) => sendData(res, row, undefined, 201))
      .catch(next);
  });

  router.put("/vendors/:id", (req, res, next) => {
    const id = String(req.params.id);
    const parsed = UPSERT.safeParse(req.body);
    if (!parsed.success) { next(new ApiError("validation_failed", "Vendor is not valid.", parsed.error.flatten())); return; }
    const b = parsed.data;
    database
      .withTenant(config.tenantId, async (db) => {
        const cur = await db.query<{ updated_at: Date }>(`SELECT updated_at FROM projects.vendors WHERE id = $1`, [id]);
        if (!cur.rows[0]) throw new ApiError("not_found", "Vendor not found.");
        const theirs = new Date(b.updated_at).getTime(), ours = new Date(cur.rows[0].updated_at).getTime();
        if (!(theirs > ours)) return { applied: false, vendor: await loadOne(db, id) };
        const vals = COLS.map((k) => b[k] ?? null);
        await db.query(
          `UPDATE projects.vendors SET ${COLS.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = $${COLS.length + 2}::timestamptz WHERE id = $1`,
          [id, ...vals, b.updated_at],
        );
        if (b.archived) await db.query(`UPDATE projects.scheduling_resources SET active = false WHERE vendor_id = $1`, [id]).catch(() => undefined);
        return { applied: true, vendor: await loadOne(db, id) };
      })
      .then((out) => sendData(res, out))
      .catch(next);
  });

  return router;
}
