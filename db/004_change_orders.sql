-- ============================================================================
-- CHANGE ORDERS — two additions to schema v2.0
--
-- NEEDS MASON'S SIGN-OFF. This is the first file that adds to the data model
-- rather than correcting it. Both additions are here rather than edited into
-- 001_schema.sql so they can be read, argued with, or dropped in one piece.
--
-- ---------------------------------------------------------------------------
-- 1. change_order_lines
--
-- change_orders.cost_amount is a single number with no cost code on it, so an
-- approved change order's COST has nowhere to go. v_cost_position matches a
-- commitment to a budget line on (cost_code, cost_type); a scalar matches
-- nothing, and the money is absent from the only figure this module produces.
-- That is the same failure already seen with a purchase order raised against a
-- code budgeted under a different type.
--
-- It also makes a sentence the module already says untrue. Editing a budget
-- after the freeze gate returns:
--
--     "The budget was frozen when gate 1 was approved. Changes after the
--      freeze belong on a change order."
--
-- If a change order cannot reach the budget, that is not advice, it is a dead
-- end. Approving a change order is the ONLY sanctioned way to move a frozen
-- baseline, and it needs lines to do it with.
--
-- cost_amount is kept and becomes derived — the sum of the lines — so nothing
-- reading it today breaks.
--
-- ---------------------------------------------------------------------------
-- 2. tenant_settings.change_order_approval_threshold
--
-- README open item 1: "Change order approval threshold — tenant setting or
-- hardcoded default?"
--
-- Implemented as a tenant setting, because every other limit in this schema is
-- one: gate count, which gate freezes the baseline, compliance requirements,
-- warn days, the cost code list. A hardcoded number would be the only thing in
-- the module a customer could not change, and the capability table already
-- distinguishes "send change order" from "approve CO over threshold" — which
-- is meaningless without a threshold to be over.
--
-- Default 5000.00 is a placeholder, not a recommendation. Change it.
-- ============================================================================

SET search_path = projects, public;

CREATE TABLE IF NOT EXISTS change_order_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  change_order_id  uuid NOT NULL REFERENCES change_orders(id) ON DELETE CASCADE,
  cost_code_id     uuid NOT NULL REFERENCES cost_codes(id),
  cost_type        cost_type NOT NULL,
  amount           numeric(14,2) NOT NULL,
  description      text,
  UNIQUE (change_order_id, cost_code_id, cost_type)
);
COMMENT ON TABLE change_order_lines IS
  'The cost side of a change order, by cost code. Unique on (change_order_id, cost_code_id, cost_type) to match budget_lines, so approving a change order can add to the right budget line rather than creating a second one beside it.';
COMMENT ON COLUMN change_order_lines.amount IS
  'Signed. A change order that removes scope carries negative lines, and a credit that cannot be recorded is a credit somebody argues about later.';

CREATE INDEX IF NOT EXISTS change_order_lines_co_idx
  ON change_order_lines (tenant_id, change_order_id);

ALTER TABLE change_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_order_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON change_order_lines;
CREATE POLICY tenant_isolation ON change_order_lines
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS change_order_approval_threshold numeric(14,2) NOT NULL DEFAULT 5000.00;
COMMENT ON COLUMN tenant_settings.change_order_approval_threshold IS
  'Customer amount at or below which a project manager may record approval. Above it, owner or manager only. A tenant setting because every other limit in this schema is one — see 004_change_orders.sql for the reasoning. The default is a placeholder.';
