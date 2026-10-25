-- Read-only copies of ServiceTitan invoices, payment applications, and estimates.
-- These rows are not external_invoices. That table is what staff recorded, and
-- a sync into it would look like someone had entered the invoice here.
-- Nothing in this file writes to ServiceTitan or QuickBooks.

SET search_path = projects, public;

ALTER TABLE draws ADD COLUMN IF NOT EXISTS paid_on date;
COMMENT ON COLUMN draws.paid_on IS
  'Set when a matched ServiceTitan invoice balance is zero. Cleared if that balance is above zero again. Recording an invoice number does not set it.';

CREATE TABLE IF NOT EXISTS st_invoice_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid,
  external_system_id uuid NOT NULL,
  external_invoice_id text NOT NULL,
  invoice_number text NOT NULL,
  external_job_id text,
  total numeric(14,2) NOT NULL,
  balance numeric(14,2) NOT NULL,
  invoiced_on date,
  paid_on date,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_system_id, external_invoice_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, external_system_id) REFERENCES external_systems (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS st_invoice_observations_project
  ON st_invoice_observations (tenant_id, project_id);

CREATE TABLE IF NOT EXISTS st_payment_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_system_id uuid NOT NULL,
  external_payment_id text NOT NULL,
  external_invoice_id text NOT NULL,
  amount numeric(14,2) NOT NULL,
  paid_on date,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_payment_id, external_invoice_id),
  FOREIGN KEY (tenant_id, external_system_id) REFERENCES external_systems (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS st_payment_applications_invoice
  ON st_payment_applications (tenant_id, external_invoice_id);

CREATE TABLE IF NOT EXISTS st_estimate_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid,
  external_system_id uuid NOT NULL,
  external_estimate_id text NOT NULL,
  name text,
  external_job_id text,
  status text,
  sold_on date,
  customer_amount numeric(14,2) NOT NULL DEFAULT 0,
  classification text NOT NULL CHECK (classification IN ('original', 'change_order', 'unknown')),
  change_order_id uuid REFERENCES change_orders(id) ON DELETE SET NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_estimate_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, external_system_id) REFERENCES external_systems (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS st_estimate_observations_project
  ON st_estimate_observations (tenant_id, project_id);

ALTER TABLE st_invoice_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE st_invoice_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON st_invoice_observations;
CREATE POLICY tenant_isolation ON st_invoice_observations
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

ALTER TABLE st_payment_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE st_payment_applications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON st_payment_applications;
CREATE POLICY tenant_isolation ON st_payment_applications
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

ALTER TABLE st_estimate_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE st_estimate_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON st_estimate_observations;
CREATE POLICY tenant_isolation ON st_estimate_observations
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

COMMENT ON TABLE st_invoice_observations IS
  'ServiceTitan invoices observed for linked jobs. A blank draw number is never filled from this table. A person confirms a suggestion with the existing invoice-number edit.';
COMMENT ON TABLE st_payment_applications IS
  'ServiceTitan payment applications observed alongside invoices. A void that puts the balance back above zero walks a paid draw to invoiced.';
COMMENT ON TABLE st_estimate_observations IS
  'ServiceTitan estimates observed for linked jobs. A sold estimate that is not the original contract is display-only until a local change order is approved.';
