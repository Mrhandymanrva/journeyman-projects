-- Change-order log and closeout record.
--
-- Found, priced, entered in ServiceTitan, and signed are a log. Signed does
-- not post the budget and does not require the change order to be sent.
-- Approve still posts the budget and still requires sent.
--
-- project_closeout is one row per project. The review request is a note in
-- this table. Nothing here emails the customer or writes to ServiceTitan.
--
-- Gate 4's template is filled only where the checklist is still []. Project
-- copies in stage_gates are not rewritten.

SET search_path = projects, public;

ALTER TABLE change_orders
  ADD COLUMN IF NOT EXISTS found_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS priced_at timestamptz,
  ADD COLUMN IF NOT EXISTS priced_by uuid,
  ADD COLUMN IF NOT EXISTS entered_st_at timestamptz,
  ADD COLUMN IF NOT EXISTS entered_by uuid,
  ADD COLUMN IF NOT EXISTS st_estimate_number text,
  ADD COLUMN IF NOT EXISTS signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS signed_recorded_by uuid,
  ADD COLUMN IF NOT EXISTS signature_note text;

ALTER TABLE change_orders DROP CONSTRAINT IF EXISTS change_orders_priced_by_fkey;
ALTER TABLE change_orders
  ADD CONSTRAINT change_orders_priced_by_fkey
  FOREIGN KEY (tenant_id, priced_by) REFERENCES staff (tenant_id, id);

ALTER TABLE change_orders DROP CONSTRAINT IF EXISTS change_orders_entered_by_fkey;
ALTER TABLE change_orders
  ADD CONSTRAINT change_orders_entered_by_fkey
  FOREIGN KEY (tenant_id, entered_by) REFERENCES staff (tenant_id, id);

ALTER TABLE change_orders DROP CONSTRAINT IF EXISTS change_orders_signed_recorded_by_fkey;
ALTER TABLE change_orders
  ADD CONSTRAINT change_orders_signed_recorded_by_fkey
  FOREIGN KEY (tenant_id, signed_recorded_by) REFERENCES staff (tenant_id, id);

ALTER TABLE change_orders DROP CONSTRAINT IF EXISTS change_orders_priced_pair_check;
ALTER TABLE change_orders
  ADD CONSTRAINT change_orders_priced_pair_check CHECK (
    (priced_at IS NULL AND priced_by IS NULL)
    OR (priced_at IS NOT NULL AND priced_by IS NOT NULL)
  );

ALTER TABLE change_orders DROP CONSTRAINT IF EXISTS change_orders_entered_pair_check;
ALTER TABLE change_orders
  ADD CONSTRAINT change_orders_entered_pair_check CHECK (
    (
      entered_st_at IS NULL
      AND entered_by IS NULL
      AND st_estimate_number IS NULL
    )
    OR (
      entered_st_at IS NOT NULL
      AND entered_by IS NOT NULL
      AND st_estimate_number IS NOT NULL
      AND char_length(btrim(st_estimate_number)) BETWEEN 1 AND 80
    )
  );

ALTER TABLE change_orders DROP CONSTRAINT IF EXISTS change_orders_signed_pair_check;
ALTER TABLE change_orders
  ADD CONSTRAINT change_orders_signed_pair_check CHECK (
    (
      signed_at IS NULL
      AND signed_recorded_by IS NULL
      AND signature_note IS NULL
    )
    OR (
      signed_at IS NOT NULL
      AND signed_recorded_by IS NOT NULL
      AND (signature_note IS NULL OR char_length(signature_note) <= 2000)
    )
  );

COMMENT ON COLUMN change_orders.found_at IS
  'When the change order row was created. The log starts here.';
COMMENT ON COLUMN change_orders.priced_at IS
  'When an owner or manager recorded the customer amount or the cost lines.';
COMMENT ON COLUMN change_orders.entered_st_at IS
  'When someone recorded that the estimate was entered in ServiceTitan. This column does not write to ServiceTitan.';
COMMENT ON COLUMN change_orders.st_estimate_number IS
  'ServiceTitan estimate number pasted or chosen for this change order.';
COMMENT ON COLUMN change_orders.signed_at IS
  'When someone recorded that the tech collected the customer signature. Signing does not post the budget.';
COMMENT ON COLUMN change_orders.signature_note IS
  'Note about the signature the tech brought back. Nothing is sent to the customer.';

CREATE TABLE IF NOT EXISTS project_closeout (
  project_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  punch_done_at timestamptz,
  punch_note text CHECK (punch_note IS NULL OR char_length(punch_note) <= 2000),
  photos_done_at timestamptz,
  photos_note text CHECK (photos_note IS NULL OR char_length(photos_note) <= 2000),
  final_draw_invoice_number text CHECK (
    final_draw_invoice_number IS NULL
    OR char_length(btrim(final_draw_invoice_number)) BETWEEN 1 AND 80
  ),
  warranty_start_on date,
  review_request_note text CHECK (
    review_request_note IS NULL OR char_length(review_request_note) <= 2000
  ),
  review_request_recorded_at timestamptz,
  review_request_recorded_by uuid,
  UNIQUE (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, review_request_recorded_by) REFERENCES staff (tenant_id, id),
  CONSTRAINT project_closeout_review_pair_check CHECK (
    (
      review_request_note IS NULL
      AND review_request_recorded_at IS NULL
      AND review_request_recorded_by IS NULL
    )
    OR (
      review_request_note IS NOT NULL
      AND char_length(btrim(review_request_note)) > 0
      AND review_request_recorded_at IS NOT NULL
      AND review_request_recorded_by IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS project_closeout_tenant ON project_closeout (tenant_id);

ALTER TABLE project_closeout ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_closeout FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON project_closeout;
CREATE POLICY tenant_isolation ON project_closeout
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

COMMENT ON TABLE project_closeout IS
  'Punch, photos, final draw invoice number, warranty start, and the review-request note. Photos stay in the photos folder. The review request is not emailed.';

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
    (p_tenant, 4, 'Closeout', 'manager', false, $gate4$[
      {"key":"punch_list","label":"punch list complete"},
      {"key":"final_photos","label":"final photos filed"},
      {"key":"final_draw_invoice","label":"final draw invoice recorded"},
      {"key":"warranty_start","label":"warranty start date set"},
      {"key":"review_request","label":"review request recorded"}
    ]$gate4$::jsonb)
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

-- Tenants activated before this migration have an empty Gate 4 template.
-- FORCE ROW LEVEL SECURITY applies to the table owner, so the update runs
-- one tenant at a time with app.tenant_id set.
DO $backfill$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM projects.tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    BEGIN
      UPDATE projects.gate_templates
         SET checklist = $gate4$[
           {"key":"punch_list","label":"punch list complete"},
           {"key":"final_photos","label":"final photos filed"},
           {"key":"final_draw_invoice","label":"final draw invoice recorded"},
           {"key":"warranty_start","label":"warranty start date set"},
           {"key":"review_request","label":"review request recorded"}
         ]$gate4$::jsonb
       WHERE tenant_id = t.id
         AND gate_number = 4
         AND checklist = '[]'::jsonb;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'skipped closeout checklist backfill for tenant % (not entitled)', t.id;
    END;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$backfill$;
