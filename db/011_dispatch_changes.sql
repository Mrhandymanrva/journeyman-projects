SET search_path=projects,public;
ALTER TABLE staff ADD CONSTRAINT staff_tenant_id_uq UNIQUE(tenant_id,id);
CREATE TABLE IF NOT EXISTS dispatch_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),project_id uuid NOT NULL,job_link_id uuid NOT NULL,
 appointment_id text NOT NULL, request_key uuid NOT NULL, requested_by uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('publishing','confirmed','failed','uncertain')),request jsonb NOT NULL,result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,project_id,job_link_id) REFERENCES project_job_links(tenant_id,project_id,id),
 FOREIGN KEY(tenant_id,requested_by) REFERENCES staff(tenant_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_change_pending ON dispatch_changes(tenant_id,job_link_id,appointment_id) WHERE state IN ('publishing','uncertain');
ALTER TABLE dispatch_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dispatch_changes USING(projects.tenant_enabled(tenant_id)) WITH CHECK(projects.tenant_enabled(tenant_id));
