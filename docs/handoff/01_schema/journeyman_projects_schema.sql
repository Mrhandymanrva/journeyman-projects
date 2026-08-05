-- ============================================================================
-- JOURNEYMAN PROJECTS
-- Licensed module. PostgreSQL schema v2.0 (August 2026)
-- Supersedes tier3_schema.sql, which was single-tenant and ServiceTitan-bound.
--
-- MODULE BOUNDARY RULES — these are load-bearing, not stylistic:
--   1. Everything lives in schema `projects`. No object in this file may be
--      referenced by a foreign key from the estimating core, and nothing here
--      holds a foreign key into it. The estimate arrives as a snapshot payload
--      across a versioned contract (see estimate_imports).
--   2. Every tenant-scoped table carries tenant_id and is protected by RLS.
--      Isolation is enforced by the database, not by remembering a WHERE clause.
--   3. No field service platform is named anywhere in this schema. The system
--      of record for revenue is an adapter (external_system), because a
--      customer may run ServiceTitan, Jobber, Housecall Pro, or nothing.
--   4. Access requires an active entitlement. A tenant without it sees no
--      rows, because the RLS predicate includes the entitlement check.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS projects;
SET search_path = projects, public;

-- ---------------------------------------------------------------------------
-- SESSION CONTRACT — the application MUST do this on every request:
--
--   BEGIN;
--   SET LOCAL app.tenant_id = '<tenant uuid>';
--   ... queries ...
--   COMMIT;
--
-- SET LOCAL, not SET: with a connection pool a plain SET leaks the tenant to
-- the next request that borrows the connection. That is the failure mode that
-- produces a cross-tenant leak with no code that looks wrong.
--
-- The application role must NOT own these tables and must NOT have BYPASSRLS.
-- Verify with: SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user;
--
-- Requires PostgreSQL 15 or later (views use security_invoker).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------- enums ----
CREATE TYPE staff_role       AS ENUM ('owner','manager','project_manager','estimator','office','bookkeeper');
CREATE TYPE project_stage    AS ENUM ('handoff','precon','mobilization','execution','closeout','complete','cancelled');
CREATE TYPE gate_status      AS ENUM ('open','submitted','approved','rejected');
CREATE TYPE cost_type        AS ENUM ('L','M','S','O');
CREATE TYPE po_status        AS ENUM ('draft','issued','partially_billed','closed','void');
CREATE TYPE bill_status      AS ENUM ('received','approved','rejected','paid');
CREATE TYPE co_status        AS ENUM ('draft','sent','approved','rejected','void');
CREATE TYPE draw_status      AS ENUM ('scheduled','earned','approved','invoiced','paid');
CREATE TYPE doc_kind         AS ENUM ('master_agreement','tax_form','license','gl_insurance','wc_insurance','auto_insurance','lien_waiver_conditional','lien_waiver_unconditional','other');
CREATE TYPE milestone_status AS ENUM ('pending','in_progress','complete','not_applicable','failed');
CREATE TYPE sched_status     AS ENUM ('proposed','confirmed','in_progress','complete','cancelled');
CREATE TYPE entitlement_state AS ENUM ('trial','active','past_due','suspended','cancelled');

-- =========================================================== tenancy ========
-- Minimal local projection of platform tenancy. The platform owns the
-- authoritative tenant record; this table exists so RLS has something to join
-- and so the module can be reasoned about in isolation.
CREATE TABLE tenants (
  id           uuid PRIMARY KEY,
  slug         citext UNIQUE NOT NULL,
  display_name text NOT NULL,
  country      char(2) NOT NULL DEFAULT 'US',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entitlements (
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_key     text NOT NULL,               -- 'estimating' | 'projects'
  state          entitlement_state NOT NULL DEFAULT 'trial',
  business_units_licensed integer NOT NULL DEFAULT 1 CHECK (business_units_licensed > 0),
  portal_users_licensed integer,              -- NULL = unlimited. Decision: unlimited.
  active_project_limit  integer,              -- NULL = unlimited. Decision: no limit.
  valid_from     date NOT NULL DEFAULT CURRENT_DATE,
  valid_until    date,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_key)
);
COMMENT ON COLUMN entitlements.business_units_licensed IS
  'The meter. Billing owns this number; Projects only reads it. No usage counters, no rollup job, no billing events — metering is per business unit, matching the estimating base.';
