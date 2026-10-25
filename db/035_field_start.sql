-- Field start is the earliest ServiceTitan appointment, or a manual override.
-- scheduled_start stays the logged start.
--
-- One-time reset of existing logged starts. Run this read-only check first
-- and keep the result; after this file applies, scheduled_start already
-- equals the created date, so the two columns match.
--
--   SELECT id,
--          name,
--          scheduled_start AS scheduled_start_before,
--          (created_at AT TIME ZONE 'America/New_York')::date AS created_date_after
--     FROM projects.projects
--    ORDER BY name;

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

-- Provision re-applies every statement. The marker table is what keeps this
-- copy from running on the next deploy. The table owner is NOSUPERUSER
-- NOBYPASSRLS, and FORCE RLS hides a lapsed tenant even with app.tenant_id
-- set, so the copy turns RLS off and back on inside this one transaction.
-- projects_touch would move updated_at, which the 90-day completed total
-- reads, so that trigger is off for the same statement.
DO $reset$
BEGIN
  IF to_regclass('projects.scheduled_start_origin_reset') IS NOT NULL THEN
    RETURN;
  END IF;

  CREATE TABLE projects.scheduled_start_origin_reset (
    applied_at timestamptz NOT NULL DEFAULT now()
  );
  COMMENT ON TABLE projects.scheduled_start_origin_reset IS
    'One row recording that migration 035 copied each project created date into scheduled_start. Not tenant data, so it has no row level security.';
  INSERT INTO projects.scheduled_start_origin_reset DEFAULT VALUES;

  ALTER TABLE projects.projects DISABLE ROW LEVEL SECURITY;
  ALTER TABLE projects.projects DISABLE TRIGGER projects_touch;
  UPDATE projects SET scheduled_start = (created_at AT TIME ZONE 'America/New_York')::date;
  ALTER TABLE projects.projects ENABLE TRIGGER projects_touch;
  ALTER TABLE projects.projects ENABLE ROW LEVEL SECURITY;
  ALTER TABLE projects.projects FORCE ROW LEVEL SECURITY;
END
$reset$;
