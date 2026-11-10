-- Final project report stored on the existing closeout row.
--
-- One jsonb document per project. Checklist columns are unchanged.
-- The report is internal. Saving it does not email anyone and does not
-- write to ServiceTitan. Pulled figures inside the document are a snapshot.
--
-- Idempotent. Pre-deploy re-runs every db/*.sql file.

SET search_path = projects, public;

ALTER TABLE project_closeout
  ADD COLUMN IF NOT EXISTS summary jsonb,
  ADD COLUMN IF NOT EXISTS summary_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS summary_updated_by uuid,
  ADD COLUMN IF NOT EXISTS summary_finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS summary_finalized_by uuid;

ALTER TABLE project_closeout DROP CONSTRAINT IF EXISTS project_closeout_summary_updated_by_fkey;
ALTER TABLE project_closeout
  ADD CONSTRAINT project_closeout_summary_updated_by_fkey
  FOREIGN KEY (tenant_id, summary_updated_by) REFERENCES staff (tenant_id, id);

ALTER TABLE project_closeout DROP CONSTRAINT IF EXISTS project_closeout_summary_finalized_by_fkey;
ALTER TABLE project_closeout
  ADD CONSTRAINT project_closeout_summary_finalized_by_fkey
  FOREIGN KEY (tenant_id, summary_finalized_by) REFERENCES staff (tenant_id, id);

ALTER TABLE project_closeout DROP CONSTRAINT IF EXISTS project_closeout_summary_draft_check;
ALTER TABLE project_closeout
  ADD CONSTRAINT project_closeout_summary_draft_check CHECK (
    (
      summary IS NULL
      AND summary_updated_at IS NULL
      AND summary_updated_by IS NULL
      AND summary_finalized_at IS NULL
      AND summary_finalized_by IS NULL
    )
    OR (
      summary IS NOT NULL
      AND jsonb_typeof(summary) = 'object'
      AND summary_updated_at IS NOT NULL
      AND summary_updated_by IS NOT NULL
    )
  );

ALTER TABLE project_closeout DROP CONSTRAINT IF EXISTS project_closeout_summary_finalized_pair_check;
ALTER TABLE project_closeout
  ADD CONSTRAINT project_closeout_summary_finalized_pair_check CHECK (
    (summary_finalized_at IS NULL AND summary_finalized_by IS NULL)
    OR (summary_finalized_at IS NOT NULL AND summary_finalized_by IS NOT NULL)
  );

COMMENT ON COLUMN project_closeout.summary IS
  'Final project report, version 1. Pulled figures are frozen in this document when it is saved. The risk register is not updated from here. Nothing here emails the customer or writes to ServiceTitan.';
COMMENT ON COLUMN project_closeout.summary_finalized_at IS
  'When the report was finalized. A finalized report is read-only. This version does not reopen it.';