COMMENT ON COLUMN entitlements.portal_users_licensed IS
  'Null by design. Subcontractor portal seats are free and unlimited. Column retained because adding a limit column later to live subscriptions is a migration and a pricing conversation at the same time.';
COMMENT ON TABLE entitlements IS
  'Subscription gate. A tenant without state IN (trial, active) sees zero rows in this schema — enforced by RLS, not by the router alone.';

-- entitlements gets tenant-only isolation, deliberately NOT gated on
-- tenant_enabled(). A suspended tenant must still be able to read their own
-- entitlement row, or the app can only render "no data" instead of "your
-- subscription lapsed on 3 March". Writes belong to the billing service.
ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY entitlement_read ON entitlements
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE FUNCTION current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- The single predicate every RLS policy uses.
-- Projects is not sold standalone: both entitlements must be live.
-- 'past_due' counts as live deliberately — a card that expired mid-project
-- must not hide an active job's permit chain.
CREATE FUNCTION module_live(t uuid, m text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects.entitlements e
    WHERE e.tenant_id = t
      AND e.module_key = m
      AND e.state IN ('trial','active','past_due')
      AND e.valid_from <= CURRENT_DATE
      AND (e.valid_until IS NULL OR e.valid_until >= CURRENT_DATE)
  )
$$;

CREATE FUNCTION tenant_enabled(t uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT t IS NOT NULL
     AND t = current_tenant()
     AND projects.module_live(t, 'estimating')
     AND projects.module_live(t, 'projects')
$$;

-- ------------------------------------------------------ business units -----
-- The billing meter and the operational boundary. A single-location customer
-- gets one and never thinks about it.
CREATE TABLE business_units (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  code       text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enforce_business_unit_scoping boolean NOT NULL DEFAULT false,
  portal_user_soft_alert_at integer DEFAULT 75,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN tenant_settings.enforce_business_unit_scoping IS
  'When true, staff see only projects in their own business unit. Enforced in the API, not in RLS: this is a visibility preference within one tenant, not a security boundary between tenants, and putting it in RLS makes cross-unit reporting for an owner needlessly hard.';
COMMENT ON COLUMN tenant_settings.portal_user_soft_alert_at IS
  'Portal seats are unlimited and free. This is a signal, not a limit — unusual growth means either abuse or a customer becoming expensive to serve.';

-- ============================================ external system adapter =======
-- No field service platform is named in a column. A tenant registers whichever
-- system holds their customers and revenue; the module stores opaque IDs.
CREATE TABLE external_systems (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  adapter_key   text NOT NULL,                 -- 'servicetitan' | 'jobber' | 'housecall' | 'manual'
  display_name  text NOT NULL,
  is_revenue_system_of_record boolean NOT NULL DEFAULT true,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- credentials live in the platform vault, not here
  verify_invoices boolean NOT NULL DEFAULT false,     -- adapter supports invoice lookback
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, adapter_key)
);
COMMENT ON COLUMN external_systems.verify_invoices IS
  'When true, a recorded external invoice number can be checked against the source system. When false the number is recorded on trust — still a control, just an unverified one.';

-- ============================================ estimate import contract ======
-- The ONLY link to the estimating core. A snapshot, versioned, immutable.
-- No foreign key. If estimating is not licensed, projects still works.
CREATE TABLE estimate_imports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_version text NOT NULL,              -- 'estimate.v1'
  source_key     text NOT NULL,                -- opaque id from whatever produced it
  source_kind    text NOT NULL,                -- 'journeyman_estimate' | 'external' | 'manual'
                                               -- 'manual' survives decision 1: a new customer
                                               -- onboarding with jobs already 60% built cannot
                                               -- retroactively estimate them.
  payload        jsonb NOT NULL,               -- line items, quantities, scope text, sold price
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_kind, source_key, contract_version)
);
COMMENT ON TABLE estimate_imports IS
  'Integration boundary with the estimating module. Snapshot in, never a join. Changing the estimating data model must not require a migration here — that is the whole point.';

