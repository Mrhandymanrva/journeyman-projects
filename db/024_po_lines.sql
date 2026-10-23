-- Purchase order lines.
--
-- A PO used to carry one cost code, one cost type and one amount. Committed
-- cost counted every non-void PO, drafts included, matched on that header.
-- Lines are the commitment now. The header amount is the sum of the lines and
-- is kept there so existing readers of purchase_orders.amount keep working.
-- Header cost_code_id, cost_type and amount are deprecated.
--
-- Deviations from the design sketch, checked against this schema:
--   * Optional foreign keys use ON DELETE SET NULL. Project deletion removes
--     bid recipients before the project row, and a NO ACTION reference from
--     the PO back to the recipient would make that delete fail.
--   * The original-amount lock is a BEFORE UPDATE trigger, not a constraint
--     trigger, so the backfill INSERT of issued POs is allowed. Changing
--     original_amount after issue is not. Change orders move change_amount.
--   * backfill_po_lines() is idempotent. It classifies a supplier-only PO as
--     material only when that PO does not yet have lines, so a later re-run
--     does not undo a deliberate kind change.

SET search_path = projects, public;

DO $$ BEGIN
  CREATE TYPE po_kind AS ENUM ('subcontract', 'material');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS kind po_kind NOT NULL DEFAULT 'subcontract',
  ADD COLUMN IF NOT EXISTS st_job_id bigint,
  ADD COLUMN IF NOT EXISTS st_project_id bigint,
  ADD COLUMN IF NOT EXISTS agreement_document_id uuid REFERENCES vendor_documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agreement_signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_bid_recipient_id uuid REFERENCES bid_recipients(id) ON DELETE SET NULL;

ALTER TABLE purchase_orders ALTER COLUMN cost_code_id DROP NOT NULL;
ALTER TABLE purchase_orders ALTER COLUMN cost_type DROP NOT NULL;

CREATE TABLE IF NOT EXISTS po_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  po_id            uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no          int NOT NULL,
  cost_code_id     uuid NOT NULL REFERENCES cost_codes(id),
  cost_type        cost_type NOT NULL,
  description      text NOT NULL DEFAULT '',
  original_amount  numeric(14,2) NOT NULL CHECK (original_amount >= 0),
  change_amount    numeric(14,2) NOT NULL DEFAULT 0,
  current_amount   numeric(14,2) GENERATED ALWAYS AS (original_amount + change_amount) STORED,
  budget_line_id   uuid REFERENCES budget_lines(id) ON DELETE SET NULL,
  UNIQUE (po_id, line_no),
  CHECK (original_amount + change_amount >= 0)
);

CREATE INDEX IF NOT EXISTS po_lines_po_idx ON po_lines (tenant_id, po_id);

CREATE TABLE IF NOT EXISTS po_line_changes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  po_line_id            uuid NOT NULL REFERENCES po_lines(id) ON DELETE CASCADE,
  change_order_line_id  uuid NOT NULL REFERENCES change_order_lines(id),
  amount                numeric(14,2) NOT NULL,
  applied_at            timestamptz NOT NULL DEFAULT now(),
  applied_by            uuid REFERENCES staff(id),
  UNIQUE (po_line_id, change_order_line_id)
);

CREATE INDEX IF NOT EXISTS po_line_changes_line_idx ON po_line_changes (tenant_id, po_line_id);

ALTER TABLE change_order_lines
  ADD COLUMN IF NOT EXISTS po_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL;

ALTER TABLE po_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON po_lines;
CREATE POLICY tenant_isolation ON po_lines
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

ALTER TABLE po_line_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_line_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON po_line_changes;
CREATE POLICY tenant_isolation ON po_line_changes
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

CREATE OR REPLACE FUNCTION po_lines_rollup() RETURNS trigger AS $$
DECLARE pid uuid;
BEGIN
  pid := COALESCE(NEW.po_id, OLD.po_id);
  UPDATE projects.purchase_orders
     SET amount = COALESCE((SELECT SUM(current_amount) FROM projects.po_lines WHERE po_id = pid), 0)
   WHERE id = pid;
  RETURN NULL;
END $$ LANGUAGE plpgsql SET search_path = projects, pg_temp;

DROP TRIGGER IF EXISTS po_lines_rollup ON po_lines;
CREATE TRIGGER po_lines_rollup
  AFTER INSERT OR UPDATE OR DELETE ON po_lines
  FOR EACH ROW EXECUTE FUNCTION po_lines_rollup();

