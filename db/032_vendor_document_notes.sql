-- Optional note stored with a vendor document at upload time.
-- Additive only: existing rows stay null. Verification columns are untouched.
SET search_path = projects, public;

ALTER TABLE vendor_documents ADD COLUMN IF NOT EXISTS notes text;