-- ---------------------------------------------------------------- staff ----
CREATE TABLE staff (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform_user_id uuid,                        -- projection of the platform identity
  email      citext NOT NULL,
  full_name  text NOT NULL,
  role       staff_role NOT NULL,
  business_unit_id uuid REFERENCES business_units(id),   -- NULL = sees all units
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- ------------------------------------------------------------ cost codes ---
-- Tenant-owned. A shipped default library is seeded per tenant at activation,
-- then edited freely. No shared global list — one customer's edits must never
-- appear in another's console.
CREATE TABLE cost_codes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code              text NOT NULL,
  division_code     text NOT NULL,
  division_name     text NOT NULL,
  description       text NOT NULL,
  default_cost_type cost_type NOT NULL,
  ledger_account    text,                       -- free text label; module never posts to a ledger
  sort_order        integer NOT NULL DEFAULT 0,
  active            boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

-- ------------------------------------------------------------- vendors -----
CREATE TABLE vendors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  legal_name      text NOT NULL,
  dba_name        text,
  primary_contact text,
  email           citext NOT NULL,
  phone           text,
  address         text,
  trades          text[] NOT NULL DEFAULT '{}',
  license_number  text,
  license_class   text,
  license_authority text,                       -- 'VA DPOR', 'TX TDLR', etc. Not hardcoded.
  service_area    text,
  active          boolean NOT NULL DEFAULT false,
  onboarded_at    timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE vendor_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_id     uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  kind          doc_kind NOT NULL,
  issued_on     date,
  expires_on    date,
  file_key      text,                            -- object store key; never a public URL
  verified_by   uuid REFERENCES staff(id),
  verified_at   timestamptz,
  verify_method text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_documents_vendor_idx ON vendor_documents (tenant_id, vendor_id, kind);
CREATE INDEX vendor_documents_expiry_idx ON vendor_documents (tenant_id, expires_on) WHERE expires_on IS NOT NULL;

-- Per-tenant, because compliance requirements vary by state and by appetite.
CREATE TABLE compliance_requirements (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind      doc_kind NOT NULL,
  required  boolean NOT NULL DEFAULT true,
  warn_days integer NOT NULL DEFAULT 30,
  blocks_scheduling boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, kind)
);

-- ------------------------------------------------------------ projects -----
CREATE TABLE projects (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_number     text NOT NULL,
  business_unit_id   uuid REFERENCES business_units(id),
  external_system_id uuid REFERENCES external_systems(id),
  external_job_id    text,                       -- was st_job_id
  external_customer_id text,
  estimate_import_id uuid REFERENCES estimate_imports(id),
  name               text NOT NULL,
  address_line1      text NOT NULL,
  city               text NOT NULL,
  region             text NOT NULL,               -- state/province, not US-specific
  postal_code        text,
  jurisdiction_id    uuid,
  pm_id              uuid REFERENCES staff(id),
  estimator_id       uuid REFERENCES staff(id),
  contract_value     numeric(14,2) NOT NULL CHECK (contract_value > 0),
  currency           char(3) NOT NULL DEFAULT 'USD',
  target_margin      numeric(5,4) NOT NULL CHECK (target_margin BETWEEN 0 AND 1),
  stage              project_stage NOT NULL DEFAULT 'handoff',
  scheduled_start    date,
  scheduled_end      date,
  actual_start       date,
  actual_end         date,
  license_scope_note text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_number)
);
CREATE UNIQUE INDEX projects_external_job_uq
  ON projects (tenant_id, external_system_id, external_job_id)
  WHERE external_job_id IS NOT NULL;
COMMENT ON COLUMN projects.external_job_id IS
  'Join key to the tenant''s revenue system of record. Nullable, because a tenant may run this module standalone with no field service platform — in which case invoicing is tracked here as reference only and reconciliation is manual.';

-- ------------------------------------------------------------ gates --------
CREATE TABLE gate_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  gate_number smallint NOT NULL CHECK (gate_number BETWEEN 0 AND 9),
  title       text NOT NULL,
  approver_role staff_role NOT NULL,
  checklist   jsonb NOT NULL DEFAULT '[]'::jsonb,
  freezes_baseline boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, gate_number)
);
COMMENT ON TABLE gate_templates IS
  'Gate count and content are tenant configuration. Five gates is the shipped default, not a constraint.';

