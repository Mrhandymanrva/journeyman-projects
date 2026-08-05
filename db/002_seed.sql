-- ============================================================================
-- JOURNEYMAN PROJECTS — shipped cost code library and per-tenant seeding
-- Run AFTER journeyman_projects_schema.sql
--
-- The library is global and has no tenant_id: it is product content, not
-- customer data. seed_cost_codes() copies it into a tenant's own table, after
-- which that tenant edits freely without touching anyone else's list.
-- ============================================================================

SET search_path = projects, public;

CREATE TABLE IF NOT EXISTS cost_code_library (
  code              text PRIMARY KEY,
  division_code     text NOT NULL,
  division_name     text NOT NULL,
  description       text NOT NULL,
  default_cost_type cost_type NOT NULL,
  ledger_account    text NOT NULL,
  sort_order        integer NOT NULL,
  vertical          text NOT NULL DEFAULT 'residential_remodel'
);
COMMENT ON TABLE cost_code_library IS
  'Product content. No RLS: readable by all tenants, writable only by migration. Never referenced by a foreign key from tenant data — cost_codes rows are copies, so a library change never mutates a live project budget.';

INSERT INTO cost_code_library
  (code, division_code, division_name, description, default_cost_type, ledger_account, sort_order)
VALUES
  ('110', '100', 'General Conditions', 'Permits and inspection fees', 'O'::projects.cost_type, '50400 COGS — Other Job Costs', 10),
  ('120', '100', 'General Conditions', 'Dumpster and debris disposal', 'O'::projects.cost_type, '50400 COGS — Other Job Costs', 20),
  ('130', '100', 'General Conditions', 'Equipment and tool rental', 'O'::projects.cost_type, '50400 COGS — Other Job Costs', 30),
  ('140', '100', 'General Conditions', 'Site protection and consumables', 'O'::projects.cost_type, '50400 COGS — Other Job Costs', 40),
  ('150', '100', 'General Conditions', 'Temporary utilities and facilities', 'O'::projects.cost_type, '50400 COGS — Other Job Costs', 50),
  ('160', '100', 'General Conditions', 'Project management labor', 'L'::projects.cost_type, '50100 COGS — Field Labor', 60),
  ('170', '100', 'General Conditions', 'Design, drafting, and engineering', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 70),
  ('180', '100', 'General Conditions', 'Testing — radon, lead, asbestos', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 80),
  ('210', '200', 'Demolition and Preparation', 'Interior demolition — labor', 'L'::projects.cost_type, '50100 COGS — Field Labor', 90),
  ('220', '200', 'Demolition and Preparation', 'Interior demolition — subcontracted', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 100),
  ('230', '200', 'Demolition and Preparation', 'Hazardous material abatement', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 110),
  ('240', '200', 'Demolition and Preparation', 'Shoring and temporary support', 'L'::projects.cost_type, '50100 COGS — Field Labor', 120),
  ('310', '300', 'Structural and Framing', 'Framing labor', 'L'::projects.cost_type, '50100 COGS — Field Labor', 130),
  ('320', '300', 'Structural and Framing', 'Framing materials', 'M'::projects.cost_type, '50200 COGS — Materials', 140),
  ('330', '300', 'Structural and Framing', 'Structural steel and engineered lumber', 'M'::projects.cost_type, '50200 COGS — Materials', 150),
  ('340', '300', 'Structural and Framing', 'Foundation and concrete', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 160),
  ('350', '300', 'Structural and Framing', 'Framing subcontracted', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 170),
  ('410', '400', 'Exterior Envelope', 'Roofing', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 180),
  ('420', '400', 'Exterior Envelope', 'Siding and trim', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 190),
  ('430', '400', 'Exterior Envelope', 'Windows — material', 'M'::projects.cost_type, '50200 COGS — Materials', 200),
  ('440', '400', 'Exterior Envelope', 'Exterior doors — material', 'M'::projects.cost_type, '50200 COGS — Materials', 210),
  ('450', '400', 'Exterior Envelope', 'Window and door installation labor', 'L'::projects.cost_type, '50100 COGS — Field Labor', 220),
  ('460', '400', 'Exterior Envelope', 'Waterproofing and flashing', 'M'::projects.cost_type, '50200 COGS — Materials', 230),
  ('470', '400', 'Exterior Envelope', 'Gutters and drainage', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 240),
  ('510', '500', 'Plumbing', 'Plumbing subcontract — rough', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 250),
  ('520', '500', 'Plumbing', 'Plumbing subcontract — finish', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 260),
  ('530', '500', 'Plumbing', 'Plumbing fixtures — material', 'M'::projects.cost_type, '50200 COGS — Materials', 270),
  ('540', '500', 'Plumbing', 'Water heater and equipment', 'M'::projects.cost_type, '50200 COGS — Materials', 280),
  ('610', '600', 'Electrical', 'Electrical subcontract — rough', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 290),
  ('620', '600', 'Electrical', 'Electrical subcontract — finish', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 300),
  ('630', '600', 'Electrical', 'Light fixtures — material', 'M'::projects.cost_type, '50200 COGS — Materials', 310),
  ('640', '600', 'Electrical', 'Panel and service upgrade', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 320),
  ('650', '600', 'Electrical', 'Low voltage and data', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 330),
  ('710', '700', 'HVAC', 'HVAC subcontract — rough', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 340),
  ('720', '700', 'HVAC', 'HVAC subcontract — finish', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 350),
  ('730', '700', 'HVAC', 'HVAC equipment — material', 'M'::projects.cost_type, '50200 COGS — Materials', 360),
  ('740', '700', 'HVAC', 'Ventilation and exhaust', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 370),
  ('810', '800', 'Insulation and Drywall', 'Insulation', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 380),
  ('820', '800', 'Insulation and Drywall', 'Drywall hang and finish', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 390),
  ('830', '800', 'Insulation and Drywall', 'Drywall materials', 'M'::projects.cost_type, '50200 COGS — Materials', 400),
  ('840', '800', 'Insulation and Drywall', 'Patch and repair labor', 'L'::projects.cost_type, '50100 COGS — Field Labor', 410),
  ('910', '900', 'Interior Carpentry', 'Interior doors — material', 'M'::projects.cost_type, '50200 COGS — Materials', 420),
  ('920', '900', 'Interior Carpentry', 'Trim and millwork — material', 'M'::projects.cost_type, '50200 COGS — Materials', 430),
  ('930', '900', 'Interior Carpentry', 'Carpentry labor', 'L'::projects.cost_type, '50100 COGS — Field Labor', 440),
  ('940', '900', 'Interior Carpentry', 'Carpentry subcontracted', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 450),
  ('950', '900', 'Interior Carpentry', 'Stairs and railings', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 460),
  ('960', '900', 'Interior Carpentry', 'Closet and storage systems', 'M'::projects.cost_type, '50200 COGS — Materials', 470),
  ('1010', '1000', 'Cabinetry and Countertops', 'Cabinetry — material', 'M'::projects.cost_type, '50200 COGS — Materials', 480),
  ('1020', '1000', 'Cabinetry and Countertops', 'Cabinetry installation labor', 'L'::projects.cost_type, '50100 COGS — Field Labor', 490),
  ('1030', '1000', 'Cabinetry and Countertops', 'Countertops — fabricated and installed', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 500),
  ('1040', '1000', 'Cabinetry and Countertops', 'Cabinet hardware', 'M'::projects.cost_type, '50200 COGS — Materials', 510),
  ('1110', '1100', 'Flooring and Tile', 'Tile — material', 'M'::projects.cost_type, '50200 COGS — Materials', 520),
  ('1120', '1100', 'Flooring and Tile', 'Tile setting subcontract', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 530),
  ('1130', '1100', 'Flooring and Tile', 'Hardwood and LVP — material', 'M'::projects.cost_type, '50200 COGS — Materials', 540),
  ('1140', '1100', 'Flooring and Tile', 'Flooring installation labor', 'L'::projects.cost_type, '50100 COGS — Field Labor', 550),
  ('1150', '1100', 'Flooring and Tile', 'Carpet', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 560),
  ('1160', '1100', 'Flooring and Tile', 'Underlayment and prep', 'M'::projects.cost_type, '50200 COGS — Materials', 570),
  ('1210', '1200', 'Painting and Finishes', 'Interior painting subcontract', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 580),
  ('1220', '1200', 'Painting and Finishes', 'Exterior painting subcontract', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 590),
  ('1230', '1200', 'Painting and Finishes', 'Paint and finish materials', 'M'::projects.cost_type, '50200 COGS — Materials', 600),
  ('1240', '1200', 'Painting and Finishes', 'Touch-up labor', 'L'::projects.cost_type, '50100 COGS — Field Labor', 610),
  ('1310', '1300', 'Appliances and Specialties', 'Appliances — material', 'M'::projects.cost_type, '50200 COGS — Materials', 620),
  ('1320', '1300', 'Appliances and Specialties', 'Appliance installation labor', 'L'::projects.cost_type, '50100 COGS — Field Labor', 630),
  ('1330', '1300', 'Appliances and Specialties', 'Bath accessories and mirrors', 'M'::projects.cost_type, '50200 COGS — Materials', 640),
  ('1340', '1300', 'Appliances and Specialties', 'Shower glass and enclosures', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 650),
  ('1410', '1400', 'Punch and Closeout', 'Punch list labor', 'L'::projects.cost_type, '50100 COGS — Field Labor', 660),
  ('1420', '1400', 'Punch and Closeout', 'Punch list materials', 'M'::projects.cost_type, '50200 COGS — Materials', 670),
  ('1430', '1400', 'Punch and Closeout', 'Final clean', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 680),
  ('1440', '1400', 'Punch and Closeout', 'Warranty and callback work', 'L'::projects.cost_type, '50100 COGS — Field Labor', 690),
  ('1450', '1400', 'Punch and Closeout', 'Backcharges recovered from subs', 'S'::projects.cost_type, '50300 COGS — Subcontractors', 700)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed one tenant. Idempotent: re-running adds codes the tenant deleted, so
