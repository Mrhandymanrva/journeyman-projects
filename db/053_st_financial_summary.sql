-- Stored ServiceTitan project summary for the Financials dashboard.
-- Null means that figure was not on the read. Zero is a real zero.
-- Re-applied on every boot. Every statement is idempotent.
-- Nothing here writes to ServiceTitan.

SET search_path = projects, public;

CREATE TABLE IF NOT EXISTS st_project_summary (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  contract_value numeric(14,2),
  total_budgeted_expense numeric(14,2),
  change_orders numeric(14,2),
  cost_adjustments numeric(14,2),
  budgeted_labor_expense numeric(14,2),
  budgeted_labor_hours numeric(12,2),
  budgeted_materials numeric(14,2),
  invoice_billed numeric(14,2),
  open_invoices numeric(14,2),
  retainage numeric(14,2),
  estimates_read boolean NOT NULL DEFAULT false,
  invoices_read boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE st_project_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE st_project_summary FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON st_project_summary;
CREATE POLICY tenant_isolation ON st_project_summary
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

ALTER TABLE st_project_summary
  ADD COLUMN IF NOT EXISTS materials_expense_read boolean NOT NULL DEFAULT true;

ALTER TABLE st_project_summary
  ADD COLUMN IF NOT EXISTS labor_burden numeric(14,2);

COMMENT ON COLUMN st_project_summary.materials_expense_read IS
  'False when purchase-order cost was not returned. The dashboard then dashes materials expense instead of showing zero. True uses the stored purchase-order sum, and zero is a real zero.';
COMMENT ON COLUMN st_project_summary.labor_burden IS
  'Project Financials labor burden when payroll did not return timesheets. Null uses the timesheet burden already stored on labor actuals.';
COMMENT ON TABLE st_project_summary IS
  'ServiceTitan contract, budget, change orders, retainage, and open invoices for the project financials summary. Null is missing, not zero. Nothing is written back to ServiceTitan.';