CREATE TABLE stage_gates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  gate_number   smallint NOT NULL,
  title         text NOT NULL,
  status        gate_status NOT NULL DEFAULT 'open',
  checklist     jsonb NOT NULL DEFAULT '[]'::jsonb,
  approved_by   uuid REFERENCES staff(id),
  approved_at   timestamptz,
  rejected_note text,
  UNIQUE (project_id, gate_number)
);

-- ------------------------------------------------------------ budget -------
CREATE TABLE budget_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cost_code_id    uuid NOT NULL REFERENCES cost_codes(id),
  cost_type       cost_type NOT NULL,
  budget_amount   numeric(14,2) NOT NULL DEFAULT 0 CHECK (budget_amount >= 0),
  baseline_amount numeric(14,2),
  note            text,
  UNIQUE (project_id, cost_code_id, cost_type)
);

-- ------------------------------------------------------- purchase orders ---
CREATE TABLE purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  po_number     text NOT NULL,
  vendor_id     uuid REFERENCES vendors(id),
  supplier_name text,
  cost_code_id  uuid NOT NULL REFERENCES cost_codes(id),
  cost_type     cost_type NOT NULL,
  amount        numeric(14,2) NOT NULL CHECK (amount >= 0),
  scope_text    text NOT NULL,
  exclusions    text,
  window_start  date,
  window_end    date,
  status        po_status NOT NULL DEFAULT 'draft',
  issued_by     uuid REFERENCES staff(id),
  issued_at     timestamptz,
  UNIQUE (tenant_id, po_number),
  CHECK (vendor_id IS NOT NULL OR supplier_name IS NOT NULL)
);
CREATE INDEX po_project_idx ON purchase_orders (tenant_id, project_id, cost_code_id);

CREATE TABLE vendor_bills (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  po_id                 uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  vendor_invoice_number text NOT NULL,
  amount                numeric(14,2) NOT NULL CHECK (amount >= 0),
  received_at           timestamptz NOT NULL DEFAULT now(),
  status                bill_status NOT NULL DEFAULT 'received',
  approved_by           uuid REFERENCES staff(id),
  approved_at           timestamptz,
  paid_at               timestamptz,
  retention_held        numeric(14,2) NOT NULL DEFAULT 0,
  file_key              text,
  exported_at           timestamptz,              -- CSV handoff to accounting; module never posts
  UNIQUE (po_id, vendor_invoice_number)
);

-- ------------------------------------------------------- change orders -----
CREATE TABLE change_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id           uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  co_number            integer NOT NULL,
  description          text NOT NULL,
  customer_amount      numeric(14,2) NOT NULL,
  cost_amount          numeric(14,2) NOT NULL DEFAULT 0,
  schedule_impact_days integer NOT NULL DEFAULT 0,
  status               co_status NOT NULL DEFAULT 'draft',
  sent_at              timestamptz,
  customer_approved_at timestamptz,
  approved_by          uuid REFERENCES staff(id),
  external_estimate_ref text,
  UNIQUE (project_id, co_number)
);

-- ------------------------------------------------------------ draws --------
CREATE TABLE draws (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence_number       smallint NOT NULL,
  label                 text NOT NULL,
  trigger_milestone     text NOT NULL,
  amount                numeric(14,2) NOT NULL CHECK (amount > 0),
  status                draw_status NOT NULL DEFAULT 'scheduled',
  earned_at             timestamptz,
  approved_by           uuid REFERENCES staff(id),
  approved_at           timestamptz,
  external_invoice_number text,                   -- was st_invoice_number
  external_invoice_recorded_at timestamptz,
  external_invoice_recorded_by uuid REFERENCES staff(id),
  external_invoice_verified_at timestamptz,       -- set only when the adapter confirmed it
  UNIQUE (project_id, sequence_number)
);
COMMENT ON COLUMN draws.external_invoice_number IS
  'Invoice number in the tenant''s revenue system of record. Deliberately nullable — the gap between approval and invoicing is the exception this module exists to surface.';

