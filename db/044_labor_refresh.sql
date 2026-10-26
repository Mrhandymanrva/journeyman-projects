-- Records when labor was last refreshed and whether a person or the hourly
-- job did it. manual is the Refresh hours button. auto-hourly is the scheduler.
-- Logged project start dates are left as they are.

SET search_path = projects, public;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS labor_refreshed_at timestamptz,
  ADD COLUMN IF NOT EXISTS labor_refresh_source text;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_labor_refresh_source_check;
ALTER TABLE projects ADD CONSTRAINT projects_labor_refresh_source_check
  CHECK (
    labor_refresh_source IS NULL
    OR labor_refresh_source IN ('manual', 'auto-hourly')
  );

COMMENT ON COLUMN projects.labor_refreshed_at IS
  'When the last labor refresh finished for this project.';
COMMENT ON COLUMN projects.labor_refresh_source IS
  'manual is the Refresh hours button. auto-hourly is the hourly job.';