-- call it once at activation and not on a schedule.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_cost_codes(
  p_tenant   uuid,
  p_vertical text DEFAULT 'residential_remodel'
) RETURNS integer AS $$
DECLARE n integer;
BEGIN
  -- FIX 4: schema-qualified and search_path pinned, as in 001_schema.sql.
  INSERT INTO projects.cost_codes
    (tenant_id, code, division_code, division_name, description,
     default_cost_type, ledger_account, sort_order, active)
  SELECT p_tenant, l.code, l.division_code, l.division_name, l.description,
         l.default_cost_type, l.ledger_account, l.sort_order, true
  FROM projects.cost_code_library l
  WHERE l.vertical = p_vertical
  ON CONFLICT (tenant_id, code) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$ LANGUAGE plpgsql SET search_path = projects, pg_temp;

-- ---------------------------------------------------------------------------
-- Full tenant activation. Wraps the defaults from the main schema plus codes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION activate_tenant_full(
  p_tenant     uuid,
  p_unit_name  text DEFAULT 'Main'
) RETURNS void AS $$
BEGIN
  -- FIX 4: schema-qualified and search_path pinned. Under `search_path=public`
  -- this failed with "function activate_tenant(uuid) does not exist".
  PERFORM projects.activate_tenant(p_tenant);
  PERFORM projects.seed_cost_codes(p_tenant);

  INSERT INTO projects.tenant_settings (tenant_id) VALUES (p_tenant)
    ON CONFLICT DO NOTHING;

  -- FIX 5: dropped `RETURNING id INTO bu`. With ON CONFLICT DO NOTHING the
  -- RETURNING clause yields no row on a re-run, so `bu` was NULL exactly when
  -- someone would reach for it — and nothing read it. A variable that is only
  -- correct on the first call is worse than no variable.
  INSERT INTO projects.business_units (tenant_id, name)
  VALUES (p_tenant, p_unit_name)
  ON CONFLICT (tenant_id, name) DO NOTHING;

  INSERT INTO projects.external_systems (tenant_id, adapter_key, display_name, verify_invoices)
  VALUES (p_tenant, 'manual', 'Manual entry', false)
  ON CONFLICT (tenant_id, adapter_key) DO NOTHING;
END $$ LANGUAGE plpgsql SET search_path = projects, pg_temp;

-- ---------------------------------------------------------------------------
-- Example: activate Maolnich Enterprises with two business units.
--
--   SELECT activate_tenant_full('<tenant-uuid>', 'Richmond');
--   INSERT INTO business_units (tenant_id, name)
--     VALUES ('<tenant-uuid>', 'Hampton-Newport News');
--   UPDATE tenant_settings SET enforce_business_unit_scoping = true
--     WHERE tenant_id = '<tenant-uuid>';
--   INSERT INTO external_systems (tenant_id, adapter_key, display_name, verify_invoices)
--     VALUES ('<tenant-uuid>', 'servicetitan', 'ServiceTitan', true);
-- ---------------------------------------------------------------------------