CREATE OR REPLACE FUNCTION po_line_changes_rollup() RETURNS trigger AS $$
DECLARE lid uuid;
BEGIN
  lid := COALESCE(NEW.po_line_id, OLD.po_line_id);
  UPDATE projects.po_lines
     SET change_amount = COALESCE((SELECT SUM(amount) FROM projects.po_line_changes WHERE po_line_id = lid), 0)
   WHERE id = lid;
  RETURN NULL;
END $$ LANGUAGE plpgsql SET search_path = projects, pg_temp;

DROP TRIGGER IF EXISTS po_line_changes_rollup ON po_line_changes;
CREATE TRIGGER po_line_changes_rollup
  AFTER INSERT OR UPDATE OR DELETE ON po_line_changes
  FOR EACH ROW EXECUTE FUNCTION po_line_changes_rollup();

CREATE OR REPLACE FUNCTION po_lines_original_immutable() RETURNS trigger AS $$
DECLARE st projects.po_status;
BEGIN
  IF NEW.original_amount IS DISTINCT FROM OLD.original_amount THEN
    SELECT status INTO st FROM projects.purchase_orders WHERE id = NEW.po_id;
    IF st IN ('issued', 'partially_billed', 'closed') THEN
      RAISE EXCEPTION 'Issued purchase order lines cannot change original amount; use a change order'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = projects, pg_temp;

DROP TRIGGER IF EXISTS po_lines_original_immutable ON po_lines;
CREATE TRIGGER po_lines_original_immutable
  BEFORE UPDATE OF original_amount ON po_lines
  FOR EACH ROW EXECUTE FUNCTION po_lines_original_immutable();

-- One line per PO that still has a header cost code and no lines. Supplier-only
-- POs (no vendor) are material purchases; everything else stays a subcontract.
CREATE OR REPLACE FUNCTION backfill_po_lines() RETURNS void AS $$
BEGIN
  UPDATE projects.purchase_orders p
     SET kind = 'material'
   WHERE p.vendor_id IS NULL
     AND p.supplier_name IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM projects.po_lines l WHERE l.po_id = p.id);

  INSERT INTO projects.po_lines
    (tenant_id, po_id, line_no, cost_code_id, cost_type, description, original_amount, budget_line_id)
  SELECT p.tenant_id, p.id, 1, p.cost_code_id, p.cost_type, '', p.amount,
         (SELECT bl.id FROM projects.budget_lines bl
           WHERE bl.project_id = p.project_id
             AND bl.cost_code_id = p.cost_code_id
             AND bl.cost_type = p.cost_type
           LIMIT 1)
    FROM projects.purchase_orders p
   WHERE p.cost_code_id IS NOT NULL
     AND p.cost_type IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM projects.po_lines l WHERE l.po_id = p.id);
END $$ LANGUAGE plpgsql SET search_path = projects, pg_temp;

SELECT projects.backfill_po_lines();

-- Committed cost is issued (or later) subcontract lines, plus material POs
-- that actually have an amount. Drafts no longer count. Actual cost is still
-- approved and paid bills on the header cost code until bill lines exist;
-- 026 replaces this view once those lines do.
DROP VIEW IF EXISTS v_budget_exceptions;
DROP VIEW IF EXISTS v_project_margin;
DROP VIEW IF EXISTS v_cost_position;

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
  SELECT SUM(l.current_amount) AS amount
    FROM po_lines l
    JOIN purchase_orders p ON p.id = l.po_id
   WHERE p.project_id = b.project_id
     AND l.cost_code_id = b.cost_code_id
     AND l.cost_type = b.cost_type
     AND p.status IN ('issued', 'partially_billed', 'closed')
     AND (p.kind = 'subcontract' OR (p.kind = 'material' AND p.amount > 0))
) po ON true
LEFT JOIN LATERAL (
  SELECT SUM(vb.amount) AS amount
    FROM vendor_bills vb
    JOIN purchase_orders p2 ON p2.id = vb.po_id
   WHERE p2.project_id = b.project_id
     AND p2.cost_code_id = b.cost_code_id
     AND p2.cost_type = b.cost_type
     AND vb.status IN ('approved', 'paid')
     AND p2.status <> 'void'
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

CREATE VIEW v_budget_exceptions WITH (security_invoker = true) AS
SELECT tenant_id, project_id, cost_code, description, baseline, total_committed, variance,
       ROUND((total_committed - baseline) / NULLIF(baseline,0) * 100, 1) AS pct_over
FROM v_cost_position
WHERE baseline > 0 AND total_committed > baseline * 1.10;
