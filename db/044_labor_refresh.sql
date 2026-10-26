-- Records when labor was last refreshed and whether a person or the hourly
-- job did it. manual is the Refresh hours button. scheduled is the hourly job.
-- auto-hourly stays allowed so a row already written that way is still valid.
-- Logged project start dates are left as they are.
--
-- This file is re-applied on every boot, before 045. The check has to accept
-- scheduled here. A later file cannot repair a constraint this one rejects.

SET search_path = projects, public;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS labor_refreshed_at timestamptz,
  ADD COLUMN IF NOT EXISTS labor_refresh_source text;

-- 'scheduled' belongs in this check, not only in 045. provision.ts re-runs
-- every file on boot and only ignores "already exists". Dropping the check
-- and adding the shorter list fails the boot once a row has source scheduled.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_labor_refresh_source_check;
ALTER TABLE projects ADD CONSTRAINT projects_labor_refresh_source_check
  CHECK (
    labor_refresh_source IS NULL
    OR labor_refresh_source IN ('manual', 'scheduled', 'auto-hourly')
  );

COMMENT ON COLUMN projects.labor_refreshed_at IS
  'When the last labor refresh finished for this project.';
COMMENT ON COLUMN projects.labor_refresh_source IS
  'manual is the Refresh hours button. scheduled is the hourly job. auto-hourly remains valid.';
