-- Preconstruction tasks are a project checklist, separate from project_controls
-- (the plan's JSON tasks) and from schedule_items (field work).
--
-- The template is applied when a project is created, and again only by
-- POST .../precon-tasks/apply-template when the project still has none.
-- Existing projects are not backfilled with tasks.
--
-- A permit task may point at a jurisdiction and, once a permit row exists,
-- at permits.id. This migration does not insert permit rows, and inspections
-- stay on precon_inspections so permit_milestones is not double-counted.
-- purchase_order_id may only name a kind='material' purchase order on the
-- same project. Any task may be waived.

SET search_path = projects, public;

ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_tenant_id_uq;
ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_tenant_id_uq UNIQUE (tenant_id, id);

ALTER TABLE permits DROP CONSTRAINT IF EXISTS permits_tenant_id_uq;
ALTER TABLE permits
  ADD CONSTRAINT permits_tenant_id_uq UNIQUE (tenant_id, id);

ALTER TABLE jurisdictions DROP CONSTRAINT IF EXISTS jurisdictions_tenant_id_uq;
ALTER TABLE jurisdictions
  ADD CONSTRAINT jurisdictions_tenant_id_uq UNIQUE (tenant_id, id);

CREATE TABLE IF NOT EXISTS precon_task_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_type text NOT NULL CHECK (task_type IN (
    'permit', 'site_visit', 'selection', 'plans', 'material_order', 'other'
  )),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  owner_role staff_role NOT NULL,
  due_offset_days integer,
  sort_order integer NOT NULL,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, title)
);

COMMENT ON TABLE precon_task_templates IS
  'Tenant default preconstruction checklist. Applied at project creation. The two permit rows are generic; add one permit task per permit type (building, electrical, plumbing, mechanical) as the job needs them.';
COMMENT ON COLUMN precon_task_templates.due_offset_days IS
  'Days after the project logged start (scheduled_start). Null leaves the task undated.';

CREATE TABLE IF NOT EXISTS precon_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  task_type text NOT NULL CHECK (task_type IN (
    'permit', 'site_visit', 'selection', 'plans', 'material_order', 'other'
  )),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  owner_role staff_role NOT NULL,
  due_on date,
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN (
    'not_started', 'in_progress', 'done', 'waived'
  )),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  jurisdiction_id uuid,
  permit_id uuid,
  purchase_order_id uuid,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, jurisdiction_id) REFERENCES jurisdictions (tenant_id, id),
  FOREIGN KEY (tenant_id, permit_id) REFERENCES permits (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS precon_tasks_project
  ON precon_tasks (tenant_id, project_id, sort_order, id);

COMMENT ON TABLE precon_tasks IS
  'Preconstruction checklist for one project. Status waived is available on every task. Overdue is due_on before today in America/New_York while status is not_started or in_progress.';
COMMENT ON COLUMN precon_tasks.purchase_order_id IS
  'Optional link to a kind=material purchase order on this same project. A subcontract cannot be attached.';

CREATE TABLE IF NOT EXISTS precon_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  scheduled_on date,
  occurred_on date,
  result text NOT NULL DEFAULT 'pending' CHECK (result IN (
    'pending', 'passed', 'failed', 'cancelled'
  )),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES precon_tasks (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS precon_inspections_task
  ON precon_inspections (tenant_id, task_id, scheduled_on, id);

COMMENT ON TABLE precon_inspections IS
  'Inspections under a permit preconstruction task. A milestone row is one status that gets overwritten; these rows stay. They are not copied into permit_milestones.';

ALTER TABLE precon_task_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE precon_task_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON precon_task_templates;
CREATE POLICY tenant_isolation ON precon_task_templates
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

ALTER TABLE precon_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE precon_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON precon_tasks;
CREATE POLICY tenant_isolation ON precon_tasks
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

ALTER TABLE precon_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE precon_inspections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON precon_inspections;
CREATE POLICY tenant_isolation ON precon_inspections
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

CREATE OR REPLACE FUNCTION precon_tasks_enforce_links() RETURNS trigger
LANGUAGE plpgsql
SET search_path = projects, pg_temp
AS $fn$
BEGIN
  IF NEW.purchase_order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM purchase_orders po
     WHERE po.id = NEW.purchase_order_id
       AND po.tenant_id = NEW.tenant_id
       AND po.project_id = NEW.project_id
       AND po.kind = 'material'
  ) THEN
    RAISE EXCEPTION 'Preconstruction: purchase order must be a material order on the same project'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.permit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM permits p
     WHERE p.id = NEW.permit_id
       AND p.tenant_id = NEW.tenant_id
       AND p.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'Preconstruction: permit must belong to the same project'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.task_type <> 'permit'
     AND OLD.task_type = 'permit'
     AND EXISTS (SELECT 1 FROM precon_inspections i WHERE i.task_id = NEW.id) THEN
    RAISE EXCEPTION 'Preconstruction: a permit task with inspections cannot change type'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS precon_tasks_enforce_links ON precon_tasks;
CREATE TRIGGER precon_tasks_enforce_links
  BEFORE INSERT OR UPDATE ON precon_tasks
  FOR EACH ROW EXECUTE FUNCTION precon_tasks_enforce_links();

CREATE OR REPLACE FUNCTION precon_inspections_require_permit_task() RETURNS trigger
LANGUAGE plpgsql
SET search_path = projects, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM precon_tasks t
     WHERE t.id = NEW.task_id
       AND t.tenant_id = NEW.tenant_id
       AND t.task_type = 'permit'
  ) THEN
    RAISE EXCEPTION 'Preconstruction: inspections belong on a permit task'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS precon_inspections_require_permit_task ON precon_inspections;
