-- One health row per project per New York day.
-- The hourly job and the owner run both write this table from local rows.
-- Neither reads ServiceTitan or QuickBooks, and this file does not change
-- scheduled_start. A project keeps the logged start it already has.

SET search_path = projects, public;

CREATE TABLE IF NOT EXISTS project_health_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  snapshot_on date NOT NULL,
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  band text NOT NULL CHECK (band IN ('green', 'yellow', 'red')),
  reasons jsonb NOT NULL,
  projected_margin_pct numeric,
  billing_position text NOT NULL CHECK (billing_position IN ('over', 'under', 'even')),
  billing_amount numeric(14,2) NOT NULL CHECK (billing_amount >= 0),
  revised_contract numeric(14,2),
  committed_cost numeric(14,2),
  projected_cost numeric(14,2),
  UNIQUE (project_id, snapshot_on),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS project_health_snapshots_day
  ON project_health_snapshots (tenant_id, snapshot_on);

ALTER TABLE project_health_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_health_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON project_health_snapshots;
CREATE POLICY tenant_isolation ON project_health_snapshots
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

COMMENT ON TABLE project_health_snapshots IS
  'Daily health, margin, and billing position. Replaced when the job runs again the same New York day. Complete projects get the row for the day they reach complete. Cancelled projects are not written.';
