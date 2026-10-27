-- Where a project's labor hours came from, and the ServiceTitan labor breakdown.
-- Re-applied on every boot. Every statement is idempotent.
-- Nothing here writes to ServiceTitan.

SET search_path = projects, public;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS labor_cost_source text;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_labor_cost_source_check;
ALTER TABLE projects ADD CONSTRAINT projects_labor_cost_source_check
  CHECK (
    labor_cost_source IS NULL
    OR labor_cost_source IN ('payroll', 'billed_labor_25pct', 'none_recent_payroll_missing')
  );

COMMENT ON COLUMN projects.labor_cost_source IS
  'payroll: gross-pay TimesheetTime paid hours were found for this project. billed_labor_25pct: no matching payroll rows and the project is older than 60 days, so labor cost is 25% of billed labor plus timesheet burden. none_recent_payroll_missing: no matching payroll rows and every dated job was created within 60 days, so the 25% estimate was not applied.';

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS labor_estimate jsonb;

COMMENT ON COLUMN projects.labor_estimate IS
  'Commission (25% of billed labor), timesheet burden, and the MHM.25PLFE-only comparison. Set only when labor_cost_source is billed_labor_25pct. Null on the payroll path. Does not include technician names or rates.';

ALTER TABLE st_financial_reconciliation
  ADD COLUMN IF NOT EXISTS st_labor jsonb;

COMMENT ON COLUMN st_financial_reconciliation.st_labor IS
  'ServiceTitan labor breakdown from the last refresh: burden (payroll hours times burden rate), non-PTO gross pay on the project jobs, and payroll adjustments. Null when that read did not produce a breakdown. Drive time is not included.';