CREATE TRIGGER precon_inspections_require_permit_task
  BEFORE INSERT OR UPDATE ON precon_inspections
  FOR EACH ROW EXECUTE FUNCTION precon_inspections_require_permit_task();

DROP TRIGGER IF EXISTS precon_tasks_touch ON precon_tasks;
CREATE TRIGGER precon_tasks_touch
  BEFORE UPDATE ON precon_tasks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS precon_inspections_touch ON precon_inspections;
CREATE TRIGGER precon_inspections_touch
  BEFORE UPDATE ON precon_inspections
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Shipped checklist. Offset days are after the logged start (scheduled_start).
-- Project Coordinator is project_manager. Any of these may later be waived.
CREATE OR REPLACE FUNCTION activate_tenant(p_tenant uuid) RETURNS void AS $fn$
BEGIN
  INSERT INTO projects.compliance_requirements (tenant_id, kind, required)
  VALUES (p_tenant,'master_agreement',true),(p_tenant,'tax_form',true),
         (p_tenant,'license',true),(p_tenant,'gl_insurance',true),
         (p_tenant,'wc_insurance',true),(p_tenant,'auto_insurance',true)
  ON CONFLICT DO NOTHING;

  INSERT INTO projects.gate_templates (tenant_id, gate_number, title, approver_role, freezes_baseline) VALUES
    (p_tenant,0,'Qualification and handoff','manager',false),
    (p_tenant,1,'Preconstruction','manager',true),
    (p_tenant,2,'Mobilization','project_manager',false),
    (p_tenant,3,'Substantial completion','manager',false),
    (p_tenant,4,'Closeout','manager',false)
  ON CONFLICT DO NOTHING;

  INSERT INTO projects.draw_templates
    (tenant_id, sequence_number, label, trigger_milestone, percentage, is_retainage) VALUES
    (p_tenant,1,'Deposit','Contract signed',0.3000,false),
    (p_tenant,2,'Draw 1','Rough-in complete and inspections passed',0.3000,false),
    (p_tenant,3,'Draw 2','Substantial completion',0.3000,false),
    (p_tenant,4,'Retainage','Punch list and closeout complete',0.1000,true)
  ON CONFLICT DO NOTHING;

  INSERT INTO projects.permit_milestone_templates (tenant_id, sequence_number, name, owner_role, offset_days) VALUES
    (p_tenant,1,'Permit requirement determined','project_manager',-10),
    (p_tenant,2,'Application prepared and submitted','office',-7),
    (p_tenant,3,'Plan review comments addressed','project_manager',NULL),
    (p_tenant,4,'Permit issued and fee paid','office',NULL),
    (p_tenant,5,'Permit posted on site','project_manager',NULL),
    (p_tenant,6,'Trade sub permits confirmed pulled','project_manager',NULL),
    (p_tenant,7,'Rough-in inspection scheduled','project_manager',NULL),
    (p_tenant,8,'Rough-in inspection passed','project_manager',NULL),
    (p_tenant,9,'Framing or insulation inspection','project_manager',NULL),
    (p_tenant,10,'Final inspection scheduled','project_manager',NULL),
    (p_tenant,11,'Final inspection passed','project_manager',NULL),
    (p_tenant,12,'Completion certificate filed','office',NULL)
  ON CONFLICT DO NOTHING;

  INSERT INTO projects.precon_task_templates
    (tenant_id, task_type, title, owner_role, due_offset_days, sort_order) VALUES
    (p_tenant,'site_visit','Site visit and measure','estimator',3,1),
    (p_tenant,'plans','Plans or drawings','project_manager',7,2),
    (p_tenant,'selection','Selections confirmed with customer','project_manager',10,3),
    (p_tenant,'permit','Permit application submitted','project_manager',10,4),
    (p_tenant,'material_order','Materials ordered','project_manager',14,5),
    (p_tenant,'other','Subs booked','project_manager',14,6),
    (p_tenant,'permit','Permit approved','project_manager',21,7)
  ON CONFLICT DO NOTHING;
END
$fn$ LANGUAGE plpgsql SET search_path = projects, pg_temp;

-- Tenants activated before this migration have an empty template. Seed them
-- one at a time with app.tenant_id set. FORCE ROW LEVEL SECURITY applies to
-- the table owner, so a single INSERT with no tenant set fails WITH CHECK.
-- Lapsed entitlements are skipped: tenant_enabled() is false for them.
DO $backfill$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM projects.tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    BEGIN
      INSERT INTO projects.precon_task_templates
        (tenant_id, task_type, title, owner_role, due_offset_days, sort_order) VALUES
        (t.id,'site_visit','Site visit and measure','estimator',3,1),
        (t.id,'plans','Plans or drawings','project_manager',7,2),
        (t.id,'selection','Selections confirmed with customer','project_manager',10,3),
        (t.id,'permit','Permit application submitted','project_manager',10,4),
        (t.id,'material_order','Materials ordered','project_manager',14,5),
        (t.id,'other','Subs booked','project_manager',14,6),
        (t.id,'permit','Permit approved','project_manager',21,7)
      ON CONFLICT DO NOTHING;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'skipped preconstruction template backfill for tenant % (not entitled)', t.id;
    END;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$backfill$;
