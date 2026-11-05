-- The labor code is the one active ServiceTitan labor type, read and mirrored.
-- It is not a setting. The old picker columns stay so existing rows are not dropped.
-- Logged project start dates are left as they are.
-- Seeded cost codes stay. Stored labor hours are not cleared here.

SET search_path = projects, public;

ALTER TABLE cost_codes
  ADD COLUMN IF NOT EXISTS external_source text,
  ADD COLUMN IF NOT EXISTS external_id text;

COMMENT ON COLUMN cost_codes.external_source IS
  'servicetitan_labor_type marks the mirrored ServiceTitan labor type. Null is a Journeyman cost code.';
COMMENT ON COLUMN cost_codes.external_id IS
  'ServiceTitan id of the mirrored labor type. Null on a Journeyman cost code.';

COMMENT ON COLUMN tenant_settings.labor_cost_code_id IS
  'Retired. Not read. The labor code comes from ServiceTitan Payroll > Labor Types. The column remains so existing rows are not dropped.';
COMMENT ON COLUMN projects.labor_cost_code_id IS
  'Retired. Not read. A project no longer overrides the labor code. The column remains so existing rows are not dropped.';
