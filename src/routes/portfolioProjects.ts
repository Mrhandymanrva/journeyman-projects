import { Router } from "express";
import { z } from "zod";
import type { PortfolioFeedConfig } from "../adapters/portfolioFeed.js";
import type { Database } from "../db/database.js";
import { presentFieldRelease } from "../domain/fieldRelease.js";
import { fieldStartColumns, newYorkDate, presentFieldStart } from "../domain/fieldStart.js";
import { portfolioGateColumns, presentPortfolioGates } from "../domain/gateReadiness.js";
import { PORTFOLIO_LABOR_KEYS, portfolioFeedLabor, portfolioLaborColumns, presentPortfolioLabor } from "../domain/laborActuals.js";
import { PORTFOLIO_AR_KEYS, portfolioArColumns, presentPortfolioAr } from "../domain/arMatch.js";
import {
  PORTFOLIO_LOG_KEYS,
  portfolioChangeOrderColumns,
  portfolioCloseoutColumns,
  presentPortfolioChangeOrders,
  presentPortfolioCloseout,
} from "../domain/closeout.js";
import { feedHealth, loadProjectHealth } from "../domain/projectHealth.js";
import { presentLaborRefresh, readPortfolioFinancialFeed } from "../domain/projectSync.js";
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
      .withTenant(config.tenantId, async (db) => {
        const rows = (await db.query<Record<string, unknown>>(
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
          ORDER BY p.project_number`)).rows;
        const health = new Map(
          (await loadProjectHealth(db, newYorkDate(new Date().toISOString()))).map((row) => [row.project_id, row]),
        );
        const financials = await readPortfolioFinancialFeed(db);
        return { rows, health, financials };
      })
      .then(({ rows, health, financials }) => sendData(res, {
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
          const labor = portfolioFeedLabor(presentPortfolioLabor(rest));
          const ar = presentPortfolioAr(rest);
          for (const key of PORTFOLIO_LOG_KEYS) delete rest[key];
          for (const key of PORTFOLIO_LABOR_KEYS) delete rest[key];
          for (const key of PORTFOLIO_AR_KEYS) delete rest[key];
          const assessed = feedHealth(health.get(String(row.id)));
          return {
            ...rest,
            field_release: presentFieldRelease({ released_at: releasedAt, released_by: releasedBy, note }),
            field_start: fieldStart,
            precon,
            gates,
            change_orders: changeOrders,
            closeout,
            labor,
            labor_refresh: presentLaborRefresh(financials.run, String(row.id)),
            reconciliation: financials.reconciliation.get(String(row.id)) ?? null,
            ar,
            projected_margin_pct: assessed.projected_margin_pct,
            billing: assessed.billing,
            health: assessed.health,
          };
        }),
      }))
      .catch(next);
  });

  router.get("/projects/:id/snapshots", (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      next(new ApiError("not_found", "Project not found."));
      return;
    }
    const days = z.coerce.number().int().min(1).max(366).safeParse(req.query.days ?? 90);
    if (!days.success) {
      next(new ApiError("validation_failed", "days must be a whole number from 1 to 366."));
      return;
    }
    const today = newYorkDate(new Date().toISOString());
    database
      .withTenant(config.tenantId, async (db) => {
        const project = (await db.query<{ id: string }>(
          `SELECT id FROM projects.projects WHERE id = $1`,
          [id.data],
        )).rows[0];
        if (!project) throw new ApiError("not_found", "Project not found.");
        const rows = (await db.query<{
          snapshot_on: string;
          score: number;
          band: string;
          reasons: unknown;
          projected_margin_pct: string | null;
          billing_position: "over" | "under" | "even";
          billing_amount: string;
          revised_contract: string | null;
          committed_cost: string | null;
          projected_cost: string | null;
        }>(
          `SELECT snapshot_on::text AS snapshot_on, score, band, reasons,
                  projected_margin_pct::text AS projected_margin_pct,
                  billing_position, billing_amount::text AS billing_amount,
                  revised_contract::text AS revised_contract,
                  committed_cost::text AS committed_cost,
                  projected_cost::text AS projected_cost
             FROM projects.project_health_snapshots
            WHERE project_id = $1
              AND snapshot_on >= $2::date - $3::int
              AND snapshot_on <= $2::date
            ORDER BY snapshot_on`,
          [id.data, today, days.data],
        )).rows;
        return {
          project_id: id.data,
          days: days.data,
          snapshots: rows.map((row) => ({
            snapshot_on: row.snapshot_on,
            score: Number(row.score),
            band: row.band,
            reasons: row.reasons,
            projected_margin_pct: row.projected_margin_pct === null ? null : Number(row.projected_margin_pct),
            billing: { position: row.billing_position, amount: Number(row.billing_amount) },
            revised_contract: row.revised_contract === null ? null : Number(row.revised_contract),
            committed_cost: row.committed_cost === null ? null : Number(row.committed_cost),
            projected_cost: row.projected_cost === null ? null : Number(row.projected_cost),
          })),
        };
      })
      .then((body) => sendData(res, body))
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
