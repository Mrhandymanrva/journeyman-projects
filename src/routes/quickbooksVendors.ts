import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  staffExternalRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import { requireCapability } from "../http/capabilities.js";
import { ApiError, notFound } from "../http/errors.js";
import { sendData } from "../http/envelope.js";
import { parseBody, parseUuidParam } from "./shared.js";
import { queueVendor, type AccountingGateway } from "../adapters/quickbooks.js";

export function qboProfile(v: any) {
  return {
    qbo_id: String(v.Id ?? ""),
    legal_name: v.CompanyName || v.DisplayName || "",
    display_name: v.DisplayName || "",
    email: v.PrimaryEmailAddr?.Address || "",
    phone: v.PrimaryPhone?.FreeFormNumber || "",
    primary_contact: [v.GivenName, v.FamilyName].filter(Boolean).join(" "),
    address: [
      "Line1",
      "Line2",
      "Line3",
      "Line4",
      "Line5",
      "City",
      "CountrySubDivisionCode",
      "PostalCode",
      "Country",
    ]
      .map((k) => v.BillAddr?.[k])
      .filter(Boolean)
      .join(", "),
    notes: v.Notes || "",
    active: v.Active !== false,
  };
}
export function missingContacts(v: ReturnType<typeof qboProfile>) {
  return [
    !v.legal_name && "Company name",
    !z.string().email().safeParse(v.email).success && "Valid email",
    !v.phone && "Phone",
    !v.address && "Address",
  ].filter(Boolean);
}
export function quickbooksVendorRoutes(
  deps: StaffRouterDeps,
  gateway?: AccountingGateway,
) {
  const r = Router();
  async function prepare(ctx: StaffContext) {
    requireCapability(ctx.staff.role, "manage_vendors");
    if (!gateway || gateway.tenantId !== ctx.staff.tenantId)
      throw new ApiError("conflict", "QuickBooks connector is not configured.");
    const cfg = (
      await ctx.db.query<{ realm: string }>(
        "SELECT realm FROM projects.accounting_config",
      )
    ).rows[0];
    return { gateway, realm: cfg?.realm };
  }
  async function call(
    p: Awaited<ReturnType<typeof prepare>>,
    input: Record<string, unknown>,
  ) {
    try {
      return {
        response: await p.gateway.call({
          ...input,
          ...(p.realm ? { expectedRealm: p.realm } : {}),
        }),
      };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : "QuickBooks unavailable.",
      };
    }
  }
  async function response(
    ctx: StaffContext,
    p: Awaited<ReturnType<typeof prepare>>,
    result: Awaited<ReturnType<typeof call>>,
  ) {
    requireCapability(ctx.staff.role, "manage_vendors");
    if (!result.response)
      throw new ApiError(
        "source_unavailable",
        result.error || "QuickBooks unavailable.",
      );
    const answer = result.response;
    const cfg = (
      await ctx.db.query<{ realm: string }>(
        "SELECT realm FROM projects.accounting_config FOR UPDATE",
      )
    ).rows[0];
    if (
      (p.realm && p.realm !== answer.realm) ||
      (cfg && cfg.realm !== answer.realm)
    )
      throw new ApiError(
        "conflict",
        "The connected QuickBooks company changed. Restore the original connection.",
      );
    await ctx.db.query(
      `INSERT INTO projects.accounting_config(tenant_id,realm,environment) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO NOTHING`,
      [ctx.staff.tenantId, answer.realm, answer.environment],
    );
    // Recheck after a concurrent first-time bind.
    const bound = (
      await ctx.db.query<{ realm: string }>(
        "SELECT realm FROM projects.accounting_config",
      )
    ).rows[0];
    if (bound?.realm !== answer.realm)
      throw new ApiError(
        "conflict",
        "QuickBooks company does not match this PM account.",
      );
    return answer;
  }
  r.get(
    "/accounting/quickbooks-vendors",
    staffExternalRoute(
      deps,
      async (ctx) => {
        const p = await prepare(ctx);
        const start = z.coerce
          .number()
          .int()
          .min(1)
          .max(100001)
          .safeParse(ctx.req.query.start ?? 1);
        if (!start.success)
          throw new ApiError("validation_failed", "Invalid page.");
        const name = String(ctx.req.query.name ?? "").slice(0, 100);
        return { ...p, start: start.data, name };
      },
      (p) =>
        call(p, { action: "vendorDirectory", start: p.start, name: p.name }),
      async (ctx, p, result) => {
        const answer = await response(ctx, p, result);
        const local = (
          await ctx.db.query<any>(
            "SELECT id,qbo_id,legal_name,email,archived FROM projects.vendors",
          )
        ).rows;
        sendData(ctx.res, {
          vendors: (answer.result.vendors || []).map((raw: any) => {
            const v = qboProfile(raw);
            return {
              ...v,
              missing: missingContacts(v),
              pm_id: local.find((x) => x.qbo_id === v.qbo_id)?.id,
              archived: local.find((x) => x.qbo_id === v.qbo_id)?.archived,
            };
          }),
          nextStart: answer.result.nextStart,
        });
      },
    ),
  );
  r.post(
    "/accounting/quickbooks-vendors/import",
    staffExternalRoute(
      deps,
      async (ctx) => {
        const p = await prepare(ctx);
        const b = parseBody(
          z.object({ qbo_id: z.string().regex(/^\d+$/) }).strict(),
          ctx.req.body,
        );
        return { ...p, id: b.qbo_id };
      },
      (p) => call(p, { action: "vendor", id: p.id }),
      async (ctx, p, result) => {
        const answer = await response(ctx, p, result);
        const v = qboProfile(answer.result.Vendor || {});
        if (v.qbo_id !== p.id || !v.active)
          throw new ApiError(
            "conflict",
            "QuickBooks vendor is missing or inactive. Refresh the list.",
          );
        if (missingContacts(v).length)
          throw new ApiError(
            "conflict",
            "Complete this vendor in QuickBooks first: " +
              missingContacts(v).join(", ") +
              ".",
          );
        // Serialize matching and import for this tenant; prevent concurrent duplicate links.
        await ctx.db.query(
          "SELECT tenant_id FROM projects.accounting_config FOR UPDATE",
        );
        const found = (
          await ctx.db.query<any>(
            `SELECT * FROM projects.vendors WHERE qbo_id=$1 OR lower(legal_name)=lower($2) OR email=$3 FOR UPDATE`,
            [v.qbo_id, v.legal_name, v.email],
          )
        ).rows;
        const linked = found.find((x) => x.qbo_id === v.qbo_id);
        if (linked) {
          if (linked.archived)
            throw new ApiError(
              "conflict",
              "This company is archived in PM. Restore it first.",
            );
          sendData(ctx.res, { id: linked.id, existing: true });
          return;
        }
        if (found.length)
          throw new ApiError(
            "conflict",
            "A PM vendor already has this name or email. Open that vendor and use Check QuickBooks to link the existing record.",
          );
        const created = (
          await ctx.db.query<any>(
            `INSERT INTO projects.vendors(tenant_id,legal_name,email,phone,address,primary_contact,qbo_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [
              ctx.staff.tenantId,
              v.legal_name,
              v.email,
              v.phone,
              v.address,
              v.primary_contact || null,
              v.qbo_id,
              v.notes,
            ],
          )
        ).rows[0];
        await queueVendor(ctx.db, ctx.staff.tenantId, created);
        await ctx.db.query(
          `UPDATE projects.accounting_queue SET realm=$2,message='Imported contact information from QuickBooks; W-9 and compliance review remain in PM.' WHERE kind='vendor' AND record_id=$1`,
          [created.id, answer.realm],
        );
        sendData(ctx.res, { id: created.id, existing: false }, undefined, 201);
      },
    ),
  );
  r.get(
    "/vendors/:id/quickbooks",
    staffExternalRoute(
      deps,
      async (ctx) => {
        requireCapability(ctx.staff.role,"manage_vendors");
        const id = parseUuidParam(ctx.req.params.id, "Vendor");
        const v = (
          await ctx.db.query<any>(
            "SELECT * FROM projects.vendors WHERE id=$1",
            [id],
          )
        ).rows[0];
        if (!v) throw notFound("Vendor not found");
        const p = await prepare(ctx);
        const q = (
          await ctx.db.query<{ realm: string }>(
            `SELECT realm FROM projects.accounting_queue WHERE kind='vendor' AND record_id=$1`,
            [id],
          )
        ).rows[0];
        if (q?.realm && p.realm && q.realm !== p.realm)
          throw new ApiError(
            "conflict",
            "Vendor is linked to a different QuickBooks company.",
          );
        return { ...p, realm: q?.realm || p.realm, v };
      },
      (p) =>
        call(
          p,
          p.v.qbo_id
            ? { action: "vendor", id: p.v.qbo_id }
            : { action: "vendors", name: p.v.legal_name.slice(0, 100) },
        ),
      async (ctx, p, result) => {
        const answer = await response(ctx, p, result);
        const records = p.v.qbo_id
          ? [answer.result.Vendor]
          : answer.result.QueryResponse?.Vendor || [];
        sendData(ctx.res, {
          pm: {
            id: p.v.id,
            legal_name: p.v.legal_name,
            email: p.v.email,
            phone: p.v.phone,
            address: p.v.address,
            primary_contact: p.v.primary_contact,
            notes: p.v.notes,
            qbo_id: p.v.qbo_id,
          },
          matches: records.filter(Boolean).map((raw: any) => {
            const v = qboProfile(raw);
            return { ...v, missing: missingContacts(v) };
          }),
        });
      },
    ),
  );
  r.post(
    "/vendors/:id/quickbooks-sync",
    staffExternalRoute(
      deps,
      async (ctx) => {
        requireCapability(ctx.staff.role,"manage_vendors");
        const id = parseUuidParam(ctx.req.params.id, "Vendor");
        const body = parseBody(
          z
            .object({
              qbo_id: z.string().regex(/^\d+$/),
              confirmed: z.literal(true),
            })
            .strict(),
          ctx.req.body,
        );
        const v = (
          await ctx.db.query<any>(
            "SELECT * FROM projects.vendors WHERE id=$1",
            [id],
          )
        ).rows[0];
        if (!v) throw notFound("Vendor not found");
        const p = await prepare(ctx);
        if (v.archived)
          throw new ApiError("conflict", "Restore this vendor first.");
        if (v.qbo_id && v.qbo_id !== body.qbo_id)
          throw new ApiError(
            "conflict",
            "This vendor is already linked to another QuickBooks vendor.",
          );
        const linked = (
          await ctx.db.query<any>(
            "SELECT id FROM projects.vendors WHERE qbo_id=$1 AND id<>$2",
            [body.qbo_id, id],
          )
        ).rows[0];
        if (linked)
          throw new ApiError(
            "conflict",
            "That QuickBooks vendor is already linked to another PM company.",
          );
        const q = (
          await ctx.db.query<{ realm: string; state: string }>(
            `SELECT realm,state FROM projects.accounting_queue WHERE kind='vendor' AND record_id=$1`,
            [id],
          )
        ).rows[0];
        if (q?.state === "processing")
          throw new ApiError(
            "conflict",
            "Vendor setup is currently running. Try again when it finishes.",
          );
        if (!p.realm || (q?.realm && q.realm !== p.realm))
          throw new ApiError(
            "conflict",
            "Check QuickBooks first to verify the connected company.",
          );
        return { ...p, v, qboId: body.qbo_id, requestId: randomUUID() };
      },
      async (p) => {
        const read = await call(p, { action: "vendor", id: p.qboId });
        if (!read.response) return read;
        if (read.response.realm !== p.realm)
          return { error: "QuickBooks company changed. No update was sent." };
        const qb = qboProfile(read.response.result.Vendor || {});
        if (qb.qbo_id !== p.qboId || !qb.active)
          return { error: "QuickBooks vendor is missing or inactive." };
        // Name matching is only a proposal: explicit confirmation selects the existing vendor.
        const merged: any = {};
        for (const key of [
          "legal_name",
          "email",
          "phone",
          "address",
          "primary_contact",
          "notes",
        ] as const)
          merged[key] = String(p.v[key] || qb[key] || "").trim();
        if (
          !merged.email ||
          !z.string().email().safeParse(merged.email).success
        )
          return { error: "A valid vendor email is required." };
        const contact = merged.primary_contact.split(/\s+/);
        const payload = {
          DisplayName: merged.legal_name.slice(0, 100),
          CompanyName: merged.legal_name.slice(0, 100),
          PrimaryEmailAddr: { Address: merged.email },
          ...(merged.phone
            ? { PrimaryPhone: { FreeFormNumber: merged.phone.slice(0, 30) } }
            : {}),
          ...(merged.address
            ? {
                BillAddr: {
                  Line1: merged.address.slice(0, 500),
                  Line2: "",
                  Line3: "",
                  Line4: "",
                  Line5: "",
                  City: "",
                  CountrySubDivisionCode: "",
                  PostalCode: "",
                  Country: "",
                },
              }
            : {}),
          ...(merged.primary_contact
            ? {
                GivenName: contact[0].slice(0, 100),
                FamilyName: contact.slice(1).join(" ").slice(0, 100),
              }
            : {}),
          ...(merged.notes ? { Notes: merged.notes.slice(0, 2000) } : {}),
        };
        return {
          ...(await call(p, {
            action: "syncVendor",
            vendorId: p.qboId,
            expectedName: qb.display_name,
            requestId: p.requestId,
            payload,
          })),
          merged,
        };
      },
      async (ctx, p, result) => {
        const answer = await response(ctx, p, result);
        if (String(answer.result.Vendor?.Id) !== p.qboId)
          throw new ApiError(
            "conflict",
            "QuickBooks did not confirm this vendor. Check QuickBooks before retrying.",
          );
        const current = (
          await ctx.db.query<any>(
            "SELECT * FROM projects.vendors WHERE id=$1 FOR UPDATE",
            [p.v.id],
          )
        ).rows[0];
        if (
          !current ||
          current.archived ||
          (current.qbo_id && current.qbo_id !== p.qboId)
        )
          throw new ApiError(
            "conflict",
            "PM vendor changed during sync. QuickBooks was updated; check the records before retrying.",
          );
        const merged =
          "merged" in result ? (result.merged as Record<string, string>) : {};
        await ctx.db.query(
          `UPDATE projects.vendors SET qbo_id=$2,phone=COALESCE(NULLIF(phone,''),$3),address=COALESCE(NULLIF(address,''),$4),primary_contact=COALESCE(NULLIF(primary_contact,''),$5),notes=COALESCE(NULLIF(notes,''),$6) WHERE id=$1`,
          [
            p.v.id,
            p.qboId,
            merged.phone,
            merged.address,
            merged.primary_contact,
            merged.notes,
          ],
        );
        await queueVendor(ctx.db, ctx.staff.tenantId, {
          ...current,
          qbo_id: p.qboId,
        });
        await ctx.db.query(
          `UPDATE projects.accounting_queue SET realm=$2,external_id=$3,message='Contact details synchronized with QuickBooks. W-9 and tax review are separate.',updated_at=now() WHERE kind='vendor' AND record_id=$1`,
          [p.v.id, answer.realm, p.qboId],
        );
        sendData(ctx.res, {
          id: p.v.id,
          qbo_id: p.qboId,
          message:
            "Vendor details synced to QuickBooks. PM values take priority.",
        });
      },
    ),
  );

  return r;
}
