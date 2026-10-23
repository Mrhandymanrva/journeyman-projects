-- A material order is recorded as a bill before the card charge posts.
-- That received bill is project cost immediately. It is not an approval.
-- Subcontract bills still wait for approved or paid.
-- The same amount is subtracted from the open purchase order, so an issued
-- material order and its bill are not counted twice.

SET search_path = projects, public;

DROP VIEW IF EXISTS v_budget_exceptions;
DROP VIEW IF EXISTS v_project_margin;
DROP VIEW IF EXISTS v_cost_position;

CREATE VIEW v_cost_position WITH (security_invoker = true) AS
SELECT
  b.tenant_id, b.project_id, cc.code AS cost_code, cc.description, b.cost_type,
  COALESCE(b.baseline_amount, b.budget_amount)                   AS baseline,
  b.budget_amount,
  COALESCE(billed.amount, 0)                                     AS actual_cost,
  GREATEST(COALESCE(po.amount,0) - COALESCE(billed.amount,0), 0) AS committed_open,
  COALESCE(billed.amount,0)
    + GREATEST(COALESCE(po.amount,0) - COALESCE(billed.amount,0), 0) AS total_committed,
  COALESCE(b.baseline_amount, b.budget_amount)
    - (COALESCE(billed.amount,0)
       + GREATEST(COALESCE(po.amount,0) - COALESCE(billed.amount,0), 0)) AS variance
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
) billed ON true;

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
