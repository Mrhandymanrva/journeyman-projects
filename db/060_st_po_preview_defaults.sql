-- ServiceTitan purchase-order preview defaults.
-- Re-applied on every boot. Every statement is idempotent.
-- Nothing in this file calls ServiceTitan.
--
-- Sending lives only in tenant_settings.st_po_sync_enabled and defaults off.
-- PM_ST_PO_SYNC_ENABLED is not read here and must not turn sending on.
--
-- The company defaults for purchase order type, business unit, and inventory
-- location live only on tenant_settings. A runner may set the GUCs
-- pm.st_po_type_id, pm.st_po_business_unit_id, and
-- pm.st_po_inventory_location_id from PM_ST_PO_TYPE_ID,
-- PM_ST_BUSINESS_UNIT_ID, and PM_ST_INVENTORY_LOCATION_ID before this file.
-- seed_st_po_defaults_from_env copies a numeric value into a still-null
-- column once. The next boot does not copy again, so clearing a default in
-- Setup stays cleared. Rows inserted after this migration start seeded and
-- do not inherit those variables.

SET search_path = projects, public;

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS st_po_sync_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS st_po_type_id text,
  ADD COLUMN IF NOT EXISTS st_po_business_unit_id text,
  ADD COLUMN IF NOT EXISTS st_po_inventory_location_id text,
  ADD COLUMN IF NOT EXISTS st_po_defaults_seeded boolean NOT NULL DEFAULT false;

ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_st_po_ids_check;
ALTER TABLE tenant_settings
  ADD CONSTRAINT tenant_settings_st_po_ids_check CHECK (
    (st_po_type_id IS NULL OR st_po_type_id ~ '^[0-9]+$')
    AND (st_po_business_unit_id IS NULL OR st_po_business_unit_id ~ '^[0-9]+$')
    AND (st_po_inventory_location_id IS NULL OR st_po_inventory_location_id ~ '^[0-9]+$')
  );

COMMENT ON COLUMN tenant_settings.st_po_sync_enabled IS
  'Owner switch for Apply / Send to ServiceTitan. Default false. PM_ST_PO_SYNC_ENABLED does not set this and a deploy does not turn it on.';
COMMENT ON COLUMN tenant_settings.st_po_type_id IS
  'Company default ServiceTitan purchase order type id. The only stored default for typeId.';
COMMENT ON COLUMN tenant_settings.st_po_business_unit_id IS
  'Company default ServiceTitan business unit id. The only stored default for businessUnitId. The preview suggests the linked job''s business unit when this is empty.';
COMMENT ON COLUMN tenant_settings.st_po_inventory_location_id IS
  'Company default ServiceTitan inventory location. The only stored default for inventoryLocationId, and the last location saved from the preview or from Setup.';
COMMENT ON COLUMN tenant_settings.st_po_defaults_seeded IS
  'True after the one-time copy from the purchase-order type, business unit, and inventory location environment variables. Those variables are not read again.';

ALTER TABLE po_lines
  ADD COLUMN IF NOT EXISTS st_sku_id text;

ALTER TABLE po_lines DROP CONSTRAINT IF EXISTS po_lines_st_sku_id_check;
ALTER TABLE po_lines
  ADD CONSTRAINT po_lines_st_sku_id_check
  CHECK (st_sku_id IS NULL OR st_sku_id ~ '^[0-9]+$');

COMMENT ON COLUMN po_lines.st_sku_id IS
  'ServiceTitan inventory SKU id chosen for this line. The only place that choice is stored. cost_codes.external_id is read as a fallback for a mapping made before this column and is not written by the preview.';

COMMENT ON COLUMN purchase_orders.st_po_sync_state IS
  'ready: the payload is complete and nothing has been sent. pending: a create was claimed and may have been sent. created: st_po_id is the ServiceTitan purchase order. failed: ServiceTitan rejected the create. blocked: a required field is still empty, so nothing was sent. Sending happens only from Apply / Send to ServiceTitan. No check constraint.';

CREATE OR REPLACE FUNCTION projects.seed_st_po_defaults_from_env()
RETURNS void
LANGUAGE plpgsql
SET search_path = projects, public
AS $$
DECLARE
  type_id text := current_setting('pm.st_po_type_id', true);
  bu_id text := current_setting('pm.st_po_business_unit_id', true);
  loc_id text := current_setting('pm.st_po_inventory_location_id', true);
BEGIN
  -- No sending GUC is read. st_po_sync_enabled is left as stored.
  UPDATE tenant_settings
     SET st_po_type_id = CASE
           WHEN st_po_type_id IS NULL AND coalesce(type_id, '') ~ '^[0-9]+$' THEN type_id
           ELSE st_po_type_id
         END,
         st_po_business_unit_id = CASE
           WHEN st_po_business_unit_id IS NULL AND coalesce(bu_id, '') ~ '^[0-9]+$' THEN bu_id
           ELSE st_po_business_unit_id
         END,
         st_po_inventory_location_id = CASE
           WHEN st_po_inventory_location_id IS NULL AND coalesce(loc_id, '') ~ '^[0-9]+$' THEN loc_id
           ELSE st_po_inventory_location_id
         END,
         st_po_defaults_seeded = true
   WHERE NOT st_po_defaults_seeded;
END;
$$;

SELECT projects.seed_st_po_defaults_from_env();

ALTER TABLE tenant_settings ALTER COLUMN st_po_defaults_seeded SET DEFAULT true;
