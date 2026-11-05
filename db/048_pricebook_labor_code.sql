-- The labor code is ServiceTitan pricebook service MHM.25PLFE.
-- The payroll labor-type mirror from 046 is retired here: marked inactive,
-- not deleted. labor_actuals.cost_code_id keeps pointing at that row until
-- the application stamps MHM.25PLFE, so a re-run cannot orphan hours.
-- Re-running is safe. There is no check constraint. Logged project starts
-- are left as they are. This file does not clear stored hours.

SET search_path = projects, public;

COMMENT ON COLUMN cost_codes.external_source IS
  'servicetitan_pricebook_service marks MHM.25PLFE, the labor code read from the ServiceTitan pricebook. servicetitan_labor_type is the retired payroll labor-type mirror. Null is a Journeyman cost code.';

-- Owner connections are subject to FORCE ROW LEVEL SECURITY, so the retire
-- runs once per entitled tenant with that tenant selected. A tenant this
-- cannot see is retired later by the application, inside its own transaction.
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM projects.tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE projects.cost_codes
       SET active = false
     WHERE tenant_id = t
       AND external_source IN ('servicetitan_labor_type', 'journeyman_builtin_labor');
  END LOOP;
END $$;

DROP VIEW IF EXISTS v_budget_exceptions;
DROP VIEW IF EXISTS v_project_margin;
DROP VIEW IF EXISTS v_cost_position;

CREATE VIEW v_cost_position WITH (security_invoker = true) AS
SELECT
  b.tenant_id, b.project_id, cc.code AS cost_code, cc.description, b.cost_type,
  COALESCE(b.baseline_amount, b.budget_amount)                   AS baseline,
  b.budget_amount,
  COALESCE(billed.amount, 0) + COALESCE(labor.amount, 0)         AS actual_cost,
  GREATEST(COALESCE(po.amount,0) - COALESCE(billed.amount,0), 0) AS committed_open,
  COALESCE(billed.amount,0) + COALESCE(labor.amount, 0)
    + GREATEST(COALESCE(po.amount,0) - COALESCE(billed.amount,0), 0) AS total_committed,
  COALESCE(b.baseline_amount, b.budget_amount)
    - (COALESCE(billed.amount,0) + COALESCE(labor.amount, 0)
       + GREATEST(COALESCE(po.amount,0) - COALESCE(billed.amount,0), 0)) AS variance,
  COALESCE(labor.wage, 0)   AS labor_wage,
  COALESCE(labor.burden, 0) AS labor_burden
FROM budget_lines b
JOIN cost_codes cc ON cc.id = b.cost_code_id
LEFT JOIN LATERAL (
  SELECT SUM(l.current_amount) AS amount
    FROM po_lines l
    JOIN purchase_orders p ON p.id = l.po_id
   WHERE p.project_id = b.project_id
     AND l.cost_code_id = b.cost_code_id
     AND l.cost_type = b.cost_type
     AND p.status IN ('issued', 'partially_billed', 'closed')
     AND (p.kind = 'subcontract' OR (p.kind = 'material' AND p.amount > 0))
) po ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE((
      SELECT SUM(bl.gross_amount)
        FROM bill_lines bl
        JOIN vendor_bills vb ON vb.id = bl.bill_id
        JOIN po_lines l ON l.id = bl.po_line_id
        JOIN purchase_orders p ON p.id = l.po_id
       WHERE p.project_id = b.project_id
         AND l.cost_code_id = b.cost_code_id
         AND l.cost_type = b.cost_type
         AND (
           vb.status IN ('approved', 'paid')
           OR (vb.status = 'received' AND p.kind = 'material')
         )
    ), 0)
    + COALESCE((
      SELECT SUM(vb.amount)
        FROM vendor_bills vb
        JOIN purchase_orders p2 ON p2.id = vb.po_id
       WHERE p2.project_id = b.project_id
         AND p2.cost_code_id = b.cost_code_id
         AND p2.cost_type = b.cost_type
         AND (
           vb.status IN ('approved', 'paid')
           OR (vb.status = 'received' AND p2.kind = 'material')
         )
         AND NOT EXISTS (SELECT 1 FROM bill_lines bl WHERE bl.bill_id = vb.id)
    ), 0) AS amount
) billed ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE(SUM(priced.wage), 0) AS wage,
    COALESCE(SUM(priced.burden), 0) AS burden,
    COALESCE(SUM(priced.amount), 0) AS amount
  FROM (
    SELECT
      CASE
        WHEN r.hourly_rate > 0 AND r.burden_rate > 0
        THEN ROUND(SUM(a.hours) * r.hourly_rate, 2)
        ELSE 0
      END AS wage,
      CASE
        WHEN r.hourly_rate > 0 AND r.burden_rate > 0
        THEN ROUND(SUM(a.hours) * r.burden_rate, 2)
        ELSE 0
      END AS burden,
      CASE
        WHEN r.hourly_rate > 0 AND r.burden_rate > 0
        THEN ROUND(SUM(a.hours) * (r.hourly_rate + r.burden_rate), 2)
        ELSE 0
      END AS amount
    FROM labor_actuals a
    LEFT JOIN technician_labor_rates r
      ON r.tenant_id = a.tenant_id
     AND r.external_technician_id = a.external_technician_id
    WHERE a.project_id = b.project_id
      AND a.cost_code_id = b.cost_code_id
      AND b.cost_type = 'L'
      AND a.cost_code_id IS NOT NULL
    GROUP BY a.external_technician_id, r.hourly_rate, r.burden_rate
  ) priced
) labor ON true
UNION ALL
SELECT
  open_labor.tenant_id,
  open_labor.project_id,
  open_labor.cost_code,
  'Unbudgeted labor'::text AS description,
  'L'::cost_type AS cost_type,
  0::numeric AS baseline,
  0::numeric AS budget_amount,
  open_labor.amount AS actual_cost,
  0::numeric AS committed_open,
  open_labor.amount AS total_committed,
  (0 - open_labor.amount) AS variance,
  open_labor.wage AS labor_wage,
  open_labor.burden AS labor_burden
