import { Router } from 'express';
import { z } from 'zod';
import { readFieldRelease } from '../domain/fieldRelease.js';
import { requireCapability } from '../http/capabilities.js';
import { sendData } from '../http/envelope.js';
import { ApiError } from '../http/errors.js';
import { staffRoute, type StaffRouterDeps } from '../http/staffSession.js';
import { loadVisibleProject, parseBody, parseUuidParam } from './shared.js';

const noteSchema = z.object({
  note: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .transform((value) => (value ? value : null)),
});

/**
 * Field release is a flag. These routes set or clear it and append history.
 * They do not consult the schedule, the gates, or purchasing, and they do not
 * call any external system.
 */
export function fieldReleaseRoutes(deps: StaffRouterDeps): Router {
  const router = Router();

  router.post(
    '/projects/:id/field-release',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'record_field_release');
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
      const { note } = parseBody(noteSchema, ctx.req.body ?? {});

      await ctx.db.query(
        `UPDATE projects.projects
            SET field_released_by = $2,
                field_released_at = now(),
                field_release_note = $3
          WHERE id = $1`,
        [projectId, ctx.staff.staffId, note],
      );
      await ctx.db.query(
        `INSERT INTO projects.field_release_events
           (tenant_id, project_id, action, note, actor_id)
         VALUES ($1, $2, 'release', $3, $4)`,
        [ctx.staff.tenantId, projectId, note, ctx.staff.staffId],
      );
      sendData(ctx.res, await readFieldRelease(ctx.db, projectId, true));
    }),
  );

  router.post(
    '/projects/:id/field-release/undo',
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, 'record_field_release');
      const projectId = parseUuidParam(ctx.req.params.id, 'Project');
      await loadVisibleProject(ctx, projectId, 'id');
      const { note } = parseBody(noteSchema, ctx.req.body ?? {});

      const cleared = await ctx.db.query(
        `UPDATE projects.projects
            SET field_released_by = NULL,
                field_released_at = NULL,
                field_release_note = NULL
          WHERE id = $1
            AND field_released_at IS NOT NULL
          RETURNING id`,
        [projectId],
      );
      if (!cleared.rows[0]) {
        throw new ApiError('conflict', 'This project has no field release to undo.');
      }
      await ctx.db.query(
        `INSERT INTO projects.field_release_events
           (tenant_id, project_id, action, note, actor_id)
         VALUES ($1, $2, 'undo', $3, $4)`,
        [ctx.staff.tenantId, projectId, note, ctx.staff.staffId],
      );
      sendData(ctx.res, await readFieldRelease(ctx.db, projectId, true));
    }),
  );

  return router;
}
