import express, { type Express } from 'express';
import type { Database } from './db/database.js';
import { errorHandler } from './http/envelope.js';
import { ApiError } from './http/errors.js';
import { staffAuthentication, type StaffSessionStore } from './http/staffSession.js';
import { projectRoutes } from './routes/projects.js';
import { gateRoutes } from './routes/gates.js';
import { estimateImportRoutes } from './routes/estimateImports.js';

export interface AppOptions {
  database: Database;
  staffSessions: StaffSessionStore;
}

/**
 * Two route trees, separately authenticated (§1.1).
 *
 * /api/v1/projects/… mounts staffAuthentication. /api/v1/portal/… will mount
 * its own, from its own module, resolving its own session store. They must not
 * share the middleware that resolves identity — the portal tree is deliberately
 * absent until phase 6 rather than stubbed here where it could pick up the
 * staff resolver by proximity.
 */
export function createApp(opts: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const deps = { database: opts.database, sessions: opts.staffSessions };

  app.get('/health', (_req, res) => {
    res.json({ data: { status: 'ok' } });
  });

  const staff = express.Router();
  staff.use(staffAuthentication(opts.staffSessions));
  staff.use(projectRoutes(deps));
  staff.use(gateRoutes(deps));
  staff.use(estimateImportRoutes(deps));
  app.use('/api/v1/projects', staff);

  app.use('/api/v1', (_req, _res, next) => {
    next(new ApiError('not_found', 'No such route.'));
  });

  app.use(errorHandler);
  return app;
}
