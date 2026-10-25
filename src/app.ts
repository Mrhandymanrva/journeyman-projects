import { accountingRoutes } from "./routes/accounting.js";
import type { AccountingGateway } from "./adapters/quickbooks.js";
import { recordExportRoutes } from "./routes/recordExports.js";
import { projectControlRoutes } from "./routes/projectControls.js";
import { PasswordSessions, passwordAuthRoutes } from "./http/passwordAuth.js";
import { userRoutes } from "./routes/users.js";
import { stScheduleRoutes } from "./routes/stSchedule.js";
import { stProjectRoutes } from "./routes/stProjects.js";
import {
  serviceVendorDocumentUpload,
  vendorIntakeRoutes,
} from "./routes/vendorIntake.js";
import { bidRequestRoutes, bidResponseRoutes } from "./routes/bidRequests.js";
import { bidMailConfig, type BidMailConfig } from "./adapters/bidMail.js";
import { scheduleChangeRoutes } from "./routes/scheduleChanges.js";
import { directoryRoutes } from "./routes/directories.js";
import { sourceRoutes } from "./routes/sources.js";
import { portfolioVendorRoutes } from "./routes/portfolioVendors.js";
import { portfolioProjectRoutes } from "./routes/portfolioProjects.js";
import { ssoRoutes, type SsoConfig } from "./routes/sso.js";
import { bearerMatchesToken, portfolioRoutes } from "./routes/portfolio.js";
import type { PortfolioFeedConfig } from "./adapters/portfolioFeed.js";
import type { SourceConnections } from "./adapters/sourceConnections.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { Database } from "./db/database.js";
import { errorHandler } from "./http/envelope.js";
import { ApiError } from "./http/errors.js";
import {
  staffAuthentication,
  type StaffSessionStore,
} from "./http/staffSession.js";
import type { MemoryStaffSessions } from "./http/memoryStaffSessions.js";
import { sessionRoutes } from "./routes/session.js";
import { referenceRoutes } from "./routes/reference.js";
import { projectRoutes } from "./routes/projects.js";
import { gateRoutes } from "./routes/gates.js";
import { fieldReleaseRoutes } from "./routes/fieldRelease.js";
import { preconTaskRoutes } from "./routes/preconTasks.js";
import { budgetRoutes } from "./routes/budget.js";
import { purchaseOrderRoutes } from "./routes/purchaseOrders.js";
import { vendorRoutes } from "./routes/vendors.js";
import { changeOrderRoutes } from "./routes/changeOrders.js";
import { drawRoutes } from "./routes/draws.js";
import { statementRoutes } from "./routes/statement.js";
import { externalInvoiceRoutes } from "./routes/externalInvoices.js";
import { projectInvoiceRoutes } from "./routes/projectInvoices.js";
import { planningRoutes } from "./routes/planning.js";
import { fieldOperationRoutes } from "./routes/fieldOperations.js";
import { estimateImportRoutes } from "./routes/estimateImports.js";
import { devSessionRoutes } from "./routes/devSession.js";

