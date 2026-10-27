-- Overnight refresh bookkeeping and the stored ServiceTitan reconciliation.
-- Re-applied on every boot. Every statement is idempotent.
-- Logged project start dates are left as they are.

SET search_path = projects, public;

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS overnight_refresh_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS labor_refresh_run jsonb;

COMMENT ON COLUMN tenant_settings.overnight_refresh_due_at IS
  'The 2 AM America/New_York instant this process armed. A restart after that instant, before a finish is saved, runs the missed night.';

COMMENT ON COLUMN tenant_settings.labor_refresh_run IS
  'Last overnight ServiceTitan refresh: started or finished, timestamps, projects that stamped, and the error for each project that failed.';

COMMENT ON TABLE st_invoice_lines IS
  'Invoice lines read from ServiceTitan. Billed labor and billed materials follow the item general ledger account name. Labor Revenue is labor. Material Revenue is materials, including Van Stock price modifiers. Labor expense stays on cost code MHM.25PLFE. Nothing is written back.';

CREATE TABLE IF NOT EXISTS st_financial_reconciliation (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  lines jsonb NOT NULL,
  technicians jsonb NOT NULL,
  error text,
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE st_financial_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE st_financial_reconciliation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON st_financial_reconciliation;
CREATE POLICY tenant_isolation ON st_financial_reconciliation
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

COMMENT ON TABLE st_financial_reconciliation IS
  'Last comparison of stored Journeyman totals with the ServiceTitan figures read on that refresh. The portfolio token reads this. Nothing is written to ServiceTitan.';
