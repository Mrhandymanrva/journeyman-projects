-- When ServiceTitan appointments were last read for a project.
-- A linked project can have zero rows in the plan's date window. The plan
-- uses this stamp, not the count of rows in that window, to tell a link
-- from a project that was never connected.
--
-- Numbered 059 so it does not collide with 058_vendor_bill_po_sync.sql on
-- integrations/vendor-bills-po-sync. This file does not read or alter that
-- migration. Either pull request can merge first.
--
-- provision.ts re-applies every db/ file on each boot. This file only adds
-- missing objects. No CHECK constraints: a later widening must not fail
-- because an older CHECK was created again.

SET search_path = projects, public;

CREATE TABLE IF NOT EXISTS projects.st_plan_appointment_reads (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  read_at timestamptz,
  skipped integer NOT NULL DEFAULT 0,
  failed_jobs jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE projects.st_plan_appointment_reads ADD COLUMN IF NOT EXISTS read_at timestamptz;
ALTER TABLE projects.st_plan_appointment_reads ADD COLUMN IF NOT EXISTS skipped integer NOT NULL DEFAULT 0;
ALTER TABLE projects.st_plan_appointment_reads ADD COLUMN IF NOT EXISTS failed_jobs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE projects.st_plan_appointment_reads ADD COLUMN IF NOT EXISTS error text;

ALTER TABLE projects.st_plan_appointment_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.st_plan_appointment_reads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON projects.st_plan_appointment_reads;
CREATE POLICY tenant_isolation ON projects.st_plan_appointment_reads
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

COMMENT ON TABLE projects.st_plan_appointment_reads IS
  'Last successful ServiceTitan appointment read for a project, records skipped by the format check, and jobs whose read failed. The plan shows this even when the visible date window has no rows.';
