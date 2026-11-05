-- Field start is the earliest ServiceTitan appointment, or a manual override.
-- scheduled_start stays the logged start.
--
-- This file does not write scheduled_start. A project that already exists
-- keeps the date it has. In the live book that includes:
--   320012949  2026-09-01
--   321293715  2026-10-05
--   321586598  2026-10-19
--   321612166  2026-09-17
-- A project created after this change defaults an omitted logged start to
-- the America/New_York calendar date of created_at. A ServiceTitan refresh
-- still does not overwrite scheduled_start.

SET search_path = projects, public;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS field_start date,
  ADD COLUMN IF NOT EXISTS field_start_source text,
  ADD COLUMN IF NOT EXISTS field_start_appointment_id text,
  ADD COLUMN IF NOT EXISTS field_start_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS field_start_set_by uuid;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_field_start_set_by_fkey;
ALTER TABLE projects
  ADD CONSTRAINT projects_field_start_set_by_fkey
  FOREIGN KEY (tenant_id, field_start_set_by) REFERENCES staff (tenant_id, id);

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_field_start_shape_check;
ALTER TABLE projects
  ADD CONSTRAINT projects_field_start_shape_check CHECK (
    (
      field_start IS NULL
      AND field_start_source IS NULL
      AND field_start_appointment_id IS NULL
      AND field_start_observed_at IS NULL
      AND field_start_set_by IS NULL
    )
    OR (
      field_start IS NOT NULL
      AND field_start_source = 'manual'
      AND field_start_appointment_id IS NULL
      AND field_start_observed_at IS NOT NULL
      AND field_start_set_by IS NOT NULL
    )
    OR (
      field_start IS NOT NULL
      AND field_start_source = 'servicetitan'
      AND field_start_appointment_id IS NOT NULL
      AND char_length(field_start_appointment_id) BETWEEN 1 AND 64
      AND field_start_observed_at IS NOT NULL
      AND field_start_set_by IS NULL
    )
  );

COMMENT ON COLUMN projects.scheduled_start IS
  'Logged start. A calendar date in the office, not the ServiceTitan job start and not field_start.';
COMMENT ON COLUMN projects.field_start IS
  'Earliest America/New_York day among active ServiceTitan appointments, or a manual override. Null when neither has been set. A portfolio read does not recompute it.';
COMMENT ON COLUMN projects.field_start_source IS
  'servicetitan or manual. manual is kept across a refresh. Null means unset.';
COMMENT ON COLUMN projects.field_start_appointment_id IS
  'ServiceTitan appointment that won field_start. Null when the source is manual or unset.';
COMMENT ON COLUMN projects.field_start_observed_at IS
  'When the winning appointment was read, or when a manual override was saved.';
COMMENT ON COLUMN projects.field_start_set_by IS
  'Staff member who saved a manual field start. Null unless the source is manual.';
