-- Vendor-bill cost and the ServiceTitan purchase-order link.
-- Re-applied on every boot. Every statement is idempotent.
-- Nothing in this file calls ServiceTitan.
--
-- View order: v_project_bill_cost is created first. v_cost_position,
-- which 049 drops and recreates earlier in the same boot, is replaced
-- after that so it can read the new view. v_project_margin and
-- v_budget_exceptions keep the same columns, so they are left in place.
-- A later migration that replaces v_cost_position has to keep reading
-- v_project_bill_cost or unbudgeted bills drop out again.

SET search_path = projects, public;

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS st_vendor_id text;

COMMENT ON COLUMN vendors.st_vendor_id IS
  'ServiceTitan vendor id, set only when someone maps this vendor. QuickBooks qbo_id is not a ServiceTitan id and is never copied here.';

CREATE UNIQUE INDEX IF NOT EXISTS vendors_st_vendor_id_uq
  ON vendors (tenant_id, st_vendor_id)
  WHERE st_vendor_id IS NOT NULL;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS st_po_id text,
  ADD COLUMN IF NOT EXISTS st_po_sync_state text,
  ADD COLUMN IF NOT EXISTS st_po_sync_error text,
  ADD COLUMN IF NOT EXISTS st_po_payload jsonb,
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'journeyman';

COMMENT ON COLUMN purchase_orders.st_po_id IS
  'ServiceTitan inventory purchase order id. Set after a create is confirmed, or when a nightly read links an existing ServiceTitan purchase order. Null until that link exists.';
COMMENT ON COLUMN purchase_orders.st_po_sync_state IS
  'pending: a create was claimed and may have been sent. created: st_po_id is the ServiceTitan purchase order. failed: ServiceTitan rejected the create. blocked: a required ServiceTitan field has no source in Journeyman, so nothing was sent. No check constraint: new states must not require a narrower list on the next boot.';
COMMENT ON COLUMN purchase_orders.st_po_payload IS
  'Last ServiceTitan create body prepared for this purchase order. Stored before the POST so a retry can search for the same memo.';
COMMENT ON COLUMN purchase_orders.origin IS
  'journeyman: entered here. servicetitan: created from a nightly read of a purchase order that had no Journeyman row. Not a check constraint.';

CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_st_po_id_uq
  ON purchase_orders (tenant_id, st_po_id)
  WHERE st_po_id IS NOT NULL;

-- One row per qualifying bill contribution. No budget_lines join.
-- Approved and paid bills count. A received material bill counts.
-- Rejected bills do not. A received subcontract bill does not.
-- Bill lines supply the amount when the bill has any. Otherwise the
-- bill header amount is used, on the purchase order's cost code.
-- Consumers group by kind: material versus subcontract.
CREATE OR REPLACE VIEW v_project_bill_cost WITH (security_invoker = true) AS
SELECT
  p.tenant_id,
  p.project_id,
  p.id AS po_id,
  p.st_po_id,
  p.kind,
  l.cost_code_id,
  l.cost_type,
  vb.id AS bill_id,
  SUM(bl.gross_amount) AS amount
FROM bill_lines bl
JOIN vendor_bills vb ON vb.id = bl.bill_id
JOIN po_lines l ON l.id = bl.po_line_id
JOIN purchase_orders p ON p.id = l.po_id AND p.id = vb.po_id
WHERE vb.status IN ('approved', 'paid')
   OR (vb.status = 'received' AND p.kind = 'material')
GROUP BY p.tenant_id, p.project_id, p.id, p.st_po_id, p.kind, l.cost_code_id, l.cost_type, vb.id
UNION ALL
SELECT
  p.tenant_id,
  p.project_id,
  p.id AS po_id,
  p.st_po_id,
  p.kind,
  p.cost_code_id,
  p.cost_type,
  vb.id AS bill_id,
  vb.amount
