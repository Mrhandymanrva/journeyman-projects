import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../db/database.js';
import { sendData } from '../http/envelope.js';
import { ApiError } from '../http/errors.js';
import type { MemoryStaffSessions } from '../http/memoryStaffSessions.js';
import { parseBody } from './shared.js';

/**
 * Development sign-in. This mints a staff session from an email address with
 * no password and no proof of anything.
 *
 * It exists because the platform owns the real staff session and the console
 * needs a way in before that integration lands. It is mounted only when
 * DEV_LOGIN=true, and createApp refuses to mount it at all when NODE_ENV is
 * production — a single env var flipped by accident should not be enough to
 * turn a production deployment into an open door, so there are two conditions
 * and one of them cannot be set by a dashboard.
 *
 * Delete this file when the platform resolver lands.
 */
export function devSessionRoutes(database: Database, sessions: MemoryStaffSessions): Router {
  const router = Router();

  const schema = z.object({
    email: z.string().email(),
    tenant_slug: z.string().min(1),
  });

  router.post('/dev/session', (req, res, next) => {
    const body = parseBody(schema, req.body);

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
               FROM projects.staff WHERE email = $1 AND active`,
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
