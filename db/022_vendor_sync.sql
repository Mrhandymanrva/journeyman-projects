SET search_path=projects,public;
-- Vendors carry a last-change timestamp so a second directory (the owner's Command Center) can sync both ways on
-- "newest wins". The trigger bumps it on any staff edit; a sync that already knows the right time sets it explicitly
-- and the trigger leaves that value alone.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE OR REPLACE FUNCTION vendors_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN NEW.updated_at := greatest(now(), OLD.updated_at + interval '1 millisecond'); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS vendors_touch_updated_at ON vendors;
CREATE TRIGGER vendors_touch_updated_at BEFORE UPDATE ON vendors FOR EACH ROW EXECUTE FUNCTION vendors_touch_updated_at();
-- A document change is a vendor change as far as the other directory is concerned.
CREATE OR REPLACE FUNCTION vendor_documents_touch_vendor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE vendors SET updated_at = greatest(now(), updated_at + interval '1 millisecond') WHERE id = COALESCE(NEW.vendor_id, OLD.vendor_id);
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS vendor_documents_touch_vendor ON vendor_documents;
CREATE TRIGGER vendor_documents_touch_vendor AFTER INSERT OR UPDATE OR DELETE ON vendor_documents FOR EACH ROW EXECUTE FUNCTION vendor_documents_touch_vendor();
