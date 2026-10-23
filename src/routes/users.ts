import { Router } from "express";
import { z } from "zod";
import {
  staffRoute,
  staffExternalRoute,
  type StaffContext,
  type StaffRouterDeps,
} from "../http/staffSession.js";
import { ApiError } from "../http/errors.js";
import { sendData } from "../http/envelope.js";
import { mintLoginToken } from "../http/passwordAuth.js";
import { parseBody, parseUuidParam } from "./shared.js";
import type { SourceConnections } from "../adapters/sourceConnections.js";

const role = z.enum([
  "owner",
  "manager",
  "project_manager",
  "estimator",
  "office",
  "bookkeeper",
]);
const owner = (ctx: StaffContext) => {
  if (ctx.staff.role !== "owner")
    throw new ApiError("forbidden", "Only an owner can manage users.");
};
const profile = z
  .object({
    full_name: z.string().trim().min(1).max(150),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().max(60).default(""),
    role,
    business_unit_id: z.string().uuid().nullable().default(null),
    source_person_id: z.string().regex(/^\d+$/).optional(),
    source_person_kind: z.enum(["employee", "technician"]).optional(),
  })
  .refine(
    (b) => !!b.source_person_id === !!b.source_person_kind,
    "Select a valid ST employee.",
  );
async function audit(ctx: StaffContext, id: string, action: string) {
  await ctx.db.query(
    "INSERT INTO projects.audit_log(tenant_id,actor_type,actor_id,entity_table,entity_id,action) VALUES($1,'staff',$2,'staff',$3,$4)",
    [ctx.staff.tenantId, ctx.staff.staffId, id, action],
  );
}
const fields =
  "id,full_name,email,phone,role,active,business_unit_id,source_person_id,source_person_kind,(password_hash IS NOT NULL) AS has_password";
