-- Where a project's labor hours came from, and the ServiceTitan labor breakdown.
-- Re-applied on every boot. Every statement is idempotent.
-- Nothing here writes to ServiceTitan.

SET search_path = projects, public;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS labor_cost_source text;

-- Added only when missing. provision.ts re-applies every db/ file on each
-- boot, and 056_posted_commission.sql owns the current definition (it adds
-- 'posted_commission'). Dropping and re-adding a narrower list here failed the
-- deploy once a refresh had written 'posted_commission'. The list matches 056
-- so a database that reaches this file without the constraint gets the same
-- check 056 would leave behind.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'projects_labor_cost_source_check'
      AND conrelid = 'projects.projects'::regclass
  ) THEN
    ALTER TABLE projects.projects ADD CONSTRAINT projects_labor_cost_source_check
      CHECK (
        labor_cost_source IS NULL
        OR labor_cost_source IN (
          'payroll',
          'billed_labor_25pct',
          'none_recent_payroll_missing',
          'posted_commission'
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN projects.labor_cost_source IS
  'payroll: gross-pay TimesheetTime paid hours were found for this project. billed_labor_25pct: no matching payroll rows and the project is older than 60 days, so labor cost is 25% of billed labor plus timesheet burden. none_recent_payroll_missing: no matching payroll rows and every dated job was created within 60 days, so the 25% estimate was not applied.';

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS labor_estimate jsonb;

COMMENT ON COLUMN projects.labor_estimate IS
  'Commission (25% of the reconciliation billedLabor) and timesheet burden. Set only when labor_cost_source is billed_labor_25pct. Null on the payroll path. Does not include technician names or rates.';

ALTER TABLE st_financial_reconciliation
  ADD COLUMN IF NOT EXISTS st_labor jsonb;

COMMENT ON COLUMN st_financial_reconciliation.st_labor IS
  'ServiceTitan labor breakdown from the last refresh: burden (payroll hours times burden rate), non-PTO gross pay on the project jobs, and payroll adjustments. Null when that read did not produce a breakdown. Drive time is not included.';
