-- ============================================================================
-- PROJECT INVOICES — the document the customer actually receives
--
-- Mason, August 2026: "the app's consolidated draw invoice is what the customer
-- receives and the ST tech invoices are the underlying detail."
--
-- That settles a distinction the module had been blurring, and corrects
-- something 006 got wrong. There are two different things:
--
--   BILLING   what the customer was asked to pay, and when. One document per
--             draw, or per approved change order, issued by this module and
--             numbered by it. This table.
--
--   DETAIL    the technician invoices generated in the revenue system that
--             evidence the work behind a draw. external_invoices and
--             draw_invoice_applications, added in 006.
--
-- 006 let applying DETAIL flip a draw to 'invoiced' and drive the statement's
-- invoiced_to_date. Under the reading at the time — that ST invoices were the
-- customer's bill — that was right. It is wrong now: matching nine technician
-- visits to a milestone says the work is evidenced, not that anybody has been
-- asked for money. A draw is invoiced when an invoice for it exists here.
--
-- Numbering is per project rather than a tenant-wide counter. A tenant-wide
-- sequence needs locking to stay gapless, and a gap in a customer-facing
-- invoice number is a question somebody has to answer. Per project the number
-- is short, self-describing, and cannot collide.
-- ============================================================================

SET search_path = projects, public;

CREATE TYPE project_invoice_status AS ENUM ('draft','issued','sent','paid','void');

CREATE TABLE IF NOT EXISTS project_invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  invoice_number    text NOT NULL,
  sequence_number   integer NOT NULL,

  -- Exactly one source. A draw, or an approved change order — change orders
  -- are invoiced separately from the draw schedule but appear on the same
  -- statement.
  draw_id           uuid REFERENCES draws(id) ON DELETE RESTRICT,
  change_order_id   uuid REFERENCES change_orders(id) ON DELETE RESTRICT,

  amount            numeric(14,2) NOT NULL CHECK (amount <> 0),
  description       text NOT NULL,
  issued_on         date NOT NULL DEFAULT CURRENT_DATE,
  due_on            date,
  status            project_invoice_status NOT NULL DEFAULT 'issued',
  sent_at           timestamptz,
  paid_on           date,

  -- Set once this invoice has been recorded in the revenue system. Nullable
  -- for the same reason draws.external_invoice_number was: the gap between
  -- issuing and recording is an exception worth surfacing, not an error.
  external_ref      text,
  external_recorded_at timestamptz,

  issued_by         uuid REFERENCES staff(id),
  note              text,

  UNIQUE (tenant_id, invoice_number),
  UNIQUE (project_id, sequence_number),
  CONSTRAINT project_invoices_one_source CHECK (
    (draw_id IS NOT NULL AND change_order_id IS NULL) OR
    (draw_id IS NULL AND change_order_id IS NOT NULL)
  )
);
COMMENT ON TABLE project_invoices IS
  'The consolidated document the customer receives. Billing, as distinct from the technician invoices in external_invoices that evidence the work — see the header of this file.';
COMMENT ON COLUMN project_invoices.external_ref IS
  'This invoice''s number in the revenue system, once recorded there. Null means issued to the customer but not yet in the books, which is an exception rather than an error.';

-- One live invoice per draw and per change order. A void one does not count,
-- so a mistake can be voided and reissued, which is how invoicing actually
-- works.
CREATE UNIQUE INDEX IF NOT EXISTS project_invoices_draw_uq
  ON project_invoices (draw_id) WHERE draw_id IS NOT NULL AND status <> 'void';
CREATE UNIQUE INDEX IF NOT EXISTS project_invoices_co_uq
  ON project_invoices (change_order_id) WHERE change_order_id IS NOT NULL AND status <> 'void';

ALTER TABLE project_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_invoices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON project_invoices;
CREATE POLICY tenant_isolation ON project_invoices
  USING (projects.tenant_enabled(tenant_id))
  WITH CHECK (projects.tenant_enabled(tenant_id));

-- ---------------------------------------------------------------------------
-- Issued but not yet recorded in the revenue system. The same control the
-- module already provides for approved-but-uninvoiced draws, one step later in
-- the chain: the customer has been asked for money and the books do not know.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_unrecorded_invoices WITH (security_invoker = true) AS
SELECT i.tenant_id, i.id AS project_invoice_id, i.invoice_number, i.project_id,
       p.project_number, p.name AS project_name, i.amount, i.issued_on,
       (CURRENT_DATE - i.issued_on) AS days_since_issued
FROM project_invoices i
JOIN projects p ON p.id = i.project_id
WHERE i.status IN ('issued','sent') AND i.external_ref IS NULL;
