-- In-house hours. Dollars are hours times one burdened rate. No wage is stored.
-- Labor is added to actual cost on the matching labor budget line. It is not
-- an open purchase order. A missing rate or cost code keeps the hours and
-- leaves them out of actual cost.

SET search_path = projects, public;

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS labor_cost_code_id uuid,
  ADD COLUMN IF NOT EXISTS labor_burdened_hourly_rate numeric(12,2);

ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_labor_cost_code_fkey;
ALTER TABLE tenant_settings
  ADD CONSTRAINT tenant_settings_labor_cost_code_fkey
  FOREIGN KEY (labor_cost_code_id) REFERENCES cost_codes (id) ON DELETE SET NULL;

ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_labor_rate_check;
ALTER TABLE tenant_settings
  ADD CONSTRAINT tenant_settings_labor_rate_check CHECK (
    labor_burdened_hourly_rate IS NULL OR labor_burdened_hourly_rate >= 0
  );

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS labor_cost_code_id uuid;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_labor_cost_code_fkey;
ALTER TABLE projects
  ADD CONSTRAINT projects_labor_cost_code_fkey
  FOREIGN KEY (labor_cost_code_id) REFERENCES cost_codes (id) ON DELETE SET NULL;

COMMENT ON COLUMN tenant_settings.labor_burdened_hourly_rate IS
  'One burdened hourly rate for every technician. Null means hours are stored and do not hit the budget. ServiceTitan wages are not stored.';
COMMENT ON COLUMN tenant_settings.labor_cost_code_id IS
  'Default labor cost code. A project may override it. Null leaves hours uncoded.';
COMMENT ON COLUMN projects.labor_cost_code_id IS
  'Project override for where labor actuals land. It does not change the budget amount.';

CREATE TABLE IF NOT EXISTS labor_actuals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  job_link_id uuid,
  external_job_id text NOT NULL,
  external_timesheet_id text,
  external_appointment_id text,
  external_technician_id text,
  technician_name text,
  work_date date NOT NULL,
  hours numeric(8,2) NOT NULL CHECK (hours >= 0 AND hours < 1000),
  source text NOT NULL CHECK (source IN ('timesheet', 'appointment_window')),
  cost_code_id uuid REFERENCES cost_codes(id) ON DELETE SET NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (job_link_id) REFERENCES project_job_links (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS labor_actuals_timesheet_uq
  ON labor_actuals (tenant_id, external_timesheet_id)
  WHERE external_timesheet_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS labor_actuals_appointment_uq
  ON labor_actuals (project_id, external_appointment_id, external_technician_id)
  WHERE source = 'appointment_window'
    AND external_appointment_id IS NOT NULL
    AND external_technician_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS labor_actuals_project ON labor_actuals (tenant_id, project_id);

ALTER TABLE labor_actuals ENABLE ROW LEVEL SECURITY;
ALTER TABLE labor_actuals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON labor_actuals;
CREATE POLICY tenant_isolation ON labor_actuals
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

COMMENT ON TABLE labor_actuals IS
  'Technician hours read from ServiceTitan. Timesheet rows are preferred. A payroll 403 keeps the last timesheet rows and can fall back to appointment windows. No wage columns.';

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
  SELECT SUM(a.hours * s.labor_burdened_hourly_rate) AS amount
    FROM labor_actuals a
    JOIN tenant_settings s ON s.tenant_id = a.tenant_id
   WHERE a.project_id = b.project_id
     AND a.cost_code_id = b.cost_code_id
     AND b.cost_type = 'L'
     AND a.cost_code_id IS NOT NULL
     AND s.labor_burdened_hourly_rate IS NOT NULL
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
