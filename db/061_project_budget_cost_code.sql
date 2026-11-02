-- Copy JP.BUDGET onto every company that uses projects.
--
-- 054 inserted the library row, then copied it into projects.cost_codes only
-- when module_live(estimating) AND module_live(projects). A company with
-- projects and no estimating entitlement never received the row, and the
-- Financials save then failed with "The project budget cost code is not on
-- this company yet." New companies still receive the code from
-- seed_cost_codes(). This file only backfills companies that already exist.
--
-- Re-applied on every boot. The copy is idempotent: NOT EXISTS plus
-- ON CONFLICT DO NOTHING, so a second run adds nothing.
--
-- cost_codes has FORCE ROW LEVEL SECURITY, and tenant_enabled() still
-- requires estimating. The table owner is subject to that policy, so an
-- insert for a projects-only company would be rejected. FORCE is lifted for
-- this one statement and put back before the statement commits. A failure
-- rolls the lift back with the statement.

SET search_path = projects, public;

DO $backfill$
DECLARE t uuid;
BEGIN
  ALTER TABLE projects.cost_codes NO FORCE ROW LEVEL SECURITY;

  FOR t IN SELECT id FROM projects.tenants LOOP
    -- entitlements is readable only for the selected company. Set the tenant
    -- before module_live(), or the check sees no row and skips everyone.
    PERFORM set_config('app.tenant_id', t::text, true);
    IF NOT projects.module_live(t, 'projects') THEN
      CONTINUE;
    END IF;

    INSERT INTO projects.cost_codes
      (tenant_id, code, division_code, division_name, description,
       default_cost_type, ledger_account, sort_order, active)
    SELECT t, l.code, l.division_code, l.division_name, l.description,
           l.default_cost_type, l.ledger_account, l.sort_order, true
      FROM projects.cost_code_library l
     WHERE l.code = 'JP.BUDGET'
       AND NOT EXISTS (
         SELECT 1
           FROM projects.cost_codes c
          WHERE c.tenant_id = t
            AND c.code = l.code
       )
    ON CONFLICT (tenant_id, code) DO NOTHING;
  END LOOP;

  ALTER TABLE projects.cost_codes FORCE ROW LEVEL SECURITY;
  PERFORM set_config('app.tenant_id', '', true);
END
$backfill$;
