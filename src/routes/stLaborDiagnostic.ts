import { Router } from "express";
import type { PortfolioFeedConfig } from "../adapters/portfolioFeed.js";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import { readStLaborDiagnostic, StLaborDiagnosticError } from "../domain/stLaborDiagnostic.js";
import { sendData } from "../http/envelope.js";
import { ApiError } from "../http/errors.js";
import { bearerMatchesToken } from "./portfolio.js";

/**
 * GET /api/v1/diagnostics/st-labor?stProjectId=
 * Same bearer as /api/v1/portfolio/summary. GET-only ServiceTitan reads.
 * Aggregates only: no technician names, ids, rates, or per-person amounts.
 */
export function stLaborDiagnosticRoutes(
  config: PortfolioFeedConfig,
  sources?: SourceConnections,
): Router {
  const router = Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!bearerMatchesToken(req.get("authorization"), config.token)) {
      next(new ApiError("unauthenticated", "A portfolio feed token is required."));
      return;
    }
    next();
  });
  router.get("/st-labor", (req, res, next) => {
    const raw = req.query.stProjectId;
    const stProjectId = typeof raw === "string" ? raw.trim() : "";
    readStLaborDiagnostic(sources?.serviceTitan?.client, stProjectId)
      .then((data) => sendData(res, data))
      .catch((err: unknown) => {
        if (err instanceof StLaborDiagnosticError) {
          const code =
            err.kind === "validation" ? "validation_failed" : err.kind === "conflict" ? "conflict" : "source_unavailable";
          next(new ApiError(code, err.message));
          return;
        }
        next(err);
      });
  });
  return router;
}
