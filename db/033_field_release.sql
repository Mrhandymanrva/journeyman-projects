-- Field release is a flag that field capacity was confirmed.
-- It records who released the project, when, and an optional note.
-- Undo clears that current flag. It does not remove history.
-- The flag blocks nothing, including scheduling, gates, and purchasing.

SET search_path = projects, public;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS field_released_by uuid,
  ADD COLUMN IF NOT EXISTS field_released_at timestamptz,
  ADD COLUMN IF NOT EXISTS field_release_note text;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_field_released_by_fkey;
ALTER TABLE projects
  ADD CONSTRAINT projects_field_released_by_fkey
  FOREIGN KEY (tenant_id, field_released_by) REFERENCES staff (tenant_id, id);

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_field_release_pair_check;
ALTER TABLE projects
  ADD CONSTRAINT projects_field_release_pair_check CHECK (
    (
      field_released_by IS NULL
      AND field_released_at IS NULL
      AND field_release_note IS NULL
    )
    OR (
      field_released_by IS NOT NULL
      AND field_released_at IS NOT NULL
      AND (field_release_note IS NULL OR char_length(field_release_note) <= 2000)
    )
  );

COMMENT ON COLUMN projects.field_released_by IS
  'Staff member who recorded the current field release. Null means not released. A flag only: it blocks nothing, including scheduling.';
COMMENT ON COLUMN projects.field_released_at IS
  'When the current field release was recorded. Cleared by undo. History keeps the earlier time.';
COMMENT ON COLUMN projects.field_release_note IS
  'Optional note on the current field release. Cleared by undo. History keeps the earlier note.';

CREATE TABLE IF NOT EXISTS field_release_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('release', 'undo')),
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, actor_id) REFERENCES staff (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS field_release_events_project
  ON field_release_events (tenant_id, project_id, occurred_at, id);

ALTER TABLE field_release_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_release_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON field_release_events;
CREATE POLICY tenant_isolation ON field_release_events
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

COMMENT ON TABLE field_release_events IS
  'Append-only history of field release and undo. Undo clears the current release on the project and leaves these rows. Rows leave only when the project itself is deleted.';

CREATE OR REPLACE FUNCTION field_release_events_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = projects, pg_temp
AS $$
BEGIN
  -- A cascading project delete is nested under the project's own trigger.
  -- A direct update or delete is not, and is refused.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'field_release_events is append-only';
END $$;

DROP TRIGGER IF EXISTS field_release_events_append_only ON field_release_events;
CREATE TRIGGER field_release_events_append_only
  BEFORE UPDATE OR DELETE ON field_release_events
  FOR EACH ROW EXECUTE FUNCTION field_release_events_append_only();
