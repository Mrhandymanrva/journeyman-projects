-- Journeyman stage ↔ ServiceTitan project status.
-- Re-applied on every boot. Every statement is idempotent.
--
-- stage_changed_at is the Journeyman side of "later change wins".
-- The st_status_* columns are the last ServiceTitan status we observed
-- and the last write we attempted. There is no on/off switch for the sync.

SET search_path = projects, public;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS stage_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS st_status_id text,
  ADD COLUMN IF NOT EXISTS st_substatus_id text,
  ADD COLUMN IF NOT EXISTS st_status_name text,
  ADD COLUMN IF NOT EXISTS st_substatus_name text,
  ADD COLUMN IF NOT EXISTS st_status_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS st_status_modified_on timestamptz,
  ADD COLUMN IF NOT EXISTS st_status_write_result text,
  ADD COLUMN IF NOT EXISTS st_status_write_detail text,
  ADD COLUMN IF NOT EXISTS st_status_gate_warning text;

COMMENT ON COLUMN projects.stage_changed_at IS
  'When the Journeyman stage last changed, including a change applied from ServiceTitan. Compared with the ServiceTitan project modifiedOn. The later timestamp wins. Null means Journeyman has not recorded a stage change, so an inbound status may set the stage.';

COMMENT ON COLUMN projects.st_status_id IS
  'Last ServiceTitan project status id observed for this project.';

COMMENT ON COLUMN projects.st_substatus_id IS
  'Last ServiceTitan project sub-status id observed for this project.';

COMMENT ON COLUMN projects.st_status_synced_at IS
  'When that ServiceTitan status was last read or written.';

COMMENT ON COLUMN projects.st_status_write_result IS
  'Last outbound status write: ok, skipped, rejected, or failed. Null if Journeyman has not written.';

COMMENT ON COLUMN projects.st_status_gate_warning IS
  'Shown when ServiceTitan moved the stage without satisfying Journeyman gates. Gates are not auto-approved.';