FROM (
  SELECT
    priced.tenant_id,
    priced.project_id,
    priced.code AS cost_code,
    COALESCE(SUM(priced.wage), 0) AS wage,
    COALESCE(SUM(priced.burden), 0) AS burden,
    COALESCE(SUM(priced.amount), 0) AS amount
  FROM (
    SELECT
      a.tenant_id,
      a.project_id,
      cc.code,
      CASE
        WHEN r.hourly_rate > 0 AND r.burden_rate > 0
        THEN ROUND(SUM(a.hours) * r.hourly_rate, 2)
        ELSE 0
      END AS wage,
      CASE
        WHEN r.hourly_rate > 0 AND r.burden_rate > 0
        THEN ROUND(SUM(a.hours) * r.burden_rate, 2)
        ELSE 0
      END AS burden,
      CASE
        WHEN r.hourly_rate > 0 AND r.burden_rate > 0
        THEN ROUND(SUM(a.hours) * (r.hourly_rate + r.burden_rate), 2)
        ELSE 0
      END AS amount
    FROM labor_actuals a
    JOIN cost_codes cc ON cc.id = a.cost_code_id
    LEFT JOIN technician_labor_rates r
      ON r.tenant_id = a.tenant_id
     AND r.external_technician_id = a.external_technician_id
    WHERE a.cost_code_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
          FROM budget_lines b
         WHERE b.project_id = a.project_id
           AND b.cost_code_id = a.cost_code_id
           AND b.cost_type = 'L'
      )
    GROUP BY a.tenant_id, a.project_id, cc.code, a.external_technician_id, r.hourly_rate, r.burden_rate
  ) priced
  GROUP BY priced.tenant_id, priced.project_id, priced.code
) open_labor
WHERE open_labor.amount > 0;

COMMENT ON VIEW v_cost_position IS
  'One row per budget line, plus Unbudgeted labor when coded hours have wage and burden and no labor budget line on that cost code. That row carries the cost code. Labor wage and labor burden are the two parts of the labor actual.';

CREATE VIEW v_project_margin WITH (security_invoker = true) AS
SELECT
  p.tenant_id, p.id AS project_id, p.project_number, p.name, p.currency,
  p.contract_value
    + COALESCE((SELECT SUM(co.customer_amount) FROM change_orders co
                WHERE co.project_id = p.id AND co.status = 'approved'), 0) AS revised_contract,
  p.target_margin,
  SUM(v.total_committed)                                                    AS committed_cost,
  SUM(GREATEST(v.baseline - v.total_committed, 0))                          AS unspent_baseline,
  SUM(v.total_committed) + SUM(GREATEST(v.baseline - v.total_committed, 0)) AS projected_cost
FROM projects p
JOIN v_cost_position v ON v.project_id = p.id
GROUP BY p.tenant_id, p.id;

CREATE VIEW v_budget_exceptions WITH (security_invoker = true) AS
SELECT tenant_id, project_id, cost_code, description, baseline, total_committed, variance,
       ROUND((total_committed - baseline) / NULLIF(baseline,0) * 100, 1) AS pct_over
FROM v_cost_position
WHERE baseline > 0 AND total_committed > baseline * 1.10;
