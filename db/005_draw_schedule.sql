-- ============================================================================
-- DRAW SCHEDULE TEMPLATES AND RETAINAGE
--
-- Closes docs/OPEN_ITEMS.md #2. API Contract §3.1 says project creation seeds
-- "a draw schedule from the tenant default", and no such default existed, so
-- creation reported draws_created: 0 and somebody built the schedule by hand
-- every time.
--
-- Mason, August 2026: "we do a 30/30/30/10 schedule. the 10% is the retainage
-- for punchlist and closeout."
--
-- Per tenant and editable, not hardcoded, for the same reason gate count and
-- compliance requirements are per tenant: 30/30/30/10 is how Mr Handyman
-- works, and Mr Handyman is tenant one rather than a special case in the
-- product.
--
-- is_retainage is a separate flag rather than "the last one". Retainage is not
-- simply the final instalment — it is money the customer holds back until
-- punch list and closeout are done, it is released by a different event than
-- the draws before it, and a statement has to show it as held rather than
-- merely unbilled. A schedule could also carry no retainage at all.
-- ============================================================================

SET search_path = projects, public;

CREATE TABLE IF NOT EXISTS draw_templates (
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_number   smallint NOT NULL,
  label             text NOT NULL,
  trigger_milestone text NOT NULL,
  -- 0.3000 = 30%. Four decimal places so a schedule like 33.33/33.33/33.34
  -- is expressible.
  percentage        numeric(6,4) NOT NULL CHECK (percentage > 0 AND percentage <= 1),
  is_retainage      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, sequence_number)
);
COMMENT ON TABLE draw_templates IS
  'The tenant default draw schedule, applied at project creation. Percentages of the original contract value — an approved change order is invoiced separately rather than reopening this schedule, so these do not recalculate.';
COMMENT ON COLUMN draw_templates.is_retainage IS
  'Money the customer holds until punch list and closeout, not simply the last instalment. Released by a different event than the draws before it, and shown as held rather than unbilled on a statement.';

ALTER TABLE draw_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE draw_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON draw_templates;
CREATE POLICY tenant_isolation ON draw_templates
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

ALTER TABLE draws
  ADD COLUMN IF NOT EXISTS is_retainage boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN draws.is_retainage IS
  'Carried from the template. A statement reports retainage separately because money held back is not the same as money not yet earned.';

-- ---------------------------------------------------------------------------
-- Activation seeds the default schedule alongside the gates and compliance
-- requirements. CREATE OR REPLACE rather than a new function so the single
-- activate_tenant() call in src/db/activation.ts keeps working unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION activate_tenant(p_tenant uuid) RETURNS void AS $$
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
END $$ LANGUAGE plpgsql SET search_path = projects, pg_temp;

-- Tenants activated before this migration have no draw templates. Backfill
-- them, since the alternative is that only accounts created after today get a
-- default schedule.
--
-- One tenant at a time, with app.tenant_id set for each. draw_templates has
-- FORCE ROW LEVEL SECURITY and its policy is tenant_enabled(tenant_id), which
-- applies to the table's owner too — so a single set-based INSERT run by
-- jp_owner with no tenant set fails the WITH CHECK on every row.
--
-- This is worth reading twice, because `pnpm db:apply --dry-run` CANNOT catch
-- it: the dry run applies as a superuser, and a superuser bypasses RLS
-- entirely. A migration that writes data to a tenant-scoped table is invisible
-- to that check and only fails on a real deployment. See docs/OPEN_ITEMS.md.
--
-- Tenants whose entitlement has lapsed are skipped, because tenant_enabled()
-- is false for them. That is correct: a cancelled account does not need a
-- draw schedule.
DO $backfill$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM projects.tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    BEGIN
      INSERT INTO projects.draw_templates
        (tenant_id, sequence_number, label, trigger_milestone, percentage, is_retainage)
      VALUES
        (t.id,1,'Deposit','Contract signed',0.3000,false),
        (t.id,2,'Draw 1','Rough-in complete and inspections passed',0.3000,false),
        (t.id,3,'Draw 2','Substantial completion',0.3000,false),
        (t.id,4,'Retainage','Punch list and closeout complete',0.1000,true)
      ON CONFLICT DO NOTHING;
    EXCEPTION WHEN insufficient_privilege THEN
      -- Entitlement not live. Skip rather than abort the whole migration for
      -- an account that is switched off.
      RAISE NOTICE 'skipped draw template backfill for tenant % (not entitled)', t.id;
    END;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $backfill$;
