-- Recording a revenue-system invoice number on a draw is a human assertion.
-- Setting or changing the number stamps the draw invoiced and clears
-- verification, which is what 001 already did. Clearing the number must undo
-- that stamp, or an approved draw with no number never returns to
-- v_draw_exceptions. A paid draw stays paid.
--
-- The draw has no column for an external invoice id or invoice date, so only
-- the number is stored. Automatic matching of revenue-system invoices to
-- draws is planned and is not built.

SET search_path = projects, public;

CREATE OR REPLACE FUNCTION stamp_external_invoice() RETURNS trigger AS $$
BEGIN
  IF NEW.external_invoice_number IS NOT NULL
     AND OLD.external_invoice_number IS DISTINCT FROM NEW.external_invoice_number THEN
    NEW.external_invoice_recorded_at := now();
    NEW.external_invoice_verified_at := NULL;
    NEW.status := 'invoiced';
  ELSIF NEW.external_invoice_number IS NULL
        AND OLD.external_invoice_number IS NOT NULL THEN
    NEW.external_invoice_recorded_at := NULL;
    NEW.external_invoice_verified_at := NULL;
    -- Do not walk a paid draw backwards. Only the invoiced stamp is undone.
    IF OLD.status = 'invoiced' THEN
      IF OLD.approved_at IS NOT NULL THEN
        NEW.status := 'approved';
      ELSIF OLD.earned_at IS NOT NULL THEN
        NEW.status := 'earned';
      ELSE
        NEW.status := 'scheduled';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = projects, pg_temp;

COMMENT ON FUNCTION stamp_external_invoice() IS
  'Stamps a draw invoiced when its revenue-system invoice number is set or changed, and reverts that stamp when the number is cleared. Automatic matching of revenue-system invoices to draws is planned and is not built.';
