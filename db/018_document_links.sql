SET search_path=projects,public;
CREATE TABLE document_links (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,project_id uuid NOT NULL,record_id uuid NOT NULL,record_version integer NOT NULL,
 connection_key text NOT NULL,external_project_id text NOT NULL,url text NOT NULL,note_text text NOT NULL,
 state text NOT NULL CHECK(state IN ('publishing','confirmed','uncertain','failed')),message text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,record_id,record_version,connection_key,external_project_id),
 FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id),
 FOREIGN KEY(tenant_id,record_id) REFERENCES project_controls(tenant_id,id)
);
ALTER TABLE document_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_links USING(projects.tenant_enabled(tenant_id)) WITH CHECK(projects.tenant_enabled(tenant_id));
