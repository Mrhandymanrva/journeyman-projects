SET search_path = projects, public;
CREATE TABLE dispatch_snapshots (
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 project_id uuid NOT NULL,
 job_link_id uuid PRIMARY KEY,
 connection_key text NOT NULL,
 observed_at timestamptz NOT NULL,
 payload jsonb NOT NULL,
 FOREIGN KEY (tenant_id,project_id,job_link_id) REFERENCES project_job_links(tenant_id,project_id,id) ON DELETE CASCADE
);
CREATE TABLE reconciliation_snapshots (
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 external_system_id uuid NOT NULL,
 connection_key text NOT NULL,
 observed_at timestamptz NOT NULL,
 payload jsonb NOT NULL,
 PRIMARY KEY (tenant_id,external_system_id),
 FOREIGN KEY (tenant_id,external_system_id) REFERENCES external_systems(tenant_id,id)
);
DO $policies$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['dispatch_snapshots','reconciliation_snapshots'] LOOP
  EXECUTE format('ALTER TABLE projects.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE projects.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON projects.%I USING (projects.tenant_enabled(tenant_id)) WITH CHECK (projects.tenant_enabled(tenant_id))',t);
 END LOOP;
END $policies$;
