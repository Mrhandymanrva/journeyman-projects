-- ServiceTitan project jobs, payroll hours, invoice lines, purchase orders,
-- and the appointments shown on the plan.
-- Re-applied on every boot. Every statement is idempotent.
-- Logged project start dates are left as they are.

SET search_path = projects, public;

ALTER TABLE technician_labor_rates
  ADD COLUMN IF NOT EXISTS is_field_tech boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN technician_labor_rates.is_field_tech IS
  'True for an active ServiceTitan managed field technician. Office records and other non-tech rows are false and stay off Setup > Labor.';

COMMENT ON COLUMN labor_actuals.labor_amount IS
  'Labor cost. Commission: this technician''s share of billed MHM.25PLFE labor times their payroll commission percent. Hourly: payroll timesheet hours times the ServiceTitan hourly rate. The percent and the hourly rate are not stored.';
COMMENT ON COLUMN labor_actuals.burden_amount IS
  'Labor burden: payroll timesheet hours times the ServiceTitan burden rate. Null when burden is not set. Clock times are not used. The burden rate is not stored.';
COMMENT ON COLUMN tenant_settings.labor_billable_rate IS
  'Retired from the commission formula. Commission is billed labor times the payroll commission percent. The column remains so older rows still load.';

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS overnight_refresh_finished_at timestamptz;

COMMENT ON COLUMN tenant_settings.overnight_refresh_finished_at IS
  'When the overnight ServiceTitan refresh last finished for this tenant. A boot after that night was missed may run one catch-up. The hourly labor job is gone.';

COMMENT ON COLUMN projects.labor_refresh_source IS
  'manual is the Refresh button. scheduled is the overnight 2 AM America/New_York run. auto-hourly remains valid for rows written by the retired hourly job.';

CREATE TABLE IF NOT EXISTS st_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  external_invoice_id text NOT NULL,
  external_job_id text NOT NULL,
  line_key text NOT NULL,
  sku text,
  kind text NOT NULL CHECK (kind IN ('labor', 'material', 'other')),
  quantity numeric(14,4),
  total numeric(14,2) NOT NULL DEFAULT 0,
  technician_id text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, external_invoice_id, line_key),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS st_invoice_lines_project ON st_invoice_lines (tenant_id, project_id);

ALTER TABLE st_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE st_invoice_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON st_invoice_lines;
CREATE POLICY tenant_isolation ON st_invoice_lines
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

COMMENT ON TABLE st_invoice_lines IS
  'Invoice lines read from ServiceTitan. Labor is MHM.25PLFE. Materials are material and equipment items. Nothing is written back.';

CREATE TABLE IF NOT EXISTS st_material_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  external_job_id text NOT NULL,
  external_po_id text NOT NULL,
  total numeric(14,2) NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, external_po_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS st_material_expenses_project ON st_material_expenses (tenant_id, project_id);

ALTER TABLE st_material_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE st_material_expenses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON st_material_expenses;
CREATE POLICY tenant_isolation ON st_material_expenses
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

COMMENT ON TABLE st_material_expenses IS
  'ServiceTitan purchase-order totals for a project job. This is materials expense. Canceled orders are not stored.';

CREATE TABLE IF NOT EXISTS st_plan_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  external_job_id text NOT NULL,
  external_appointment_id text NOT NULL,
  job_number text NOT NULL,
  appointment_number text NOT NULL,
  job_status text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  technicians jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, external_appointment_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS st_plan_appointments_project ON st_plan_appointments (tenant_id, project_id, starts_at);

ALTER TABLE st_plan_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE st_plan_appointments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON st_plan_appointments;
CREATE POLICY tenant_isolation ON st_plan_appointments
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

COMMENT ON TABLE st_plan_appointments IS
  'Read-only ServiceTitan appointments for the project plan. Replaced by the overnight run and the Refresh button. Not editable schedule items, and not written back to ServiceTitan.';