-- ---------------------------------------------------------- permitting -----
CREATE TABLE jurisdictions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  portal_url             text,
  contact_phone          text,
  typical_review_days    integer,
  inspection_cutoff_time time,
  notes                  text,
  UNIQUE (tenant_id, name)
);
ALTER TABLE projects
  ADD CONSTRAINT projects_jurisdiction_fk FOREIGN KEY (jurisdiction_id) REFERENCES jurisdictions(id);

CREATE TABLE permits (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  jurisdiction_id     uuid NOT NULL REFERENCES jurisdictions(id),
  permit_type         text NOT NULL,
  permit_number       text,
  pulled_by_vendor_id uuid REFERENCES vendors(id),
  applied_on          date,
  issued_on           date,
  fee_amount          numeric(12,2),
  not_required        boolean NOT NULL DEFAULT false,
  not_required_reason text,
  CHECK (NOT not_required OR not_required_reason IS NOT NULL)
);

CREATE TABLE permit_milestone_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_number smallint NOT NULL,
  name            text NOT NULL,
  owner_role      staff_role NOT NULL,
  offset_days     integer,
  UNIQUE (tenant_id, sequence_number)
);

CREATE TABLE permit_milestones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  permit_id       uuid NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
  sequence_number smallint NOT NULL,
  name            text NOT NULL,
  owner_role      staff_role NOT NULL,
  due_on          date,
  status          milestone_status NOT NULL DEFAULT 'pending',
  completed_at    timestamptz,
  completed_by    uuid REFERENCES staff(id),
  note            text,
  UNIQUE (permit_id, sequence_number)
);
CREATE INDEX permit_milestones_due_idx
  ON permit_milestones (tenant_id, due_on) WHERE status IN ('pending','in_progress');

-- ------------------------------------------------------------ schedule -----
CREATE TABLE schedule_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title               text NOT NULL,
  cost_code_id        uuid REFERENCES cost_codes(id),
  vendor_id           uuid REFERENCES vendors(id),
  staff_id            uuid REFERENCES staff(id),
  window_start        date NOT NULL,
  window_end          date NOT NULL,
  status              sched_status NOT NULL DEFAULT 'proposed',
  confirmed_at        timestamptz,
  confirmed_by_portal boolean NOT NULL DEFAULT false,
  depends_on          uuid REFERENCES schedule_items(id),
  CHECK (window_end >= window_start)
);
CREATE INDEX schedule_project_idx ON schedule_items (tenant_id, project_id, window_start);
CREATE INDEX schedule_vendor_idx  ON schedule_items (tenant_id, vendor_id, window_start);

-- ---------------------------------------------------------- daily logs -----
CREATE TABLE daily_logs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  log_date           date NOT NULL,
  author_id          uuid NOT NULL REFERENCES staff(id),
  crew_on_site       text,
  vendors_on_site    uuid[] NOT NULL DEFAULT '{}',
  work_completed     text,
  delays             text,
  delay_cause        text,
  deliveries         text,
  inspections        text,
  client_interaction text,
  safety_note        text,
  weather            text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, log_date)
);

-- ------------------------------------------------- vendor portal access ----
CREATE TABLE vendor_portal_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_id     uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  email         citext NOT NULL,
  full_name     text,
  password_hash text,
  invited_at    timestamptz,
  activated_at  timestamptz,
  last_login_at timestamptz,
  disabled      boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, email)
);
COMMENT ON TABLE vendor_portal_users IS
  'Separate identity domain from staff and from the platform user table. A portal session must never resolve to a staff session under any code path. Enforced at the router and tested in CI.';

-- ------------------------------------------------------ scoring / audit ----
CREATE TABLE vendor_scores (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_id          uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  schedule_score     smallint CHECK (schedule_score BETWEEN 1 AND 5),
  quality_score      smallint CHECK (quality_score BETWEEN 1 AND 5),
  change_order_score smallint CHECK (change_order_score BETWEEN 1 AND 5),
  conduct_score      smallint CHECK (conduct_score BETWEEN 1 AND 5),
  note               text,
  scored_by          uuid REFERENCES staff(id),
  scored_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, project_id)
);

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_type   text NOT NULL,                     -- 'staff' | 'vendor' | 'system'
  actor_id     uuid,
  entity_table text NOT NULL,
  entity_id    uuid NOT NULL,
  action       text NOT NULL,
  before_data  jsonb,
  after_data   jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_log (tenant_id, entity_table, entity_id, occurred_at DESC);

