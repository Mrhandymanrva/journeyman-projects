-- Records that the shipped permit-office file has been loaded for a tenant.
--
-- The rows themselves are not inserted here. Provision re-applies every
-- migration on each deploy, so a data load in this file would run again and
-- would put the CSV back on top of later edits. The application boot (and the
-- pre-deploy step) calls the same importer as POST /jurisdictions/import
-- once, then inserts one row here. A later boot sees the row and does not
-- open the file.

SET search_path = projects, public;

CREATE TABLE IF NOT EXISTS permit_office_seed_runs (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  seed_key text NOT NULL,
  offices_created integer NOT NULL,
  offices_updated integer NOT NULL,
  contacts_upserted integer NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seed_key)
);

COMMENT ON TABLE permit_office_seed_runs IS
  'One row per tenant per shipped permit-office file, written only after that load commits. Presence of the row means do not load the file again.';

ALTER TABLE permit_office_seed_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE permit_office_seed_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON permit_office_seed_runs;
CREATE POLICY tenant_isolation ON permit_office_seed_runs
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));
