import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Database } from "../db/database.js";
import { mintLoginToken } from "../http/passwordAuth.js";
import type { StaffRole } from "../http/capabilities.js";

/**
 * Sign in with Command Center (the owner's dashboard, where people and passwords live). Journeyman is a registered
 * client there with its own id and secret:
 *
 *   GET /sso/start?next=/…      sets a state cookie and sends the browser to Command Center's /sso/authorize
 *   GET /sso/callback?code&state checks the state, redeems the one-time code server to server (POST /sso/token with
 *                                the client secret), finds or creates the staff member by email on the configured
 *                                tenant, opens a normal 12-hour session and redirects to `next`.
 *
 * Command Center owner → owner, manager → manager, office → office, bookkeeper → bookkeeper, csr → office;
 * technicians are refused. The tenant is fixed by configuration, never by the hand-off, the same posture as the
 * portfolio feed. Codes are single-use on Command Center's side, so nothing here has to remember what was used.
 * Email is matched lowercased. A later sign-in sets an active, non-owner staff row to manager when Command Center
 * sends manager. An owner is never changed. Any other Command Center role leaves the existing row as it is.
 */
export interface SsoConfig { url: string; clientId: string; clientSecret: string; tenantId: string; fetch?: typeof fetch }
const ROLE_MAP: Record<string, StaffRole | null> = { owner: "owner", manager: "manager", office: "office", bookkeeper: "bookkeeper", csr: "office", technician: null };
const STATE_COOKIE = "jp_sso_state";

const safeNext = (v: unknown) => { const s = String(v ?? "").trim(); return s.startsWith("/") && !s.startsWith("//") && !/[\r\n]/.test(s) ? s.slice(0, 500) : "/"; };
const page = (title: string, text: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;color:#1a2433"><h2 style="margin:0 0 8px">${title}</h2><p style="color:#66717f">${text}</p><p><a href="/">Open Journeyman Projects</a></p>`;
const origin = (req: Request) => `${req.get("x-forwarded-proto") ?? req.protocol}://${req.get("host")}`;
const cookieOf = (req: Request, name: string) => req.get("cookie")?.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + "="))?.slice(name.length + 1) ?? "";
const secure = (req: Request) => req.secure || req.get("x-forwarded-proto") === "https";
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };

export function ssoRoutes(database: Database, config: SsoConfig): Router {
  const router = Router();
  const cc = config.url.replace(/\/$/, "");
  const doFetch = config.fetch ?? fetch;

  router.get("/sso/start", (req: Request, res: Response) => {
    const state = randomBytes(16).toString("base64url");
    res.cookie(STATE_COOKIE, `${state}.${Buffer.from(safeNext(req.query.next)).toString("base64url")}`, { httpOnly: true, secure: secure(req), sameSite: "lax", path: "/sso", maxAge: 10 * 60 * 1000 });
    const u = new URL(`${cc}/sso/authorize`);
    u.searchParams.set("client_id", config.clientId); u.searchParams.set("redirect_uri", `${origin(req)}/sso/callback`); u.searchParams.set("state", state); u.searchParams.set("next", safeNext(req.query.next));
    res.set("Cache-Control", "no-store"); res.redirect(303, u.toString());
  });

  router.get("/sso/callback", (req: Request, res: Response, next) => {
    void (async () => {
      res.set("Cache-Control", "no-store");
      const [state, nextB64] = cookieOf(req, STATE_COOKIE).split(".");
      res.clearCookie(STATE_COOKIE, { path: "/sso" });
      if (!state || !same(state, String(req.query.state ?? ""))) { res.status(400).type("html").send(page("Sign-in did not complete", "The sign-in did not start from this browser. Go back to Command Center and try again.")); return; }
      const r = await doFetch(`${cc}/sso/token`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code: String(req.query.code ?? "") }), signal: AbortSignal.timeout(15_000) });
      const body: any = await r.json().catch(() => ({}));
      if (!r.ok || !body?.user?.email) { res.status(401).type("html").send(page("Sign-in link expired", String(body?.error ?? "Go back to Command Center and open Journeyman Projects again."))); return; }
      const role = ROLE_MAP[String(body.user.role ?? "")] ?? null;
      const email = String(body.user.email).trim().toLowerCase();
      const out = await database.withTenant(config.tenantId, async (db): Promise<{ error: string } | { token: string }> => {
        const cur = (await db.query<{ id: string; active: boolean; role: string }>(`SELECT id, active, role::text AS role FROM projects.staff WHERE lower(email::text) = $1`, [email])).rows[0];
        if (cur && !cur.active) return { error: "This account is deactivated in Journeyman Projects." };
        let staffId: string;
        if (!cur) {
          if (!role) return { error: "Your Command Center role does not include Journeyman Projects." };
          const ins = await db.query<{ id: string }>(`INSERT INTO projects.staff (tenant_id, email, full_name, role, login_bootstrap) VALUES ($1, $2, $3, $4::projects.staff_role, false) RETURNING id`, [config.tenantId, email, String(body.user.name ?? email).slice(0, 200), role]);
          staffId = ins.rows[0]!.id;
        } else {
          // Active non-owners become managers. The WHERE clause repeats that so an owner cannot be changed.
          if (role === "manager" && cur.role !== "owner") {
            await db.query(`UPDATE projects.staff SET role = 'manager'::projects.staff_role WHERE id = $1 AND active AND role <> 'owner'::projects.staff_role`, [cur.id]);
          }
          staffId = cur.id;
        }
        await db.query(`DELETE FROM projects.staff_login_tokens WHERE expires_at < now()`);
        return { token: await mintLoginToken(db, config.tenantId, staffId, "session") };
      });
      if ("error" in out) { res.status(403).type("html").send(page("No access", out.error)); return; }
      res.cookie("jp_session", out.token, { httpOnly: true, secure: secure(req), sameSite: "strict", path: "/", maxAge: 12 * 60 * 60 * 1000 });
      res.redirect(303, safeNext(nextB64 ? Buffer.from(nextB64, "base64url").toString("utf8") : body.next));
    })().catch(next);
  });

  return router;
}
