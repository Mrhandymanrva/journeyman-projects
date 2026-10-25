import { Router } from "express";
import { z } from "zod";
import type { PortfolioFeedConfig } from "../adapters/portfolioFeed.js";
import type { Database } from "../db/database.js";
import { presentFieldRelease } from "../domain/fieldRelease.js";
import { fieldStartColumns, presentFieldStart } from "../domain/fieldStart.js";
import { portfolioGateColumns, presentPortfolioGates } from "../domain/gateReadiness.js";
import { PORTFOLIO_LABOR_KEYS, portfolioLaborColumns, presentPortfolioLabor } from "../domain/laborActuals.js";
import { PORTFOLIO_AR_KEYS, portfolioArColumns, presentPortfolioAr } from "../domain/arMatch.js";
import {
  PORTFOLIO_LOG_KEYS,
  portfolioChangeOrderColumns,
  portfolioCloseoutColumns,
  presentPortfolioChangeOrders,
  presentPortfolioCloseout,
} from "../domain/closeout.js";
import { sendData } from "../http/envelope.js";
import { ApiError } from "../http/errors.js";

/**
 * The project half of the portfolio feed, for keeping QuickBooks in step with the project list. The dashboard reads
 * every project with the customer it came from and the QuickBooks customer:job it is linked to (qbo_customer_id, the
 * same column bills post against), creates or renames the job in QuickBooks, and writes the link back here.
 */
const ACCOUNTING = z.object({ qbo_customer_id: z.string().max(40).nullable() });

export function portfolioProjectRoutes(database: Database, config: PortfolioFeedConfig): Router {
  const router = Router();

  router.get("/projects", (_req, res, next) => {
    database
      .withTenant(config.tenantId, async (db) => (await db.query<Record<string, unknown>>(
        `SELECT p.id, p.project_number, p.name, p.stage::text AS stage, p.source_customer_name, p.external_customer_id, p.qbo_customer_id,
                p.city, p.region, p.contract_value, p.scheduled_start::text AS scheduled_start, p.actual_end::text AS actual_end, p.updated_at,
                ${fieldStartColumns("p")},
                ${portfolioGateColumns("p")},
                ${portfolioChangeOrderColumns("p")},
                ${portfolioCloseoutColumns("p")},
                ${portfolioLaborColumns("p")},
                ${portfolioArColumns("p")},
                p.field_released_at, p.field_release_note, rel.full_name AS field_released_by_name
           FROM projects.projects p
           LEFT JOIN projects.staff rel ON rel.id = p.field_released_by
          ORDER BY p.project_number`)).rows)
      .then((rows) => sendData(res, {
        generated_at: new Date().toISOString(),
        projects: rows.map((row) => {
          const releasedAt = row.field_released_at;
          const note = row.field_release_note;
          const releasedBy = typeof row.field_released_by_name === "string" ? row.field_released_by_name : null;
          const fieldStart = presentFieldStart(row);
          const precon = {
            open: Number(row.precon_open ?? 0),
            overdue: Number(row.precon_overdue ?? 0),
          };
          const rest = { ...row };
          delete rest.field_released_at;
          delete rest.field_release_note;
          delete rest.field_released_by_name;
          delete rest.field_start;
          delete rest.field_start_source;
          delete rest.field_start_observed_at;
          delete rest.precon_open;
          delete rest.precon_overdue;
          const gates = presentPortfolioGates(rest);
          delete rest.gate_1_status;
          delete rest.gate_2_status;
          const changeOrders = presentPortfolioChangeOrders(rest);
          const closeout = presentPortfolioCloseout(rest);
          const labor = presentPortfolioLabor(rest);
          const ar = presentPortfolioAr(rest);
          for (const key of PORTFOLIO_LOG_KEYS) delete rest[key];
          for (const key of PORTFOLIO_LABOR_KEYS) delete rest[key];
          for (const key of PORTFOLIO_AR_KEYS) delete rest[key];
          return {
            ...rest,
            field_release: presentFieldRelease({ released_at: releasedAt, released_by: releasedBy, note }),
            field_start: fieldStart,
            precon,
            gates,
            change_orders: changeOrders,
            closeout,
            labor,
            ar,
          };
        }),
      }))
      .catch(next);
  });

  router.put("/projects/:id/accounting", (req, res, next) => {
    const id = String(req.params.id);
    const parsed = ACCOUNTING.safeParse(req.body);
    if (!parsed.success) { next(new ApiError("validation_failed", "Accounting link is not valid.", parsed.error.flatten())); return; }
    database
      .withTenant(config.tenantId, async (db) => {
        const cur = (await db.query<{ id: string }>(`SELECT id FROM projects.projects WHERE id = $1`, [id])).rows[0];
        if (!cur) throw new ApiError("not_found", "Project not found.");
        await db.query(`UPDATE projects.projects SET qbo_customer_id = $2 WHERE id = $1`, [id, parsed.data.qbo_customer_id]);
        return (await db.query<Record<string, unknown>>(`SELECT id, project_number, name, qbo_customer_id FROM projects.projects WHERE id = $1`, [id])).rows[0];
      })
      .then((row) => sendData(res, row))
      .catch(next);
  });

  return router;
}
