SET search_path=projects,public;
ALTER TABLE staff ADD COLUMN phone text;
ALTER TABLE staff ADD COLUMN login_bootstrap boolean NOT NULL DEFAULT true;
ALTER TABLE staff ALTER COLUMN login_bootstrap SET DEFAULT false;
ALTER TABLE staff ADD COLUMN password_hash text;
ALTER TABLE staff ADD COLUMN source_person_id text;
ALTER TABLE staff ADD COLUMN source_person_kind text CHECK(source_person_kind IN ('employee','technician'));
ALTER TABLE staff ADD COLUMN source_connection_key text;
CREATE UNIQUE INDEX staff_source_person_uq ON staff(tenant_id,source_connection_key,source_person_kind,source_person_id);
CREATE TABLE staff_login_tokens (
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 token_hash text PRIMARY KEY, staff_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('setup','session')),
 expires_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX staff_login_tokens_staff ON staff_login_tokens(tenant_id,staff_id);
ALTER TABLE staff_login_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_login_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_login_tokens USING(projects.tenant_enabled(tenant_id)) WITH CHECK(projects.tenant_enabled(tenant_id));