export function userRoutes(
  deps: StaffRouterDeps,
  sources: SourceConnections = {},
) {
  const r = Router();
  function connection(ctx: StaffContext) {
    owner(ctx);
    const c = sources.serviceTitan;
    if (!c || c.tenantId !== ctx.staff.tenantId || !c.client.readEmployees)
      throw new ApiError(
        "source_unavailable",
        "ST employee access is unavailable. Check the Settings employees and technicians read permissions.",
      );
    return c;
  }
  async function activeConnection(ctx: StaffContext) {
    const c = connection(ctx);
    if (
      !(
        await ctx.db.query(
          `SELECT id FROM projects.external_systems WHERE id=$1 AND active AND adapter_key='servicetitan'`,
          [c.externalSystemId],
        )
      ).rows.length
    )
      throw new ApiError(
        "source_unavailable",
        "The ST connection is inactive.",
      );
    return c;
  }
  async function unit(ctx: StaffContext, id: string | null) {
    if (
      id &&
      !(
        await ctx.db.query(
          "SELECT id FROM projects.business_units WHERE id=$1",
          [id],
        )
      ).rows.length
    )
      throw new ApiError("not_found", "Business unit not found.");
  }
  r.get(
    "/users",
    staffRoute(deps, async (ctx) => {
      owner(ctx);
      sendData(ctx.res, {
        users: (
          await ctx.db.query(
            `SELECT ${fields} FROM projects.staff ORDER BY full_name`,
          )
        ).rows,
        units: (
          await ctx.db.query(
            "SELECT id,name FROM projects.business_units ORDER BY name",
          )
        ).rows,
      });
    }),
  );
  r.get(
    "/users/st-employees",
    staffExternalRoute(
      deps,
      activeConnection,
      (c) => c.client.readEmployees!(),
      async (ctx, c, employees) => {
        const fresh = await activeConnection(ctx);
        if (fresh.key !== c.key)
          throw new ApiError(
            "conflict",
            "ST connection changed. Reload the list.",
          );
        sendData(
          ctx.res,
          employees.filter((e) => e.active),
        );
      },
    ),
  );
  r.post(
    "/users",
    staffExternalRoute(
      deps,
      async (ctx) => {
        owner(ctx);
        const b = parseBody(profile, ctx.req.body);
        await unit(ctx, b.business_unit_id);
        return {
          b,
          c: b.source_person_id ? await activeConnection(ctx) : null,
        };
      },
      async (p) => (p.c ? await p.c.client.readEmployees!() : []),
      async (ctx, p, employees) => {
        owner(ctx);
        await unit(ctx, p.b.business_unit_id);
        if (p.c) {
          const fresh = await activeConnection(ctx);
          if (fresh.key !== p.c.key)
            throw new ApiError(
              "conflict",
              "ST connection changed. Reload the list.",
            );
          if (
            !employees.some(
              (e) =>
                e.id === p.b.source_person_id &&
                e.kind === p.b.source_person_kind &&
                e.active,
            )
          )
            throw new ApiError(
              "conflict",
              "This ST employee is no longer active. Reload the list.",
            );
        }
        const b = p.b;
        const u = (
          await ctx.db.query<{ id: string }>(
            `INSERT INTO projects.staff(tenant_id,full_name,email,phone,role,business_unit_id,source_person_id,source_person_kind,source_connection_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [
              ctx.staff.tenantId,
              b.full_name,
              b.email.toLowerCase(),
              b.phone,
              b.role,
              b.business_unit_id,
              b.source_person_id ?? null,
              b.source_person_kind ?? null,
              p.c?.key ?? null,
            ],
          )
        ).rows[0]!;
        await audit(ctx, u.id, "user_created");
        const setupToken = await mintLoginToken(
          ctx.db,
          ctx.staff.tenantId,
          u.id,
          "setup",
        );
        ctx.res.set("Cache-Control", "no-store");
        sendData(
          ctx.res,
          { id: u.id, setupToken, expiresInHours: 24 },
          undefined,
          201,
        );
      },
    ),
  );
  r.patch(
    "/users/:id",
    staffRoute(deps, async (ctx) => {
      owner(ctx);
      const id = parseUuidParam(ctx.req.params.id, "User");
      const b = parseBody(
        z.object({
          full_name: z.string().trim().min(1).max(150),
          phone: z.string().trim().max(60),
          role,
          active: z.boolean(),
          business_unit_id: z.string().uuid().nullable(),
        }),
        ctx.req.body,
      );
      await unit(ctx, b.business_unit_id);
      // Serialize account administration so concurrent owner edits cannot remove every owner.
      await ctx.db.query(
        "SELECT id FROM projects.staff WHERE tenant_id=$1 ORDER BY id FOR UPDATE",
        [ctx.staff.tenantId],
      );
      const actor=(await ctx.db.query(`SELECT id FROM projects.staff WHERE id=$1 AND active AND role='owner'`,[ctx.staff.staffId])).rows[0];
      if(!actor)throw new ApiError('forbidden','Only an active owner can manage users.');
      const old = (
        await ctx.db.query<{ id: string; role: string; active: boolean }>(
          "SELECT id,role,active FROM projects.staff WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!old) throw new ApiError("not_found", "User not found.");
      if (id === ctx.staff.staffId && (!b.active || b.role !== "owner"))
        throw new ApiError(
          "conflict",
          "You cannot deactivate or demote your own owner account.",
        );
      if (
        old.role === "owner" &&
        old.active &&
        (!b.active || b.role !== "owner") &&
        Number(
          (
            await ctx.db.query<{ n: string }>(
              `SELECT count(*) AS n FROM projects.staff WHERE active AND role='owner'`,
            )
          ).rows[0]!.n,
        ) <= 1
      )
        throw new ApiError("conflict", "Keep at least one active owner.");
      await ctx.db.query(
        "UPDATE projects.staff SET full_name=$1,phone=$2,role=$3,active=$4,business_unit_id=$5 WHERE id=$6",
        [b.full_name, b.phone, b.role, b.active, b.business_unit_id, id],
      );
      if (!b.active) {
        await ctx.db.query(
          "DELETE FROM projects.staff_login_tokens WHERE staff_id=$1",
          [id],
        );
        deps.sessions.revokeStaff?.(ctx.staff.tenantId, id);
      }
      await audit(ctx, id, b.active ? "user_updated" : "user_deactivated");
      sendData(ctx.res, { id });
    }),
  );
  r.post(
    "/users/:id/setup-link",
    staffRoute(deps, async (ctx) => {
      owner(ctx);
      const id = parseUuidParam(ctx.req.params.id, "User");
      const row = (
        await ctx.db.query(
          "SELECT id FROM projects.staff WHERE id=$1 AND active FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!row) throw new ApiError("not_found", "Active user not found.");
      await ctx.db.query(
        `DELETE FROM projects.staff_login_tokens WHERE staff_id=$1 AND purpose='setup'`,
        [id],
      );
      await audit(ctx, id, "password_setup_link_issued");
      const setupToken = await mintLoginToken(
        ctx.db,
        ctx.staff.tenantId,
        id,
        "setup",
      );
      ctx.res.set("Cache-Control", "no-store");
      sendData(ctx.res, { setupToken, expiresInHours: 24 });
    }),
  );
  return r;
}
