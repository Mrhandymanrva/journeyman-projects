-- CSR hand-off. One row per project. A draft is private to the form.
-- Submitted rows wait on Home until a Project Coordinator acknowledges them.
-- Nothing here sends email, alerts Command Center, or writes to ServiceTitan.
-- Re-running this file is safe: provision applies every db/ file on each boot
-- and only ignores "already exists".

SET search_path = projects, public;

CREATE TABLE IF NOT EXISTS csr_handoffs (
  project_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_name text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  service_address text NOT NULL DEFAULT '',
  office text,
  lead_source text NOT NULL DEFAULT '',
  scope_summary text NOT NULL DEFAULT '',
  handoff_project_ref text NOT NULL DEFAULT '',
  handoff_estimate_amount numeric(14,2),
  sold_amount numeric(14,2),
  target_start_window text NOT NULL DEFAULT '',
  access_notes text NOT NULL DEFAULT '',
  decision_maker_notes text NOT NULL DEFAULT '',
  permits_likely text,
  status text NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  submitted_by uuid,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, acknowledged_by) REFERENCES staff (tenant_id, id),
  CHECK (office IS NULL OR office IN ('richmond', 'hampton_newport_news')),
  CHECK (permits_likely IS NULL OR permits_likely IN ('yes', 'no', 'unknown')),
  CHECK (status IN ('draft', 'submitted')),
  CHECK (handoff_estimate_amount IS NULL OR handoff_estimate_amount >= 0),
  CHECK (sold_amount IS NULL OR sold_amount >= 0),
  CHECK (char_length(customer_name) <= 200),
  CHECK (char_length(phone) <= 40),
  CHECK (char_length(email) <= 200),
  CHECK (char_length(service_address) <= 500),
  CHECK (char_length(lead_source) <= 200),
  CHECK (char_length(scope_summary) <= 8000),
  CHECK (char_length(handoff_project_ref) <= 200),
  CHECK (char_length(target_start_window) <= 200),
  CHECK (char_length(access_notes) <= 4000),
  CHECK (char_length(decision_maker_notes) <= 4000),
  CHECK (
    (status = 'draft' AND submitted_at IS NULL AND submitted_by IS NULL)
    OR (status = 'submitted' AND submitted_at IS NOT NULL AND submitted_by IS NOT NULL)
  ),
  CHECK (
    (acknowledged_at IS NULL AND acknowledged_by IS NULL)
    OR (status = 'submitted' AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS csr_handoffs_waiting
  ON csr_handoffs (tenant_id, submitted_at)
  WHERE status = 'submitted' AND acknowledged_at IS NULL;

ALTER TABLE csr_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE csr_handoffs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON csr_handoffs;
CREATE POLICY tenant_isolation ON csr_handoffs
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

COMMENT ON TABLE csr_handoffs IS
  'CSR hand-off for a project in the Handoff stage. Submit completes Gate 0 when the required fields are present. Acknowledge is in-app only: no email and no Command Center alert. ServiceTitan is not written.';
