SET search_path=projects,public;
CREATE TABLE IF NOT EXISTS st_project_connections (
 project_id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 external_system_id uuid NOT NULL,external_project_id text NOT NULL,connection_key text NOT NULL,
 snapshot jsonb NOT NULL,observed_at timestamptz NOT NULL,linked_by uuid NOT NULL,
 UNIQUE(tenant_id,external_system_id,external_project_id),
 FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,external_system_id) REFERENCES external_systems(tenant_id,id),
 FOREIGN KEY(tenant_id,linked_by) REFERENCES staff(tenant_id,id)
);
ALTER TABLE st_project_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE st_project_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON st_project_connections USING(projects.tenant_enabled(tenant_id)) WITH CHECK(projects.tenant_enabled(tenant_id));
