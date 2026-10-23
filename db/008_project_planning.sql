-- Project planning remains platform-neutral. External IDs are references,
-- not evidence that a connector is configured or has synchronized anything.
SET search_path = projects, public;

ALTER TABLE projects ADD CONSTRAINT projects_tenant_id_uq UNIQUE (tenant_id, id);
ALTER TABLE vendors ADD CONSTRAINT vendors_tenant_id_uq UNIQUE (tenant_id, id);
ALTER TABLE external_systems ADD CONSTRAINT external_systems_tenant_id_uq UNIQUE (tenant_id, id);
ALTER TABLE schedule_items ADD CONSTRAINT schedule_tenant_project_id_uq UNIQUE (tenant_id, project_id, id);

CREATE TABLE scheduling_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  kind text NOT NULL CHECK (kind IN ('employee','crew','subcontractor')),
  trade text,
  vendor_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES vendors(tenant_id, id),
  CHECK (kind <> 'subcontractor' OR vendor_id IS NOT NULL)
);

CREATE TABLE project_job_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL,
  external_system_id uuid NOT NULL,
  external_job_id text NOT NULL CHECK (length(trim(external_job_id)) > 0),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, id),
  UNIQUE (tenant_id, external_system_id, external_job_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, external_system_id) REFERENCES external_systems(tenant_id, id)
);

ALTER TABLE schedule_items ADD COLUMN phase text;
ALTER TABLE schedule_items ADD COLUMN job_link_id uuid;
ALTER TABLE schedule_items ADD CONSTRAINT schedule_job_project_fk
  FOREIGN KEY (tenant_id, project_id, job_link_id)
  REFERENCES project_job_links(tenant_id, project_id, id);

CREATE TABLE schedule_assignments (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL,
  schedule_item_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  PRIMARY KEY (schedule_item_id, resource_id),
  FOREIGN KEY (tenant_id, project_id, schedule_item_id)
    REFERENCES schedule_items(tenant_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, resource_id) REFERENCES scheduling_resources(tenant_id, id)
);
CREATE INDEX schedule_assignments_resource_idx ON schedule_assignments(tenant_id, resource_id);

CREATE TABLE schedule_dependencies (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL,
  schedule_item_id uuid NOT NULL,
  predecessor_id uuid NOT NULL,
  lag_days integer NOT NULL DEFAULT 0 CHECK (lag_days BETWEEN 0 AND 365),
  PRIMARY KEY (schedule_item_id, predecessor_id),
  CHECK (schedule_item_id <> predecessor_id),
  FOREIGN KEY (tenant_id, project_id, schedule_item_id)
    REFERENCES schedule_items(tenant_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id, predecessor_id)
    REFERENCES schedule_items(tenant_id, project_id, id) ON DELETE CASCADE
);

DO $backfill$
DECLARE tenant_record record;
BEGIN
  FOR tenant_record IN SELECT id FROM projects.tenants LOOP
    PERFORM set_config('app.tenant_id', tenant_record.id::text, true);
    INSERT INTO projects.project_job_links(tenant_id,project_id,external_system_id,external_job_id,title)
      SELECT tenant_id,id,external_system_id,external_job_id,name FROM projects.projects
      WHERE tenant_id=tenant_record.id AND external_system_id IS NOT NULL AND length(trim(external_job_id)) > 0
      ON CONFLICT DO NOTHING;
  END LOOP;
END $backfill$;

DO $policies$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scheduling_resources','project_job_links','schedule_assignments','schedule_dependencies'] LOOP
    EXECUTE format('ALTER TABLE projects.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE projects.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON projects.%I USING (projects.tenant_enabled(tenant_id)) WITH CHECK (projects.tenant_enabled(tenant_id))', t);
  END LOOP;
END $policies$;

-- Composite FKs protect tenant and project ownership even outside the API.
-- Check every assigned subcontractor when a window becomes firm, and when
-- someone adds a resource to an already firm window.
CREATE FUNCTION check_schedule_resource_compliance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE item_id uuid; blocked boolean;
BEGIN
  IF TG_TABLE_NAME = 'schedule_assignments' THEN item_id := NEW.schedule_item_id;
  ELSE item_id := NEW.id;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM projects.schedule_items s
    JOIN projects.schedule_assignments a ON a.schedule_item_id = s.id
    JOIN projects.scheduling_resources r ON r.id = a.resource_id
    LEFT JOIN projects.v_vendor_eligibility e ON e.vendor_id = r.vendor_id
    WHERE s.id = item_id AND s.status IN ('confirmed','in_progress')
      AND r.vendor_id IS NOT NULL AND NOT COALESCE(e.schedulable, false)
  ) INTO blocked;
  IF blocked THEN RAISE EXCEPTION 'Assigned vendor cannot be scheduled: compliance is not current' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER schedule_resource_compliance AFTER INSERT OR UPDATE ON schedule_assignments
FOR EACH ROW EXECUTE FUNCTION check_schedule_resource_compliance();
CREATE TRIGGER schedule_all_resource_compliance AFTER INSERT OR UPDATE ON schedule_items
FOR EACH ROW EXECUTE FUNCTION check_schedule_resource_compliance();
