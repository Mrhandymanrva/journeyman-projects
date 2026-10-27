-- Posted commission replaces the 60-day split.
-- Re-applied on every boot. Every statement is idempotent.
-- Nothing here writes to ServiceTitan.

SET search_path = projects, public;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_labor_cost_source_check;
ALTER TABLE projects ADD CONSTRAINT projects_labor_cost_source_check
  CHECK (
    labor_cost_source IS NULL
    OR labor_cost_source IN (
      'payroll',
      'billed_labor_25pct',
      'none_recent_payroll_missing',
      'posted_commission'
    )
  );

COMMENT ON COLUMN projects.labor_cost_source IS
  'posted_commission: InvoiceRelatedBonus gross-pay rows exist on the project jobs. billed_labor_25pct: the payroll read succeeded and no such rows exist, so commission is 25% of reconciled billed labor. payroll and none_recent_payroll_missing are leftover values from the previous refresh and are not written anymore. Burden is not stored as a dollar amount; it is not available until a source is approved.';

COMMENT ON COLUMN projects.labor_estimate IS
  'Commission from posted InvoiceRelatedBonus, or 25% of the reconciliation billedLabor when no posted rows exist. Burden is null and is not included in total. No technician names or rates.';
