-- Project budget entry. Hours are new. Category dollars stay on budget_lines.
-- JP.BUDGET is one cost code with a line per cost type, so the Financials
-- form and the cost-code lines write the same table. Contract value stays
-- on projects.contract_value. Null means not entered. Zero is a real zero.

SET search_path = projects, public;

ALTER TABLE projects.projects
  ADD COLUMN IF NOT EXISTS budgeted_labor_hours numeric(12,2);

ALTER TABLE projects.projects
  DROP CONSTRAINT IF EXISTS projects_budgeted_labor_hours_check;

ALTER TABLE projects.projects
  ADD CONSTRAINT projects_budgeted_labor_hours_check
  CHECK (budgeted_labor_hours IS NULL OR budgeted_labor_hours >= 0);

COMMENT ON COLUMN projects.budgeted_labor_hours IS
  'Labor hours entered on the project budget. Null means not entered. Zero is a real zero. Not a ServiceTitan figure.';

INSERT INTO cost_code_library
  (code, division_code, division_name, description, default_cost_type, ledger_account, sort_order)
VALUES
  ('JP.BUDGET', '000', 'Project budget', 'Project budget', 'O'::projects.cost_type,
   '50400 COGS — Other Job Costs', 5)
ON CONFLICT (code) DO NOTHING;

-- Existing entitled tenants. New tenants receive the code from seed_cost_codes().
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM projects.tenants LOOP
    IF NOT projects.module_live(t, 'estimating') OR NOT projects.module_live(t, 'projects') THEN
      CONTINUE;
    END IF;
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO projects.cost_codes
      (tenant_id, code, division_code, division_name, description,
       default_cost_type, ledger_account, sort_order, active)
    SELECT t, l.code, l.division_code, l.division_name, l.description,
           l.default_cost_type, l.ledger_account, l.sort_order, true
      FROM projects.cost_code_library l
     WHERE l.code = 'JP.BUDGET'
    ON CONFLICT (tenant_id, code) DO NOTHING;
  END LOOP;
END $$;
