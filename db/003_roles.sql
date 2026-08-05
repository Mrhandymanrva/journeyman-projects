-- ============================================================================
-- ROLES — run ONCE per database, as a superuser, before the app ever connects.
--
-- This file is the reason a managed Postgres cannot be pointed at this module
-- as-is. Railway, Render, Supabase and friends hand you one connection string,
-- and it belongs to a superuser (or an owner with BYPASSRLS). Connect the
-- application with it and:
--
--   * RLS is silently a no-op. Not degraded — off. FORCE ROW LEVEL SECURITY
--     does not help: force closes the table-OWNER exemption and never the
--     superuser one.
--   * Every isolation test in this repository still passes, because they run
--     against their own correctly-configured role.
--   * Every tenant sees every other tenant's projects, budgets and margins.
--
-- assertDatabaseContract() refuses to boot in that configuration, which is the
-- last line of defence and not a substitute for this file.
--
-- Two roles, deliberately:
--   jp_owner  owns the schema and every object in it. Runs migrations.
--             Never serves a request.
--   jp_app    owns nothing, has no BYPASSRLS, is not a superuser.
--             DATABASE_URL points at this one.
--
-- Passwords are substituted by scripts/provisionRoles.ts rather than written
-- here. Run that instead of running this by hand.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Roles.  :owner_password and :app_password are placeholders.
-- ---------------------------------------------------------------------------
-- CREATE ROLE jp_owner LOGIN PASSWORD :'owner_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB;
-- CREATE ROLE jp_app   LOGIN PASSWORD :'app_password'   NOSUPERUSER NOBYPASSRLS NOCREATEDB;

-- ---------------------------------------------------------------------------
-- 2. Ownership. Applied AFTER 001_schema.sql and 002_seed.sql have run as
--    jp_owner. If they were run as a superuser instead, reassign:
--
--      REASSIGN OWNED BY postgres TO jp_owner;   -- in this database only
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 3. Grants for the application role.
--
--    Note what is NOT granted:
--      * no CREATE on schema projects — the app cannot add or alter a table,
--        so it cannot create one that forgot its RLS policy
--      * no write on entitlements — billing owns that row. The app reads it so
--        a suspended customer can be told why, and can do nothing else with it.
--      * no write on cost_code_library — product content, changed by migration
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA projects TO jp_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA projects TO jp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA projects TO jp_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA projects TO jp_app;

REVOKE INSERT, UPDATE, DELETE ON projects.entitlements      FROM jp_app;
REVOKE INSERT, UPDATE, DELETE ON projects.tenants           FROM jp_app;
REVOKE INSERT, UPDATE, DELETE ON projects.cost_code_library FROM jp_app;

-- Anything a later migration adds is granted the same way without a second
-- deploy step. Without this, a table added in six months is invisible to the
-- application and the failure looks like a missing migration.
ALTER DEFAULT PRIVILEGES FOR ROLE jp_owner IN SCHEMA projects
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE jp_owner IN SCHEMA projects
  GRANT USAGE, SELECT ON SEQUENCES TO jp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE jp_owner IN SCHEMA projects
  GRANT EXECUTE ON FUNCTIONS TO jp_app;

-- ---------------------------------------------------------------------------
-- 4. Take PUBLIC off the schema. Default PostgreSQL grants CREATE and USAGE on
--    `public` to everyone; `projects` should not repeat that.
-- ---------------------------------------------------------------------------
REVOKE ALL ON SCHEMA projects FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 5. Verify. All three must come back the safe answer for jp_app.
--
--   SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'jp_app';
--     -> f, f
--
--   SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'projects' AND c.relkind = 'r'
--      AND pg_get_userbyid(c.relowner) = 'jp_app';
--     -> 0
--
--   SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'projects' AND c.relkind = 'r' AND NOT c.relforcerowsecurity;
--     -> 0
--
-- assertDatabaseContract() runs all three at boot. They are written out here
-- so an operator can check without starting the app.
-- ---------------------------------------------------------------------------
