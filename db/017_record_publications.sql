SET search_path=projects,public;
CREATE TABLE record_publications (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,project_id uuid NOT NULL,record_id uuid NOT NULL,record_version integer NOT NULL,
 format text NOT NULL CHECK(format IN ('pdf','original')),connection_key text NOT NULL,external_project_id text NOT NULL,external_job_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('publishing','confirmed','partial','uncertain','failed')),
 file_name text NOT NULL,media_type text NOT NULL,file_data bytea NOT NULL,sha256 text NOT NULL,note_text text NOT NULL,
 attachment_id text,message text NOT NULL DEFAULT '',requested_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,record_id,record_version,format,connection_key,external_job_id),
 FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id),
 FOREIGN KEY(tenant_id,record_id) REFERENCES project_controls(tenant_id,id),
 FOREIGN KEY(tenant_id,requested_by) REFERENCES staff(tenant_id,id)
);
ALTER TABLE record_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON record_publications USING(projects.tenant_enabled(tenant_id)) WITH CHECK(projects.tenant_enabled(tenant_id));
CREATE INDEX record_publications_project ON record_publications(tenant_id,project_id,record_id);
