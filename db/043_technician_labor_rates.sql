-- Technician pay and burden come from the ServiceTitan technician profile.
-- Wage is hours times hourly_rate. Burden is the same hours times burden_rate,
-- added on top. A null or zero on either rate leaves that technician's dollars
-- out of actual cost. Hours stay.
-- labor_burdened_hourly_rate remains and is not read.
-- Logged project start dates are left as they are.

SET search_path = projects, public;

CREATE TABLE IF NOT EXISTS technician_labor_rates (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_technician_id text NOT NULL,
  technician_name text,
  active boolean NOT NULL DEFAULT true,
  hourly_rate numeric(12,2),
  burden_rate numeric(12,2),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, external_technician_id)
);

ALTER TABLE technician_labor_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE technician_labor_rates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON technician_labor_rates;
CREATE POLICY tenant_isolation ON technician_labor_rates
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

COMMENT ON TABLE technician_labor_rates IS
  'Read-only copy of ServiceTitan technician hourlyRate and burdenRate. Burden is overhead per hour, added on top of the wage. A null or zero on either rate excludes that technician from labor dollars.';

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS labor_rates_forbidden boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tenant_settings.labor_burdened_hourly_rate IS
  'Retired. Not used for labor cost. The column remains so existing rows are not dropped.';
COMMENT ON COLUMN tenant_settings.labor_rates_forbidden IS
  'True when the last ServiceTitan technician read was denied. Stored rates from an earlier read are kept.';

COMMENT ON TABLE labor_actuals IS
  'Technician hours read from ServiceTitan. Dollars are hours times that technician''s ServiceTitan hourly rate, plus the same hours times that technician''s burden rate.';

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
  SELECT COALESCE(SUM(ROUND(priced.amount, 2)), 0) AS amount
    FROM (
      SELECT CASE
               WHEN r.hourly_rate > 0 AND r.burden_rate > 0
               THEN SUM(a.hours) * (r.hourly_rate + r.burden_rate)
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
) labor ON true;

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
