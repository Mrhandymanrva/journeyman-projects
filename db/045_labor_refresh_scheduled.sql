-- The hourly labor job stamps source 'scheduled'.
-- 'auto-hourly' stays allowed so a row already written that way is still valid.
-- This file does not update project rows and does not assign a logged start.

SET search_path = projects, public;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_labor_refresh_source_check;
ALTER TABLE projects ADD CONSTRAINT projects_labor_refresh_source_check
  CHECK (
    labor_refresh_source IS NULL
    OR labor_refresh_source IN ('manual', 'scheduled', 'auto-hourly')
  );

COMMENT ON COLUMN projects.labor_refresh_source IS
  'manual is the Refresh hours button. scheduled is the hourly job.';
