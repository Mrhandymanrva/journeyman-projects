-- Permit offices stay on jurisdictions. name is the municipality.
-- state is required. Existing rows are Virginia before the NOT NULL.
-- Contacts are one-to-many. The column is title, not role.
-- An import that omits a contact leaves that contact in place.
-- No username, password, token, or secret column.

SET search_path = projects, public;

ALTER TABLE jurisdictions
  ADD COLUMN IF NOT EXISTS state char(2),
  ADD COLUMN IF NOT EXISTS office_name text,
  ADD COLUMN IF NOT EXISTS address_line1 text,
  ADD COLUMN IF NOT EXISTS address_line2 text,
  ADD COLUMN IF NOT EXISTS office_city text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS website_url text,
  ADD COLUMN IF NOT EXISTS work_requiring_permit text,
  ADD COLUMN IF NOT EXISTS required_documents text,
  ADD COLUMN IF NOT EXISTS plan_requirements text,
  ADD COLUMN IF NOT EXISTS fee_notes text,
  ADD COLUMN IF NOT EXISTS fee_schedule_url text,
  ADD COLUMN IF NOT EXISTS inspection_method text,
  ADD COLUMN IF NOT EXISTS inspection_phone text,
  ADD COLUMN IF NOT EXISTS inspection_url text,
  ADD COLUMN IF NOT EXISTS last_verified date;

-- Table owner cannot see a lapsed tenant through FORCE RLS. The fill is
-- idempotent, so turning RLS off for this statement is safe to repeat.
DO $state$
BEGIN
  ALTER TABLE jurisdictions DISABLE ROW LEVEL SECURITY;
  UPDATE jurisdictions SET state = 'VA' WHERE state IS NULL;
  ALTER TABLE jurisdictions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE jurisdictions FORCE ROW LEVEL SECURITY;
END
$state$;

ALTER TABLE jurisdictions ALTER COLUMN state SET NOT NULL;

ALTER TABLE jurisdictions DROP CONSTRAINT IF EXISTS jurisdictions_state_check;
ALTER TABLE jurisdictions
  ADD CONSTRAINT jurisdictions_state_check CHECK (state ~ '^[A-Z]{2}$');

ALTER TABLE jurisdictions DROP CONSTRAINT IF EXISTS jurisdictions_tenant_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS jurisdictions_tenant_lower_name_state
  ON jurisdictions (tenant_id, lower(name), state);

ALTER TABLE jurisdictions DROP CONSTRAINT IF EXISTS jurisdictions_portal_url_check;
ALTER TABLE jurisdictions
  ADD CONSTRAINT jurisdictions_portal_url_check
  CHECK (portal_url IS NULL OR portal_url ~* '^https?://');

ALTER TABLE jurisdictions DROP CONSTRAINT IF EXISTS jurisdictions_website_url_check;
ALTER TABLE jurisdictions
  ADD CONSTRAINT jurisdictions_website_url_check
  CHECK (website_url IS NULL OR website_url ~* '^https?://');

ALTER TABLE jurisdictions DROP CONSTRAINT IF EXISTS jurisdictions_fee_schedule_url_check;
ALTER TABLE jurisdictions
  ADD CONSTRAINT jurisdictions_fee_schedule_url_check
  CHECK (fee_schedule_url IS NULL OR fee_schedule_url ~* '^https?://');

ALTER TABLE jurisdictions DROP CONSTRAINT IF EXISTS jurisdictions_inspection_url_check;
ALTER TABLE jurisdictions
  ADD CONSTRAINT jurisdictions_inspection_url_check
  CHECK (inspection_url IS NULL OR inspection_url ~* '^https?://');

ALTER TABLE jurisdictions DROP CONSTRAINT IF EXISTS jurisdictions_inspection_method_check;
ALTER TABLE jurisdictions
  ADD CONSTRAINT jurisdictions_inspection_method_check
  CHECK (inspection_method IS NULL OR inspection_method IN (
    'phone', 'portal', 'email', 'in_person', 'other'
  ));

ALTER TABLE jurisdictions DROP CONSTRAINT IF EXISTS jurisdictions_review_days_check;
ALTER TABLE jurisdictions
  ADD CONSTRAINT jurisdictions_review_days_check
  CHECK (typical_review_days IS NULL OR typical_review_days >= 0);

COMMENT ON COLUMN jurisdictions.name IS
  'Municipality. Unique with state, case-insensitive.';
COMMENT ON COLUMN jurisdictions.state IS
  'Two-letter state. Existing rows were set to VA before this column became required.';
COMMENT ON COLUMN jurisdictions.office_name IS
  'Building department or permit office name. name stays the municipality.';
COMMENT ON COLUMN jurisdictions.contact_phone IS
  'Main phone for the office. People are rows in jurisdiction_contacts.';
COMMENT ON COLUMN jurisdictions.portal_url IS
  'Public permit portal. Login URL only. Not a place to store a username or password.';

CREATE TABLE IF NOT EXISTS jurisdiction_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  jurisdiction_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  title text CHECK (title IS NULL OR char_length(title) <= 200),
  phone text CHECK (phone IS NULL OR char_length(phone) <= 80),
  email text CHECK (email IS NULL OR char_length(email) <= 200),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, jurisdiction_id) REFERENCES jurisdictions (tenant_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS jurisdiction_contacts_identity
  ON jurisdiction_contacts (jurisdiction_id, lower(name), lower(coalesce(email, '')));

CREATE INDEX IF NOT EXISTS jurisdiction_contacts_office
  ON jurisdiction_contacts (tenant_id, jurisdiction_id, sort_order, id);

COMMENT ON TABLE jurisdiction_contacts IS
  'People at a permit office. One office has any number of contacts. title is the job title, not a staff role. notes is free text. A contact the import file omits stays.';
COMMENT ON COLUMN jurisdiction_contacts.title IS
  'Job title, for example Plan reviewer. Not a staff role.';
COMMENT ON COLUMN jurisdiction_contacts.notes IS
  'Free text, at most 2000 characters. For example: handles residential plan review; call before 10am.';

ALTER TABLE jurisdiction_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE jurisdiction_contacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON jurisdiction_contacts;
CREATE POLICY tenant_isolation ON jurisdiction_contacts
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

DROP TRIGGER IF EXISTS jurisdiction_contacts_touch ON jurisdiction_contacts;
CREATE TRIGGER jurisdiction_contacts_touch
  BEFORE UPDATE ON jurisdiction_contacts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