-- ============================================================================
-- ROW LEVEL SECURITY
-- Applied to every tenant-scoped table with one predicate. Isolation and
-- entitlement are the same check, so a lapsed subscription reads as an empty
-- database rather than as a feature flag someone forgot.
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'business_units','external_systems','estimate_imports','staff','cost_codes','vendors',
    'vendor_documents','compliance_requirements','projects','gate_templates',
    'stage_gates','budget_lines','purchase_orders','vendor_bills','change_orders',
    'draws','jurisdictions','permits','permit_milestone_templates','permit_milestones',
    'schedule_items','daily_logs','vendor_portal_users','vendor_scores','audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE projects.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE projects.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON projects.%I
        USING (projects.tenant_enabled(tenant_id))
        WITH CHECK (projects.tenant_enabled(tenant_id))
    $f$, t);
  END LOOP;
END $$;

-- tenant_settings follows the same rule as entitlements: readable by its own
-- tenant regardless of entitlement state, so the app can render a real
-- explanation instead of an empty screen.
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_settings_isolation ON tenant_settings
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ============================================================================
-- VIEWS — the reporting surface. RLS on the base tables carries through.
-- ============================================================================
CREATE VIEW v_cost_position WITH (security_invoker = true) AS
SELECT
  b.tenant_id, b.project_id, cc.code AS cost_code, cc.description, b.cost_type,
  COALESCE(b.baseline_amount, b.budget_amount)                   AS baseline,
  b.budget_amount,
  COALESCE(billed.amount, 0)                                     AS actual_cost,
  GREATEST(COALESCE(po.amount,0) - COALESCE(billed.amount,0), 0) AS committed_open,
  COALESCE(billed.amount,0)
    + GREATEST(COALESCE(po.amount,0) - COALESCE(billed.amount,0), 0) AS total_committed,
  COALESCE(b.baseline_amount, b.budget_amount)
    - (COALESCE(billed.amount,0)
       + GREATEST(COALESCE(po.amount,0) - COALESCE(billed.amount,0), 0)) AS variance
FROM budget_lines b
JOIN cost_codes cc ON cc.id = b.cost_code_id
LEFT JOIN LATERAL (
  SELECT SUM(p.amount) AS amount FROM purchase_orders p
  WHERE p.project_id = b.project_id AND p.cost_code_id = b.cost_code_id
    AND p.cost_type = b.cost_type AND p.status <> 'void'
) po ON true
LEFT JOIN LATERAL (
  SELECT SUM(vb.amount) AS amount FROM vendor_bills vb
  JOIN purchase_orders p2 ON p2.id = vb.po_id
  WHERE p2.project_id = b.project_id AND p2.cost_code_id = b.cost_code_id
    AND p2.cost_type = b.cost_type AND vb.status IN ('approved','paid')
) billed ON true;

CREATE VIEW v_project_margin WITH (security_invoker = true) AS
SELECT
  p.tenant_id, p.id AS project_id, p.project_number, p.name, p.currency,
  p.contract_value
    + COALESCE((SELECT SUM(co.customer_amount) FROM change_orders co
                WHERE co.project_id = p.id AND co.status = 'approved'), 0) AS revised_contract,
  p.target_margin,
  SUM(v.total_committed)                                                    AS committed_cost,
  SUM(GREATEST(v.baseline - v.total_committed, 0))                          AS unspent_baseline,
  SUM(v.total_committed) + SUM(GREATEST(v.baseline - v.total_committed, 0)) AS projected_cost
FROM projects p
JOIN v_cost_position v ON v.project_id = p.id
GROUP BY p.tenant_id, p.id;

