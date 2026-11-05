-- Gate 1 and Gate 2 ship with a checklist. Approval still requires a person
-- to tick every item. These rows are hints' keys, not automatic ticks.
--
-- Only a template whose checklist is still [] is filled. A tenant that already
-- wrote its own items keeps them. Project copies in stage_gates are not
-- rewritten: a job that already has ticks keeps those answers, and a job
-- whose checklist is still empty can opt in with apply-template.

SET search_path = projects, public;

CREATE OR REPLACE FUNCTION activate_tenant(p_tenant uuid) RETURNS void AS $fn$
BEGIN
  INSERT INTO projects.compliance_requirements (tenant_id, kind, required)
  VALUES (p_tenant,'master_agreement',true),(p_tenant,'tax_form',true),
         (p_tenant,'license',true),(p_tenant,'gl_insurance',true),
         (p_tenant,'wc_insurance',true),(p_tenant,'auto_insurance',true)
  ON CONFLICT DO NOTHING;

  INSERT INTO projects.gate_templates
    (tenant_id, gate_number, title, approver_role, freezes_baseline, checklist) VALUES
    (p_tenant, 0, 'Qualification and handoff', 'manager', false, '[]'::jsonb),
    (p_tenant, 1, 'Preconstruction', 'manager', true, $gate1$[
      {"key":"accepted_estimate","label":"accepted estimate on file"},
      {"key":"scope","label":"scope of work on file"},
      {"key":"budget_by_cost_code","label":"budget entered by cost code"},
      {"key":"permit_need","label":"permit need decided"},
      {"key":"subs","label":"subcontractors identified"},
      {"key":"materials","label":"materials identified"},
      {"key":"target_window","label":"target window set"}
    ]$gate1$::jsonb),
    (p_tenant, 2, 'Mobilization', 'project_manager', false, $gate2$[
      {"key":"field_start","label":"field start date set"},
      {"key":"precon_clear","label":"preconstruction tasks done or waived"},
      {"key":"permit_issued","label":"permit issued or not required"},
      {"key":"subs_compliant","label":"awarded subs compliant"},
      {"key":"materials_ordered","label":"material orders entered"},
      {"key":"site_ready","label":"site access confirmed"}
    ]$gate2$::jsonb),
    (p_tenant, 3, 'Substantial completion', 'manager', false, '[]'::jsonb),
    (p_tenant, 4, 'Closeout', 'manager', false, '[]'::jsonb)
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

-- Tenants activated before this migration have an empty Gate 1 and Gate 2
-- template. FORCE ROW LEVEL SECURITY applies to the table owner, so the
-- update runs one tenant at a time with app.tenant_id set.
DO $backfill$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM projects.tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    BEGIN
      UPDATE projects.gate_templates
         SET checklist = $gate1$[
           {"key":"accepted_estimate","label":"accepted estimate on file"},
           {"key":"scope","label":"scope of work on file"},
           {"key":"budget_by_cost_code","label":"budget entered by cost code"},
           {"key":"permit_need","label":"permit need decided"},
           {"key":"subs","label":"subcontractors identified"},
           {"key":"materials","label":"materials identified"},
           {"key":"target_window","label":"target window set"}
         ]$gate1$::jsonb
       WHERE tenant_id = t.id
         AND gate_number = 1
         AND checklist = '[]'::jsonb;

      UPDATE projects.gate_templates
         SET checklist = $gate2$[
           {"key":"field_start","label":"field start date set"},
           {"key":"precon_clear","label":"preconstruction tasks done or waived"},
           {"key":"permit_issued","label":"permit issued or not required"},
           {"key":"subs_compliant","label":"awarded subs compliant"},
           {"key":"materials_ordered","label":"material orders entered"},
           {"key":"site_ready","label":"site access confirmed"}
         ]$gate2$::jsonb
       WHERE tenant_id = t.id
         AND gate_number = 2
         AND checklist = '[]'::jsonb;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'skipped gate checklist backfill for tenant % (not entitled)', t.id;
    END;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$backfill$;
