/**
 * Qualifying vendor-bill cost from v_project_bill_cost.
 *
 * Double-count rule: a ServiceTitan purchase-order total in
 * st_material_expenses is left out of Journeyman materials when that
 * external id is stored on a Journeyman purchase order that already has
 * qualifying bill cost. The bill is counted instead, as Materials or
 * Subcontractor according to the purchase order kind. An unlinked
 * ServiceTitan purchase order still counts as materials. A Journeyman
 * bill with no ServiceTitan id still counts. A Journeyman purchase order
 * mirrored from ServiceTitan, with no qualifying bill yet, does not
 * remove the ServiceTitan total.
 *
 * The ServiceTitan side of reconciliation stays every non-canceled
 * purchase-order total. The materials delta is then the Journeyman bill
 * (or its absence) against that ServiceTitan total.
 */

import type { SqlClient } from "../db/database.js";
import { roundMoney } from "./projectFinancials.js";

export interface BillCostByKind {
  material: number;
  subcontract: number;
}

export async function readBillCostByKind(db: SqlClient, projectId: string): Promise<BillCostByKind> {
  const rows = await db.query<{ kind: string; amount: string }>(
    `SELECT kind::text AS kind, COALESCE(SUM(amount), 0)::text AS amount
       FROM projects.v_project_bill_cost
      WHERE project_id = $1
      GROUP BY kind`,
    [projectId],
  );
  const amount = (kind: string) => {
    const row = rows.rows.find((item) => item.kind === kind);
    return roundMoney(Number(row?.amount ?? 0));
  };
  return { material: amount("material"), subcontract: amount("subcontract") };
}

/** ServiceTitan purchase-order totals that are not already represented by a qualifying bill. */
export async function readUnlinkedServiceTitanMaterials(db: SqlClient, projectId: string): Promise<number> {
  const rows = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(e.total), 0)::text AS total
       FROM projects.st_material_expenses e
      WHERE e.project_id = $1
        AND NOT EXISTS (
          SELECT 1
            FROM projects.v_project_bill_cost c
           WHERE c.project_id = e.project_id
             AND c.st_po_id IS NOT NULL
             AND c.st_po_id = e.external_po_id
        )`,
    [projectId],
  );
  return roundMoney(Number(rows.rows[0]?.total ?? 0));
}

export async function countQualifyingBills(db: SqlClient, projectId: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM projects.v_project_bill_cost WHERE project_id = $1`,
    [projectId],
  );
  return Number(rows.rows[0]?.n ?? 0);
}