CREATE VIEW v_vendor_compliance WITH (security_invoker = true) AS
SELECT
  v.tenant_id, v.id AS vendor_id, v.legal_name, r.kind, r.blocks_scheduling, d.expires_on,
  CASE
    WHEN d.id IS NULL                THEN 'missing'
    WHEN d.expires_on IS NULL        THEN 'valid'
    WHEN d.expires_on < CURRENT_DATE THEN 'expired'
    WHEN d.expires_on < CURRENT_DATE + (r.warn_days||' days')::interval THEN 'expiring'
    ELSE 'valid'
  END AS state
FROM vendors v
JOIN compliance_requirements r ON r.tenant_id = v.tenant_id AND r.required
LEFT JOIN LATERAL (
  SELECT * FROM vendor_documents vd
  WHERE vd.vendor_id = v.id AND vd.kind = r.kind
  ORDER BY vd.expires_on DESC NULLS LAST LIMIT 1
) d ON true;

CREATE VIEW v_vendor_eligibility WITH (security_invoker = true) AS
SELECT
  tenant_id, vendor_id, legal_name,
  bool_and(CASE WHEN blocks_scheduling THEN state IN ('valid','expiring') ELSE true END) AS schedulable,
  count(*) FILTER (WHERE state = 'expired')  AS expired_count,
  count(*) FILTER (WHERE state = 'missing')  AS missing_count,
  count(*) FILTER (WHERE state = 'expiring') AS expiring_count,
  min(expires_on) FILTER (WHERE expires_on IS NOT NULL) AS next_expiry
FROM v_vendor_compliance
GROUP BY tenant_id, vendor_id, legal_name;

CREATE VIEW v_draw_exceptions WITH (security_invoker = true) AS
SELECT d.tenant_id, d.id AS draw_id, d.project_id, p.project_number, p.name AS project_name,
       d.label, d.amount, d.approved_at,
       EXTRACT(day FROM now() - d.approved_at)::int AS days_since_approval
FROM draws d JOIN projects p ON p.id = d.project_id
WHERE d.status = 'approved' AND d.external_invoice_number IS NULL;

CREATE VIEW v_permit_exceptions WITH (security_invoker = true) AS
SELECT pm.tenant_id, pm.id, pr.project_id, p.project_number, j.name AS jurisdiction,
       pm.name AS milestone, pm.due_on, (CURRENT_DATE - pm.due_on) AS days_overdue
FROM permit_milestones pm
JOIN permits pr      ON pr.id = pm.permit_id
JOIN projects p      ON p.id  = pr.project_id
JOIN jurisdictions j ON j.id  = pr.jurisdiction_id
WHERE pm.status IN ('pending','in_progress')
  AND pm.due_on IS NOT NULL AND pm.due_on < CURRENT_DATE;

CREATE VIEW v_budget_exceptions WITH (security_invoker = true) AS
SELECT tenant_id, project_id, cost_code, description, baseline, total_committed, variance,
       ROUND((total_committed - baseline) / NULLIF(baseline,0) * 100, 1) AS pct_over
FROM v_cost_position
WHERE baseline > 0 AND total_committed > baseline * 1.10;

CREATE VIEW v_missing_daily_logs WITH (security_invoker = true) AS
SELECT p.tenant_id, p.id AS project_id, p.project_number, p.name, p.pm_id
FROM projects p
WHERE p.stage = 'execution'
  AND NOT EXISTS (SELECT 1 FROM daily_logs dl
                  WHERE dl.project_id = p.id AND dl.log_date = CURRENT_DATE - 1);

-- ============================================================================
-- TRIGGERS
-- ============================================================================
CREATE FUNCTION enforce_vendor_eligibility() RETURNS trigger AS $$
DECLARE ok boolean;
BEGIN
  -- 'proposed' is allowed: a PM may pencil a vendor in while a renewal is in flight.
  -- Confirmation onward is blocked, which is what actually puts them on site.
  IF NEW.vendor_id IS NULL OR NEW.status IN ('proposed','cancelled') THEN
    RETURN NEW;
  END IF;
  SELECT schedulable INTO ok FROM v_vendor_eligibility WHERE vendor_id = NEW.vendor_id;
  IF ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Vendor % cannot be scheduled: required compliance document missing or expired', NEW.vendor_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER schedule_items_vendor_eligibility
  BEFORE INSERT OR UPDATE OF vendor_id, status ON schedule_items
  FOR EACH ROW EXECUTE FUNCTION enforce_vendor_eligibility();