export interface AppOptions {
  accounting?: AccountingGateway;
  sources?: SourceConnections;
  bidMail?: BidMailConfig;
  /** Read-only portfolio summary for the configured tenant's owner dashboard. */
  portfolio?: PortfolioFeedConfig;
  database: Database;
  staffSessions: StaffSessionStore;
  /**
   * Mounts POST /api/v1/dev/session, which mints a staff session from an email
   * with no password. Requires a MemoryStaffSessions store, and is refused
   * outright when NODE_ENV is production.
   */
  devLogin?: {
    enabled: boolean;
    sessions: MemoryStaffSessions;
    nodeEnv: string;
    /** Required. Every dev sign-in request must present it. */
    accessToken: string;
  };
  /** Sign in with Command Center (client id, secret, tenant). Absent means no /sso routes and no button. */
  sso?: SsoConfig;
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
  app.disable("x-powered-by");
  app.use(
    "/api/v1/projects/vendors/:id/documents/upload",
    express.json({ limit: "12mb" }),
  );
  app.use(
    "/api/v1/projects/projects/:id/controls/:recordId/file",
    express.json({ limit: "12mb" }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/v1/bid-response", bidResponseRoutes(opts.database));

  app.get('/api/v1/auth/config', (_req,res) => {
    res.set('Cache-Control','no-store').json({data:{devLoginEnabled: Boolean(opts.devLogin?.enabled && opts.devLogin.nodeEnv !== 'production'), ssoEnabled: Boolean(opts.sso), ssoStart: opts.sso ? '/sso/start' : null}});
  });
  const sessions = new PasswordSessions(opts.database, opts.staffSessions);
  const deps = { database: opts.database, sessions };
  app.use(
    "/api/v1/auth",
    passwordAuthRoutes(opts.database, opts.staffSessions),
  );

  if (opts.portfolio) {
    const portfolio = opts.portfolio;
    app.use("/api/v1/portfolio", portfolioRoutes(opts.database, portfolio));
    app.use("/api/v1/portfolio", portfolioVendorRoutes(opts.database, portfolio));
    app.use("/api/v1/portfolio", portfolioProjectRoutes(opts.database, portfolio));
    // This bearer already reads documents and writes vendors on /portfolio.
    // It may upload a vendor document here and nowhere else under /projects.
    // Any other Authorization value falls through to staff login, unchanged.
    app.post(
      "/api/v1/projects/vendors/:id/documents/upload",
      (req, res, next) => {
        if (!bearerMatchesToken(req.get("authorization"), portfolio.token)) {
          next();
          return;
        }
        serviceVendorDocumentUpload(opts.database, portfolio, req, res).catch(
          next,
        );
      },
    );
  }

  if (opts.sso) app.use(ssoRoutes(opts.database, opts.sso));

  app.get("/health", (_req, res) => {
    res.json({ data: { status: "ok" } });
  });

  if (opts.devLogin?.enabled) {
    if (opts.devLogin.nodeEnv === "production") {
      throw new Error(
        "DEV_LOGIN cannot be enabled with NODE_ENV=production. It mints a staff " +
          "session from an email address with no password.",
      );
    }
    if (!opts.devLogin.accessToken) {
      throw new Error(
        "DEV_LOGIN requires DEV_LOGIN_TOKEN. Without it, anyone who finds the " +
          "hostname is signed in as an owner.",
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "\n  DEV_LOGIN is on. POST /api/v1/dev/session mints a staff session for\n" +
        "  any active email on any account, given the shared access token.\n" +
        "  This is a holding position until platform sign-in lands.\n",
    );
    app.use(
      "/api/v1",
      devSessionRoutes(
        opts.database,
        opts.devLogin.sessions,
        opts.devLogin.accessToken,
      ),
    );
  }

  const staff = express.Router();
  staff.use(staffAuthentication(sessions));
  staff.use(sessionRoutes(deps));
  staff.use(userRoutes(deps, opts.sources));
  staff.use(referenceRoutes(deps));
  staff.use(projectRoutes(deps));
  staff.use(projectControlRoutes(deps));
  staff.use(recordExportRoutes(deps, opts.sources));
  staff.use(gateRoutes(deps));
  staff.use(fieldReleaseRoutes(deps));
  staff.use(preconTaskRoutes(deps));
  staff.use(budgetRoutes(deps));
  staff.use(accountingRoutes(deps,opts.accounting));
  staff.use(purchaseOrderRoutes(deps,opts.accounting));
  staff.use(vendorRoutes(deps));
  staff.use(vendorIntakeRoutes(deps));
  staff.use(bidRequestRoutes(deps, opts.bidMail ?? bidMailConfig()));
  staff.use(changeOrderRoutes(deps));
  staff.use(drawRoutes(deps));
  staff.use(statementRoutes(deps));
  staff.use(externalInvoiceRoutes(deps));
  staff.use(projectInvoiceRoutes(deps));
  staff.use(fieldOperationRoutes(deps));
  staff.use(planningRoutes(deps));
  staff.use(directoryRoutes(deps, opts.sources));
  staff.use(stProjectRoutes(deps, opts.sources));
  staff.use(scheduleChangeRoutes(deps, opts.sources));
  staff.use(sourceRoutes(deps, opts.sources));
  staff.use(stScheduleRoutes(deps, opts.sources));
  staff.use(estimateImportRoutes(deps));
  app.use("/api/v1/projects", staff);

  app.use("/api/v1", (_req, _res, next) => {
    next(new ApiError("not_found", "No such route."));
  });

  if (opts.serveConsole !== false) {
    // Static, no build step. The console is the reference mock ported to live
    // data — vanilla HTML and CSS, which is what it was handed over as.
    const clientDir = path.resolve(here, "../client");
    app.use(
      "/pdfjs",
      express.static(path.resolve(here, "../node_modules/pdfjs-dist"), {
        index: false,
        maxAge: 0,
      }),
    );
    // No far-future caching: these are hand-written files with stable names
    // and no content hash, so a cached console.js is a console that silently
    // keeps running last week's code after a deploy.
    app.use(
      express.static(clientDir, { index: "index.html", etag: true, maxAge: 0 }),
    );
  }

  app.use(errorHandler);
  return app;
}