FROM vendor_bills vb
JOIN purchase_orders p ON p.id = vb.po_id
WHERE (
    vb.status IN ('approved', 'paid')
    OR (vb.status = 'received' AND p.kind = 'material')
  )
  AND NOT EXISTS (SELECT 1 FROM bill_lines bl WHERE bl.bill_id = vb.id);

COMMENT ON VIEW v_project_bill_cost IS
  'Qualifying vendor-bill cost by purchase order kind. Approved and paid bills, plus received material bills. Rejected bills are omitted. Bill lines win over the header amount. No dependency on budget_lines, so an unbudgeted bill is still a row.';

-- Replace the bill laterals with v_project_bill_cost and add a row for
-- bill cost that matches no budget line. Columns stay the same so
-- CREATE OR REPLACE keeps v_project_margin and v_budget_exceptions.
CREATE OR REPLACE VIEW v_cost_position WITH (security_invoker = true) AS
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
     AND p.origin IS DISTINCT FROM 'servicetitan'
) po ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(c.amount), 0) AS amount
    FROM v_project_bill_cost c
   WHERE c.project_id = b.project_id
     AND c.cost_code_id = b.cost_code_id
     AND c.cost_type = b.cost_type
) billed ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE(SUM(COALESCE(a.labor_amount, 0)), 0) AS wage,
    COALESCE(SUM(COALESCE(a.burden_amount, 0)), 0) AS burden,
    COALESCE(SUM(COALESCE(a.labor_amount, 0) + COALESCE(a.burden_amount, 0)), 0) AS amount
    FROM labor_actuals a
   WHERE a.project_id = b.project_id
     AND a.cost_code_id = b.cost_code_id
     AND b.cost_type = 'L'
     AND a.cost_code_id IS NOT NULL
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
    a.tenant_id,
    a.project_id,
    cc.code AS cost_code,
    COALESCE(SUM(COALESCE(a.labor_amount, 0)), 0) AS wage,
    COALESCE(SUM(COALESCE(a.burden_amount, 0)), 0) AS burden,
    COALESCE(SUM(COALESCE(a.labor_amount, 0) + COALESCE(a.burden_amount, 0)), 0) AS amount
  FROM labor_actuals a
  JOIN cost_codes cc ON cc.id = a.cost_code_id
  WHERE a.cost_code_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
        FROM budget_lines b
       WHERE b.project_id = a.project_id
         AND b.cost_code_id = a.cost_code_id
         AND b.cost_type = 'L'
    )
  GROUP BY a.tenant_id, a.project_id, cc.code
) open_labor
WHERE open_labor.amount > 0
UNION ALL
SELECT
  open_bill.tenant_id,
  open_bill.project_id,
  open_bill.cost_code,
  'Unbudgeted vendor bill'::text AS description,
  open_bill.cost_type,
  0::numeric AS baseline,
  0::numeric AS budget_amount,
  open_bill.amount AS actual_cost,
  0::numeric AS committed_open,
  open_bill.amount AS total_committed,
  (0 - open_bill.amount) AS variance,
  0::numeric AS labor_wage,
  0::numeric AS labor_burden
FROM (
  SELECT
    c.tenant_id,
    c.project_id,
    cc.code AS cost_code,
    c.cost_type,
    COALESCE(SUM(c.amount), 0) AS amount
  FROM v_project_bill_cost c
  JOIN cost_codes cc ON cc.id = c.cost_code_id
  WHERE c.cost_code_id IS NOT NULL
    AND c.cost_type IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
        FROM budget_lines b
       WHERE b.project_id = c.project_id
         AND b.cost_code_id = c.cost_code_id
         AND b.cost_type = c.cost_type
    )
  GROUP BY c.tenant_id, c.project_id, cc.code, c.cost_type
) open_bill
WHERE open_bill.amount <> 0;

COMMENT ON VIEW v_cost_position IS
  'One row per budget line, plus Unbudgeted labor and Unbudgeted vendor bill when that cost has no matching budget line. Bill cost comes from v_project_bill_cost. A purchase order mirrored from ServiceTitan is not an extra commitment.';
