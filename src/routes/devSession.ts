import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../db/database.js';
import { sendData } from '../http/envelope.js';
import { ApiError } from '../http/errors.js';
import type { MemoryStaffSessions } from '../http/memoryStaffSessions.js';
import { parseBody } from './shared.js';

/**
 * Development sign-in. This mints a staff session from an email address with
 * no proof that the person asking is that person.
 *
 * It exists because the platform owns the real staff session and the console
 * needs a way in before that integration lands. Three conditions gate it:
 *
 *   1. DEV_LOGIN=true
 *   2. NODE_ENV is not production — createApp throws rather than mounting it,
 *      so one variable flipped by accident is not enough to open the door
 *   3. DEV_LOGIN_TOKEN is set, and every request must present it
 *
 * The third is what makes it survivable on a public URL. Without it, anyone
 * who finds the hostname is signed in as an owner. With it, the hostname alone
 * is not enough — which is a shared secret rather than authentication, and is
 * a holding position, not a design.
 *
 * Delete this file when the platform resolver lands.
 */
export function devSessionRoutes(
  database: Database,
  sessions: MemoryStaffSessions,
  accessToken: string,
): Router {
  const router = Router();

  const schema = z.object({
    email: z.string().email(),
    tenant_slug: z.string().min(1),
    access_token: z.string().min(1),
  });

  router.post('/dev/session', (req, res, next) => {
    const body = parseBody(schema, req.body);

    if (!constantTimeEquals(body.access_token, accessToken)) {
      // 401 with nothing else. No hint about which part was wrong, and the
      // comparison does not return early on the first differing byte.
      next(new ApiError('unauthenticated', 'That access token is not valid.'));
      return;
    }

    // The tenant lookup runs without a tenant set, which reads through RLS as
    // zero rows on every tenant-scoped table — `tenants` is not one of them,
    // deliberately, because something has to be able to resolve a slug before
    // a session exists.
    database
      .withoutTenant(async (c) => {
        const tenant = await c.query<{ id: string }>(
          `SELECT id FROM projects.tenants WHERE slug = $1`,
          [body.tenant_slug],
        );
        return tenant.rows[0]?.id ?? null;
      })
      .then(async (tenantId) => {
        if (!tenantId) throw new ApiError('not_found', 'No such account.');

        const staff = await database.withTenant(tenantId, async (c) => {
          const rows = await c.query<{ id: string; full_name: string; role: string }>(
            `SELECT id, full_name, role::text AS role
               FROM projects.staff WHERE email = $1 AND active AND login_bootstrap AND password_hash IS NULL`,
            [body.email],
          );
          return rows.rows[0] ?? null;
        });
        if (!staff) throw new ApiError('not_found', 'No such active staff member on that account.');

        const token = sessions.issue({ tenantId, staffId: staff.id });
        sendData(res, {
          token,
          staff: { id: staff.id, full_name: staff.full_name, role: staff.role },
        });
      })
      .catch(next);
  });

  return router;
}

/**
 * Length is not secret — comparing buffers of different sizes throws in
 * timingSafeEqual, so that is checked first and separately.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
