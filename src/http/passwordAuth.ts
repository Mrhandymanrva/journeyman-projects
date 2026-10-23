import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import type { Database, SqlClient } from "../db/database.js";
import type { StaffSessionStore } from "./staffSession.js";
import { ApiError } from "./errors.js";
import { sendData } from "./envelope.js";
import { parseBody } from "../routes/shared.js";

export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
const cookieName = "jp_session";
const invalid = () =>
  new ApiError("unauthenticated", "Email, account or password is incorrect.");
export function sameOrigin(req: Request) {
  const origin = req.get("origin");
  if (origin) {
    try {
      new URL(origin);
    } catch {
      throw new ApiError("forbidden", "Invalid request origin.");
    }
  }
  if (
    (origin && new URL(origin).host !== req.get("host")) ||
    req.get("sec-fetch-site") === "cross-site"
  )
    throw new ApiError("forbidden", "Use the sign-in page on this app.");
}
function cookieToken(req: Request) {
  return (
    req
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1) ?? ""
  );
}
function tenantFrom(token: string) {
  return /^[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(token)
    ? z.string().uuid().safeParse(token.split(".")[0])
    : null;
}
export async function mintLoginToken(
  db: SqlClient,
  tenant: string,
  staff: string,
  purpose: "setup" | "session",
) {
  const token = tenant + "." + randomBytes(32).toString("hex");
  await db.query(
    `INSERT INTO projects.staff_login_tokens(tenant_id,staff_id,token_hash,purpose,expires_at) VALUES($1,$2,$3,$4,now()+$5::interval)`,
    [
      tenant,
      staff,
      digest(token),
      purpose,
      purpose === "setup" ? "24 hours" : "12 hours",
    ],
  );
  return token;
}
export class PasswordSessions implements StaffSessionStore {
  constructor(
    private database: Database,
    private fallback: StaffSessionStore,
  ) {}
  revokeStaff(tenantId: string, staffId: string) {
    this.fallback.revokeStaff?.(tenantId, staffId);
  }
  async resolve(req: Request) {
    const token = cookieToken(req),
      tenant = tenantFrom(token);
    if (tenant?.success) {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) sameOrigin(req);
      const row = await this.database.withTenant(
        tenant.data,
        async (db) =>
          (
            await db.query<{ staff_id: string }>(
              `SELECT t.staff_id FROM projects.staff_login_tokens t JOIN projects.staff s ON s.id=t.staff_id WHERE token_hash=$1 AND purpose='session' AND expires_at>now() AND s.active`,
              [digest(token)],
            )
          ).rows[0],
      );
      if (row) return { tenantId: tenant.data, staffId: row.staff_id };
    }
    return this.fallback.resolve(req);
  }
}
// OWASP's low-memory scrypt configuration; a random salt for every password.
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 },
      (e, key) => (e ? reject(e) : resolve(key)),
    ),
  );
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
async function verifyPassword(password: string, hash: string | null) {
  const parts = (
    hash ?? "scrypt$00000000000000000000000000000000$" + "00".repeat(64)
  ).split("$");
  const actual = await derive(password, parts[1]!);
  const expected = Buffer.from(parts[2] ?? "", "hex");
  return (
    !!hash &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}

export function passwordAuthRoutes(
  database: Database,
  fallback: StaffSessionStore,
) {
  const router = Router();
  const attempts = new Map<string, { count: number; until: number }>();
  let hashing = 0;
  router.use((req, res, next) => {
    try {
      sameOrigin(req);
      res.set("Cache-Control", "no-store");
      const now = Date.now();
      for (const [key, v] of attempts) if (v.until < now) attempts.delete(key);
      const key = digest(
        String(req.body?.tenant_slug ?? "") +
          "|" +
          String(
            req.body?.email ?? req.body?.token ?? req.ip ?? "",
          ).toLowerCase(),
      );
      const v = attempts.get(key) ?? { count: 0, until: now + 15 * 60000 };
      if (v.count >= 10 || attempts.size >= 10000 || hashing >= 4)
        throw new ApiError(
          "rate_limited",
          "Too many attempts. Try again in 15 minutes.",
        );
      if (req.path != "/logout") {
        v.count++;
        attempts.set(key, v);
      }
      next();
    } catch (e) {
      next(e);
    }
  });
  router.post("/login", (req, res, next) => {
    void (async () => {
      const b = parseBody(
        z.object({
          tenant_slug: z.string().trim().min(1).max(100),
          email: z.string().trim().email().max(254),
          password: z.string().min(1).max(256),
        }),
        req.body,
      );
      const tenant = await database.withoutTenant(
        async (db) =>
          (
            await db.query<{ id: string }>(
              "SELECT id FROM projects.tenants WHERE slug=$1",
              [b.tenant_slug],
            )
          ).rows[0],
      );
      const staff = tenant
        ? await database.withTenant(
            tenant.id,
            async (db) =>
              (
                await db.query<{ id: string; password_hash: string | null }>(
                  `SELECT id,password_hash FROM projects.staff WHERE email=$1 AND active`,
                  [b.email],
                )
              ).rows[0],
          )
        : null;
      if (hashing >= 4)
        throw new ApiError(
          "rate_limited",
          "Sign-in is busy. Try again shortly.",
        );
      hashing++;
      let valid = false;
      try {
        valid = await verifyPassword(b.password, staff?.password_hash ?? null);
      } finally {
        hashing--;
      }
      if (!valid || !tenant || !staff) throw invalid();
      const token = await database.withTenant(tenant.id, async (db) => {
        const current = (
          await db.query(
            `SELECT id FROM projects.staff WHERE id=$1 AND active AND password_hash=$2 FOR UPDATE`,
            [staff.id, staff.password_hash],
          )
        ).rows[0];
        if (!current) throw invalid();
        await db.query(
          `DELETE FROM projects.staff_login_tokens WHERE expires_at<now()`,
        );
        return mintLoginToken(db, tenant.id, staff.id, "session");
      });
      res.cookie(cookieName, token, {
        httpOnly: true,
        secure: req.secure || req.get("x-forwarded-proto") === "https",
        sameSite: "strict",
        path: "/",
        maxAge: 12 * 60 * 60 * 1000,
      });
      sendData(res, { signedIn: true });
    })().catch(next);
  });
  router.post("/setup", (req, res, next) => {
    void (async () => {
      const b = parseBody(
        z.object({
          token: z.string().max(150),
          password: z.string().min(8, "Use at least 8 characters.").max(256),
        }),
        req.body,
      );
      const tenant = tenantFrom(b.token);
      if (!tenant?.success)
        throw new ApiError(
          "unauthenticated",
          "This setup link is invalid or expired.",
        );
      const exists = await database.withTenant(
        tenant.data,
        async (db) =>
          (
            await db.query(
              `SELECT token_hash FROM projects.staff_login_tokens WHERE token_hash=$1 AND purpose='setup' AND expires_at>now()`,
              [digest(b.token)],
            )
          ).rows.length,
      );
      if (!exists)
        throw new ApiError(
          "unauthenticated",
          "This setup link is invalid or expired.",
        );
      if (hashing >= 4)
        throw new ApiError(
          "rate_limited",
          "Sign-in is busy. Try again shortly.",
        );
      hashing++;
      let hash: string;
      try {
        hash = await hashPassword(b.password);
      } finally {
        hashing--;
      }
      const identity = await database.withTenant(tenant.data, async (db) => {
        const t = (
          await db.query<{ staff_id: string }>(
            `SELECT staff_id FROM projects.staff_login_tokens WHERE token_hash=$1 AND purpose='setup' AND expires_at>now() FOR UPDATE`,
            [digest(b.token)],
          )
        ).rows[0];
        if (!t)
          throw new ApiError(
            "unauthenticated",
            "This setup link is invalid or expired.",
          );
        const updated = await db.query(
          `UPDATE projects.staff SET password_hash=$1,login_bootstrap=false WHERE id=$2 AND active RETURNING id`,
          [hash, t.staff_id],
        );
        if (!updated.rows.length) throw invalid();
        await db.query(
          "DELETE FROM projects.staff_login_tokens WHERE staff_id=$1",
          [t.staff_id],
        );
        fallback.revokeStaff?.(tenant.data, t.staff_id);
        return (
          await db.query<{ email: string; account: string }>(
            `SELECT s.email,t.slug AS account FROM projects.staff s JOIN projects.tenants t ON t.id=s.tenant_id WHERE s.id=$1`,
            [t.staff_id],
          )
        ).rows[0]!;
      });
      sendData(res, { passwordSet: true, ...identity });
    })().catch(next);
  });
  router.post("/logout", (req, res, next) => {
    void (async () => {
      const token = cookieToken(req),
        tenant = tenantFrom(token);
      if (tenant?.success)
        await database.withTenant(tenant.data, (db) =>
          db.query(
            "DELETE FROM projects.staff_login_tokens WHERE token_hash=$1",
            [digest(token)],
          ),
        );
      res.clearCookie(cookieName, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
      });
      sendData(res, { signedOut: true });
    })().catch(next);
  });
  return router;
}
