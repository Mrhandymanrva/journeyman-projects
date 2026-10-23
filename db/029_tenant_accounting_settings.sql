-- Per-tenant QuickBooks expense accounts and the subcontract agreement grace.
--
-- Cost types L/M/S/O can each post to their own QuickBooks expense account.
-- A null mapping means "use the account chosen on that bill", which is the
-- previous behaviour. Suggestions are computed from the stored chart of
-- accounts and are not written by a migration.
--
-- agreement_grace_days defaults to 14: two weeks is long enough to issue a
-- subcontract that is starting while the vendor master agreement is still
-- being signed, and short enough that an unsigned subcontract does not stay
-- issuable. 0 means an agreement is required immediately. The window is
-- measured from purchase_orders.created_at. Rows that already exist receive
-- the migration time, so they begin inside the window on the day this ships.
-- A signed vendor master agreement (or another vendor document) satisfies the
-- issue gate with no warning. A per-PO subcontract is optional.

SET search_path = projects, public;

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS agreement_grace_days integer NOT NULL DEFAULT 14,
  ADD COLUMN IF NOT EXISTS qbo_account_labor text,
  ADD COLUMN IF NOT EXISTS qbo_account_material text,
  ADD COLUMN IF NOT EXISTS qbo_account_subcontract text,
  ADD COLUMN IF NOT EXISTS qbo_account_other text;

ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_agreement_grace_days_check;
ALTER TABLE tenant_settings
  ADD CONSTRAINT tenant_settings_agreement_grace_days_check
  CHECK (agreement_grace_days BETWEEN 0 AND 365);

ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_qbo_accounts_check;
ALTER TABLE tenant_settings
  ADD CONSTRAINT tenant_settings_qbo_accounts_check CHECK (
    (qbo_account_labor IS NULL OR qbo_account_labor ~ '^[0-9]+$')
    AND (qbo_account_material IS NULL OR qbo_account_material ~ '^[0-9]+$')
    AND (qbo_account_subcontract IS NULL OR qbo_account_subcontract ~ '^[0-9]+$')
    AND (qbo_account_other IS NULL OR qbo_account_other ~ '^[0-9]+$')
  );

COMMENT ON COLUMN tenant_settings.agreement_grace_days IS
  'Days after a subcontract purchase order is created during which it may be issued with no signed agreement. Issue is allowed with a warning inside the window and blocked after it. Default 14. A signed vendor master agreement satisfies the gate immediately. 0 requires an agreement at once.';
COMMENT ON COLUMN tenant_settings.qbo_account_labor IS
  'QuickBooks expense account id for cost type L. Null uses the account chosen on the bill.';
COMMENT ON COLUMN tenant_settings.qbo_account_material IS
  'QuickBooks expense account id for cost type M. Null uses the account chosen on the bill.';
COMMENT ON COLUMN tenant_settings.qbo_account_subcontract IS
  'QuickBooks expense account id for cost type S. Null uses the account chosen on the bill.';
COMMENT ON COLUMN tenant_settings.qbo_account_other IS
  'QuickBooks expense account id for cost type O. Null uses the account chosen on the bill.';

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
COMMENT ON COLUMN purchase_orders.created_at IS
  'When the purchase order was created. This is the start of the agreement grace window. Existing rows are stamped with the migration time.';
