-- Bills against purchase order lines.
--
-- A bill line is the gross amount for this period, from a percent complete
-- or from an amount. There is no retainage calculation. vendor_bills.amount
-- stays the full amount, and that is what QuickBooks is sent.
--
-- The header amount may be negative so a later percent-complete can go down.
-- The original check (amount >= 0) cannot store that credit.
--
-- Both foreign keys on bill_lines cascade. A purchase order delete removes
-- its bills and its lines; either parent has to be able to remove the bill
-- line or project deletion fails.

SET search_path = projects, public;

DO $$
DECLARE cname text;
BEGIN
  FOR cname IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'projects.vendor_bills'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%amount >= 0%'
  LOOP
    EXECUTE format('ALTER TABLE projects.vendor_bills DROP CONSTRAINT %I', cname);
  END LOOP;
END $$;

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS qbo_txn_type text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'journeyman';

ALTER TABLE vendor_bills DROP CONSTRAINT IF EXISTS vendor_bills_qbo_txn_type_check;
ALTER TABLE vendor_bills
  ADD CONSTRAINT vendor_bills_qbo_txn_type_check
  CHECK (qbo_txn_type IS NULL OR qbo_txn_type IN ('Bill', 'Purchase'));

ALTER TABLE vendor_bills DROP CONSTRAINT IF EXISTS vendor_bills_source_check;
ALTER TABLE vendor_bills
  ADD CONSTRAINT vendor_bills_source_check
  CHECK (source IN ('journeyman', 'qbo_link', 'st_po'));

CREATE TABLE IF NOT EXISTS bill_lines (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bill_id                uuid NOT NULL REFERENCES vendor_bills(id) ON DELETE CASCADE,
  po_line_id             uuid NOT NULL REFERENCES po_lines(id) ON DELETE CASCADE,
  pct_complete_to_date   numeric(5,2) CHECK (pct_complete_to_date IS NULL OR pct_complete_to_date BETWEEN 0 AND 100),
  gross_amount           numeric(14,2) NOT NULL,
  UNIQUE (bill_id, po_line_id)
);

CREATE INDEX IF NOT EXISTS bill_lines_bill_idx ON bill_lines (tenant_id, bill_id);
CREATE INDEX IF NOT EXISTS bill_lines_po_line_idx ON bill_lines (tenant_id, po_line_id);

ALTER TABLE bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bill_lines;
CREATE POLICY tenant_isolation ON bill_lines
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

CREATE OR REPLACE FUNCTION bill_lines_rollup() RETURNS trigger AS $$
DECLARE bid uuid;
BEGIN
  bid := COALESCE(NEW.bill_id, OLD.bill_id);
  UPDATE projects.vendor_bills
     SET amount = COALESCE((SELECT SUM(gross_amount) FROM projects.bill_lines WHERE bill_id = bid), 0)
   WHERE id = bid;
  RETURN NULL;
END $$ LANGUAGE plpgsql SET search_path = projects, pg_temp;

DROP TRIGGER IF EXISTS bill_lines_rollup ON bill_lines;
CREATE TRIGGER bill_lines_rollup
  AFTER INSERT OR UPDATE OR DELETE ON bill_lines
  FOR EACH ROW EXECUTE FUNCTION bill_lines_rollup();

-- Actual cost follows bill lines when the bill has them, and legacy
-- single-amount bills otherwise. Committed cost is unchanged from 024.
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
         AND vb.status IN ('approved', 'paid')
    ), 0)
    + COALESCE((
      SELECT SUM(vb.amount)
        FROM vendor_bills vb
        JOIN purchase_orders p2 ON p2.id = vb.po_id
       WHERE p2.project_id = b.project_id
         AND p2.cost_code_id = b.cost_code_id
         AND p2.cost_type = b.cost_type
         AND vb.status IN ('approved', 'paid')
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
