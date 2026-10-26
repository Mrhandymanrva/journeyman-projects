-- Commission labor uses one company billable rate.
-- Labor = timesheet hours x that rate x the technician's ServiceTitan
-- commission percent. An hourly technician is hours x the ServiceTitan
-- hourly rate instead. Labor burden is the same hours x burdenRate,
-- stored as its own amount. Commission, hourly, and burden rates are
-- not stored. The dollar amounts are.
-- Logged project start dates are left as they are.

SET search_path = projects, public;

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS labor_billable_rate numeric(12,2) NOT NULL DEFAULT 188;

ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_labor_billable_rate_check;
ALTER TABLE tenant_settings
  ADD CONSTRAINT tenant_settings_labor_billable_rate_check
  CHECK (labor_billable_rate >= 0);

COMMENT ON COLUMN tenant_settings.labor_billable_rate IS
  'One company billable rate, owner or manager editable. Commission labor is timesheet hours times this rate times the technician''s ServiceTitan commission percent. Default 188. Not a per-technician rate.';

ALTER TABLE technician_labor_rates
  ADD COLUMN IF NOT EXISTS pay_basis text,
  ADD COLUMN IF NOT EXISTS burden_unset boolean NOT NULL DEFAULT false;

ALTER TABLE technician_labor_rates DROP CONSTRAINT IF EXISTS technician_labor_rates_pay_basis_check;
ALTER TABLE technician_labor_rates
  ADD CONSTRAINT technician_labor_rates_pay_basis_check
  CHECK (pay_basis IS NULL OR pay_basis IN ('commission', 'hourly', 'missing'));

COMMENT ON COLUMN technician_labor_rates.pay_basis IS
  'commission, hourly, or missing. Not a pay rate. Missing means ServiceTitan had neither a commission percent nor an hourly rate.';
COMMENT ON COLUMN technician_labor_rates.burden_unset IS
  'True when ServiceTitan burdenRate is missing or 0. Informational. It does not remove labor cost.';
COMMENT ON COLUMN technician_labor_rates.hourly_rate IS
  'Retired. Not written. ServiceTitan hourly rates are not stored in Journeyman.';
COMMENT ON COLUMN technician_labor_rates.burden_rate IS
  'Retired. Not written. ServiceTitan burden rates are not stored in Journeyman.';

UPDATE technician_labor_rates
   SET hourly_rate = NULL,
       burden_rate = NULL;

ALTER TABLE labor_actuals
  ADD COLUMN IF NOT EXISTS labor_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS burden_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS pay_basis text,
  ADD COLUMN IF NOT EXISTS burden_unset boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS priced_billable_rate numeric(12,2);

ALTER TABLE labor_actuals DROP CONSTRAINT IF EXISTS labor_actuals_labor_amount_check;
ALTER TABLE labor_actuals
  ADD CONSTRAINT labor_actuals_labor_amount_check
  CHECK (labor_amount IS NULL OR labor_amount >= 0);

ALTER TABLE labor_actuals DROP CONSTRAINT IF EXISTS labor_actuals_burden_amount_check;
ALTER TABLE labor_actuals
  ADD CONSTRAINT labor_actuals_burden_amount_check
  CHECK (burden_amount IS NULL OR burden_amount >= 0);

ALTER TABLE labor_actuals DROP CONSTRAINT IF EXISTS labor_actuals_pay_basis_check;
ALTER TABLE labor_actuals
  ADD CONSTRAINT labor_actuals_pay_basis_check
  CHECK (pay_basis IS NULL OR pay_basis IN ('commission', 'hourly', 'missing'));

ALTER TABLE labor_actuals DROP CONSTRAINT IF EXISTS labor_actuals_priced_billable_rate_check;
ALTER TABLE labor_actuals
  ADD CONSTRAINT labor_actuals_priced_billable_rate_check
  CHECK (priced_billable_rate IS NULL OR priced_billable_rate >= 0);

COMMENT ON COLUMN labor_actuals.labor_amount IS
  'Labor cost for these hours. Commission: hours x company billable rate x commission percent. Hourly: hours x ServiceTitan hourly rate. The percent and the hourly rate are not stored.';
COMMENT ON COLUMN labor_actuals.burden_amount IS
  'Labor burden for these hours: hours x ServiceTitan burdenRate. Null when burden is not set. The burden rate is not stored.';
COMMENT ON COLUMN labor_actuals.priced_billable_rate IS
  'Company billable rate used to price a commission row, so a later change to that one setting can rescale labor. Not a per-technician rate.';
COMMENT ON TABLE labor_actuals IS
  'Technician hours read from ServiceTitan. Labor and labor burden are dollar amounts from the last read. Per-technician pay rates are not stored.';

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
) billed ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(COALESCE(a.labor_amount, 0) + COALESCE(a.burden_amount, 0)), 0) AS amount
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
  NULL::text AS cost_code,
  'Unbudgeted labor'::text AS description,
  'L'::cost_type AS cost_type,
  0::numeric AS baseline,
  0::numeric AS budget_amount,
  open_labor.amount AS actual_cost,
  0::numeric AS committed_open,
  open_labor.amount AS total_committed,
  (0 - open_labor.amount) AS variance
FROM (
  SELECT
    a.tenant_id,
    a.project_id,
    COALESCE(SUM(COALESCE(a.labor_amount, 0) + COALESCE(a.burden_amount, 0)), 0) AS amount
  FROM labor_actuals a
  WHERE a.cost_code_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
        FROM budget_lines b
       WHERE b.project_id = a.project_id
         AND b.cost_code_id = a.cost_code_id
         AND b.cost_type = 'L'
    )
  GROUP BY a.tenant_id, a.project_id
) open_labor
WHERE open_labor.amount > 0;

COMMENT ON VIEW v_cost_position IS
  'One row per budget line, plus Unbudgeted labor when coded labor or labor burden has no labor budget line. That row''s budget is zero. Labor and labor burden are the stored dollar amounts.';

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
