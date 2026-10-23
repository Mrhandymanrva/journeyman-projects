-- Bid lines and the purchase order an award creates.
--
-- A bid request can list the cost codes being priced. Each recipient quotes
-- those lines. Award copies the quote onto a draft subcontract. A request
-- with no lines still awards from the single quote_amount and a cost code
-- chosen at award time.
--
-- awarded_po_id uses ON DELETE SET NULL. purchase_orders.source_bid_recipient_id
-- already points back, and project deletion removes one side before the other.

SET search_path = projects, public;

CREATE TABLE IF NOT EXISTS bid_request_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bid_request_id  uuid NOT NULL REFERENCES bid_requests(id) ON DELETE CASCADE,
  line_no         int NOT NULL,
  cost_code_id    uuid NOT NULL REFERENCES cost_codes(id),
  cost_type       cost_type NOT NULL DEFAULT 'S',
  budget_line_id  uuid REFERENCES budget_lines(id) ON DELETE SET NULL,
  description     text NOT NULL DEFAULT '',
  UNIQUE (bid_request_id, line_no)
);

CREATE INDEX IF NOT EXISTS bid_request_lines_request_idx
  ON bid_request_lines (tenant_id, bid_request_id);

CREATE TABLE IF NOT EXISTS bid_quote_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bid_recipient_id     uuid NOT NULL REFERENCES bid_recipients(id) ON DELETE CASCADE,
  bid_request_line_id  uuid NOT NULL REFERENCES bid_request_lines(id) ON DELETE CASCADE,
  amount               numeric(14,2) NOT NULL CHECK (amount >= 0),
  note                 text,
  UNIQUE (bid_recipient_id, bid_request_line_id)
);

CREATE INDEX IF NOT EXISTS bid_quote_lines_recipient_idx
  ON bid_quote_lines (tenant_id, bid_recipient_id);

ALTER TABLE bid_recipients
  ADD COLUMN IF NOT EXISTS awarded_po_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bid_recipients_awarded_po_id_key
  ON bid_recipients (awarded_po_id) WHERE awarded_po_id IS NOT NULL;

ALTER TABLE bid_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bid_request_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bid_request_lines;
CREATE POLICY tenant_isolation ON bid_request_lines
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

ALTER TABLE bid_quote_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bid_quote_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bid_quote_lines;
CREATE POLICY tenant_isolation ON bid_quote_lines
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));
