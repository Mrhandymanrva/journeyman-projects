-- CSR hand-off. One row per project. A draft is private to the form.
-- Submitted rows wait on Home until a Project Coordinator acknowledges them.
-- Nothing here sends email, alerts Command Center, or writes to ServiceTitan.
--
-- provision.ts re-applies every db/ file on each boot. This file only creates
-- missing objects. It does not drop the table, the rows, or a constraint.

SET search_path = projects, public;

CREATE TABLE IF NOT EXISTS projects.csr_handoffs (
  project_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
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
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS customer_name text NOT NULL DEFAULT '';
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT '';
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS email text NOT NULL DEFAULT '';
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS service_address text NOT NULL DEFAULT '';
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS office text;
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS lead_source text NOT NULL DEFAULT '';
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS scope_summary text NOT NULL DEFAULT '';
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS handoff_project_ref text NOT NULL DEFAULT '';
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS handoff_estimate_amount numeric(14,2);
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS sold_amount numeric(14,2);
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS target_start_window text NOT NULL DEFAULT '';
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS access_notes text NOT NULL DEFAULT '';
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS decision_maker_notes text NOT NULL DEFAULT '';
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS permits_likely text;
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft';
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS submitted_by uuid;
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS acknowledged_by uuid;
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE projects.csr_handoffs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_pkey'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_pkey PRIMARY KEY (project_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_tenant_fkey'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_tenant_fkey
      FOREIGN KEY (tenant_id) REFERENCES projects.tenants(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_project_fkey'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_project_fkey
      FOREIGN KEY (tenant_id, project_id) REFERENCES projects.projects (tenant_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_submitted_by_fkey'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_submitted_by_fkey
      FOREIGN KEY (tenant_id, submitted_by) REFERENCES projects.staff (tenant_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_acknowledged_by_fkey'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_acknowledged_by_fkey
      FOREIGN KEY (tenant_id, acknowledged_by) REFERENCES projects.staff (tenant_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_office_check'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_office_check
      CHECK (office IS NULL OR office IN ('richmond', 'hampton_newport_news'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_permits_check'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_permits_check
      CHECK (permits_likely IS NULL OR permits_likely IN ('yes', 'no', 'unknown'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_status_check'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_status_check
      CHECK (status IN ('draft', 'submitted'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_estimate_check'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_estimate_check
      CHECK (handoff_estimate_amount IS NULL OR handoff_estimate_amount >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_sold_check'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_sold_check
      CHECK (sold_amount IS NULL OR sold_amount >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_customer_name_len'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_customer_name_len
      CHECK (char_length(customer_name) <= 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_phone_len'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_phone_len
      CHECK (char_length(phone) <= 40);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_email_len'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_email_len
      CHECK (char_length(email) <= 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_address_len'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_address_len
      CHECK (char_length(service_address) <= 500);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_lead_len'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_lead_len
      CHECK (char_length(lead_source) <= 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_scope_len'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_scope_len
      CHECK (char_length(scope_summary) <= 8000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_ref_len'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_ref_len
      CHECK (char_length(handoff_project_ref) <= 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_window_len'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_window_len
      CHECK (char_length(target_start_window) <= 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_access_len'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_access_len
      CHECK (char_length(access_notes) <= 4000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_decision_len'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_decision_len
      CHECK (char_length(decision_maker_notes) <= 4000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_submitted_check'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_submitted_check
      CHECK (
        (status = 'draft' AND submitted_at IS NULL AND submitted_by IS NULL)
        OR (status = 'submitted' AND submitted_at IS NOT NULL AND submitted_by IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csr_handoffs_acknowledged_check'
      AND conrelid = 'projects.csr_handoffs'::regclass
  ) THEN
    ALTER TABLE projects.csr_handoffs
      ADD CONSTRAINT csr_handoffs_acknowledged_check
      CHECK (
        (acknowledged_at IS NULL AND acknowledged_by IS NULL)
        OR (status = 'submitted' AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS csr_handoffs_waiting
  ON projects.csr_handoffs (tenant_id, submitted_at)
  WHERE status = 'submitted' AND acknowledged_at IS NULL;

ALTER TABLE projects.csr_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.csr_handoffs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON projects.csr_handoffs;
CREATE POLICY tenant_isolation ON projects.csr_handoffs
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

COMMENT ON TABLE projects.csr_handoffs IS
  'CSR hand-off for a project in the Handoff stage. Customer, contact, address, estimate, and sold amount are copied from ServiceTitan reads already stored in Journeyman. Submit completes Gate 0 when the required fields are present. Acknowledge is in-app only: no email and no Command Center alert. ServiceTitan is not written.';
