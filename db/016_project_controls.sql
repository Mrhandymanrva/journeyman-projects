SET search_path=projects,public;
CREATE TABLE project_controls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), project_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('task','goal','milestone','risk','communication','reserve','document','report')),
 data jsonb NOT NULL, version integer NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX project_controls_project ON project_controls(tenant_id,project_id,kind);
CREATE TABLE project_control_files (
 tenant_id uuid NOT NULL,record_id uuid PRIMARY KEY,file_name text NOT NULL,media_type text NOT NULL,file_data bytea NOT NULL,file_size integer NOT NULL CHECK(file_size>0 AND file_size<=8388608),
 FOREIGN KEY(tenant_id,record_id) REFERENCES project_controls(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE project_control_baselines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,project_id uuid NOT NULL,start_on date NOT NULL,finish_on date NOT NULL,total integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),CHECK(finish_on>=start_on),FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE project_control_progress (
 tenant_id uuid NOT NULL,baseline_id uuid NOT NULL,on_date date NOT NULL,total integer NOT NULL,remaining integer NOT NULL,
 PRIMARY KEY(baseline_id,on_date),FOREIGN KEY(tenant_id,baseline_id) REFERENCES project_control_baselines(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE project_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_controls USING(projects.tenant_enabled(tenant_id)) WITH CHECK(projects.tenant_enabled(tenant_id));
ALTER TABLE project_control_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_control_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_control_files USING(projects.tenant_enabled(tenant_id)) WITH CHECK(projects.tenant_enabled(tenant_id));
ALTER TABLE project_control_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_control_baselines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_control_baselines USING(projects.tenant_enabled(tenant_id)) WITH CHECK(projects.tenant_enabled(tenant_id));
ALTER TABLE project_control_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_control_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_control_progress USING(projects.tenant_enabled(tenant_id)) WITH CHECK(projects.tenant_enabled(tenant_id));
