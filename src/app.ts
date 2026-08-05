import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import type { Database } from './db/database.js';
import { errorHandler } from './http/envelope.js';
import { ApiError } from './http/errors.js';
import { staffAuthentication, type StaffSessionStore } from './http/staffSession.js';
import type { MemoryStaffSessions } from './http/memoryStaffSessions.js';
import { sessionRoutes } from './routes/session.js';
import { projectRoutes } from './routes/projects.js';
import { gateRoutes } from './routes/gates.js';
import { budgetRoutes } from './routes/budget.js';
import { purchaseOrderRoutes } from './routes/purchaseOrders.js';
import { vendorRoutes } from './routes/vendors.js';
import { drawRoutes } from './routes/draws.js';
import { fieldOperationRoutes } from './routes/fieldOperations.js';
import { estimateImportRoutes } from './routes/estimateImports.js';
import { devSessionRoutes } from './routes/devSession.js';

export interface AppOptions {
  database: Database;
  staffSessions: StaffSessionStore;
  /**
   * Mounts POST /api/v1/dev/session, which mints a staff session from an email
   * with no password. Requires a MemoryStaffSessions store, and is refused
   * outright when NODE_ENV is production.
   */
  devLogin?: { enabled: boolean; sessions: MemoryStaffSessions; nodeEnv: string };
  /** Serve the console from client/. Off in tests. */
  serveConsole?: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));

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

  if (opts.devLogin?.enabled) {
    if (opts.devLogin.nodeEnv === 'production') {
      throw new Error(
        'DEV_LOGIN cannot be enabled with NODE_ENV=production. It mints a staff ' +
          'session from an email address with no password.',
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      '\n  DEV_LOGIN is on. POST /api/v1/dev/session will mint a staff session\n' +
        '  for any active email on any account, with no password.\n',
    );
    app.use('/api/v1', devSessionRoutes(opts.database, opts.devLogin.sessions));
  }

  const staff = express.Router();
  staff.use(staffAuthentication(opts.staffSessions));
  staff.use(sessionRoutes(deps));
  staff.use(projectRoutes(deps));
  staff.use(gateRoutes(deps));
  staff.use(budgetRoutes(deps));
  staff.use(purchaseOrderRoutes(deps));
  staff.use(vendorRoutes(deps));
  staff.use(drawRoutes(deps));
  staff.use(fieldOperationRoutes(deps));
  staff.use(estimateImportRoutes(deps));
  app.use('/api/v1/projects', staff);

  app.use('/api/v1', (_req, _res, next) => {
    next(new ApiError('not_found', 'No such route.'));
  });

  if (opts.serveConsole !== false) {
    // Static, no build step. The console is the reference mock ported to live
    // data — vanilla HTML and CSS, which is what it was handed over as.
    const clientDir = path.resolve(here, '../client');
    // No far-future caching: these are hand-written files with stable names
    // and no content hash, so a cached console.js is a console that silently
    // keeps running last week's code after a deploy.
    app.use(express.static(clientDir, { index: 'index.html', etag: true, maxAge: 0 }));
  }

  app.use(errorHandler);
  return app;
}