CREATE FUNCTION freeze_baseline() RETURNS trigger AS $$
DECLARE is_freeze_gate boolean;
BEGIN
  -- Which gate freezes the baseline is tenant configuration.
  SELECT gt.freezes_baseline INTO is_freeze_gate
  FROM gate_templates gt
  WHERE gt.tenant_id = NEW.tenant_id AND gt.gate_number = NEW.gate_number;

  IF COALESCE(is_freeze_gate, false) AND NEW.status = 'approved'
     AND OLD.status IS DISTINCT FROM 'approved' THEN
    UPDATE budget_lines SET baseline_amount = budget_amount
     WHERE project_id = NEW.project_id AND baseline_amount IS NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER stage_gates_freeze_baseline
  AFTER UPDATE OF status ON stage_gates
  FOR EACH ROW EXECUTE FUNCTION freeze_baseline();

CREATE FUNCTION stamp_external_invoice() RETURNS trigger AS $$
BEGIN
  IF NEW.external_invoice_number IS NOT NULL
     AND OLD.external_invoice_number IS DISTINCT FROM NEW.external_invoice_number THEN
    NEW.external_invoice_recorded_at := now();
    NEW.external_invoice_verified_at := NULL;   -- re-verification required
    NEW.status := 'invoiced';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER draws_stamp_external_invoice
  BEFORE UPDATE OF external_invoice_number ON draws
  FOR EACH ROW EXECUTE FUNCTION stamp_external_invoice();

CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$ LANGUAGE plpgsql;

CREATE TRIGGER projects_touch BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ============================================================================
-- ACTIVATION
-- Called when a tenant's entitlement first becomes active. Seeds the shipped
-- defaults into tenant-owned tables so every customer starts configured and
-- can then diverge without affecting anyone else.
-- ============================================================================
CREATE FUNCTION activate_tenant(p_tenant uuid) RETURNS void AS $$
BEGIN
  INSERT INTO compliance_requirements (tenant_id, kind, required)
  VALUES (p_tenant,'master_agreement',true),(p_tenant,'tax_form',true),
         (p_tenant,'license',true),(p_tenant,'gl_insurance',true),
         (p_tenant,'wc_insurance',true),(p_tenant,'auto_insurance',true)
  ON CONFLICT DO NOTHING;

  INSERT INTO gate_templates (tenant_id, gate_number, title, approver_role, freezes_baseline) VALUES
    (p_tenant,0,'Qualification and handoff','manager',false),
    (p_tenant,1,'Preconstruction','manager',true),
    (p_tenant,2,'Mobilization','project_manager',false),
    (p_tenant,3,'Substantial completion','manager',false),
    (p_tenant,4,'Closeout','manager',false)
  ON CONFLICT DO NOTHING;

  INSERT INTO permit_milestone_templates (tenant_id, sequence_number, name, owner_role, offset_days) VALUES
    (p_tenant,1,'Permit requirement determined','project_manager',-10),
    (p_tenant,2,'Application prepared and submitted','office',-7),
    (p_tenant,3,'Plan review comments addressed','project_manager',NULL),
    (p_tenant,4,'Permit issued and fee paid','office',NULL),
    (p_tenant,5,'Permit posted on site','project_manager',NULL),
    (p_tenant,6,'Trade sub permits confirmed pulled','project_manager',NULL),
    (p_tenant,7,'Rough-in inspection scheduled','project_manager',NULL),
    (p_tenant,8,'Rough-in inspection passed','project_manager',NULL),
    (p_tenant,9,'Framing or insulation inspection','project_manager',NULL),
    (p_tenant,10,'Final inspection scheduled','project_manager',NULL),
    (p_tenant,11,'Final inspection passed','project_manager',NULL),
    (p_tenant,12,'Completion certificate filed','office',NULL)
  ON CONFLICT DO NOTHING;
END $$ LANGUAGE plpgsql;

-- Cost codes are seeded per tenant from the shipped library by the application
-- at activation, so that a tenant's later edits never touch another tenant's list.
