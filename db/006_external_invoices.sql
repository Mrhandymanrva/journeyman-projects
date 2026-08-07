-- ============================================================================
-- EXTERNAL INVOICES AND DRAW APPLICATION
--
-- Mason, August 2026: "ST is the only place in-house technician invoices are
-- generated. They will be tracked and consolidated to the project app." And
-- earlier: "the ST invoice should be applied to the draw ... whatever happens
-- in ST and QuickBooks should be reconciled to this app."
--
-- draws.external_invoice_number is a single text column, which assumes exactly
-- one invoice per draw and that somebody typed it. Neither holds:
--
--   * A draw is satisfied by MANY invoices. Technicians invoice per visit in
--     ServiceTitan, so a milestone worth 12,540 arrives as a dozen of them.
--   * An invoice exists before anyone decides which draw it belongs to. It has
--     to be recordable unapplied, or the ones nobody gets round to filing are
--     exactly the ones that vanish.
--
-- Two tables. `external_invoices` is what we know exists over there,
-- discovered or entered, whether or not anyone has decided what it is for.
-- `draw_invoice_applications` is the decision.
--
-- Keeping them separate is the whole point. An invoice with no application is
-- not an error in the data — it is the finding. It is the sub paid out of
-- QuickBooks whose cost never reached the job, and the technician's visit that
-- was billed but never counted against a milestone.
--
-- draws.external_invoice_number is left in place and still stamped, so nothing
-- reading it breaks. It should be read as "the first invoice applied", and
-- retired once nothing depends on it.
-- ============================================================================

SET search_path = projects, public;

CREATE TABLE IF NOT EXISTS external_invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_system_id  uuid REFERENCES external_systems(id),
  -- Nullable on purpose. An invoice can be discovered before anyone has
  -- worked out which project it belongs to, and refusing to record it until
  -- somebody does is how it stays invisible.
  project_id          uuid REFERENCES projects(id) ON DELETE SET NULL,
  external_invoice_number text NOT NULL,
  external_invoice_id text,
  external_job_id     text,
  amount              numeric(14,2) NOT NULL,
  invoiced_on         date,
  paid_on             date,
  description         text,
  -- 'adapter' when pulled from the revenue system, 'manual' when a human
  -- entered it. A manual row is an assertion; an adapter row is observed.
  source              text NOT NULL DEFAULT 'manual',
  imported_at         timestamptz NOT NULL DEFAULT now(),
  recorded_by         uuid REFERENCES staff(id),
  UNIQUE (tenant_id, external_system_id, external_invoice_number)
);
COMMENT ON TABLE external_invoices IS
  'Invoices that exist in the revenue system, recorded here whether or not anyone has decided which draw they satisfy. An unapplied row is the finding, not a defect.';

CREATE INDEX IF NOT EXISTS external_invoices_project_idx
  ON external_invoices (tenant_id, project_id);
CREATE INDEX IF NOT EXISTS external_invoices_job_idx
  ON external_invoices (tenant_id, external_job_id) WHERE external_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS draw_invoice_applications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  draw_id             uuid NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
  external_invoice_id uuid NOT NULL REFERENCES external_invoices(id) ON DELETE CASCADE,
  -- Not necessarily the whole invoice. One invoice may span two draws at a
  -- milestone boundary, and a part-applied invoice is still better information
  -- than an unapplied one.
  amount_applied      numeric(14,2) NOT NULL CHECK (amount_applied <> 0),
  applied_by          uuid REFERENCES staff(id),
  applied_at          timestamptz NOT NULL DEFAULT now(),
  note                text,
  UNIQUE (draw_id, external_invoice_id)
);
COMMENT ON TABLE draw_invoice_applications IS
  'Which external invoices satisfy which draw, and by how much. Many-to-one: a milestone is typically satisfied by a run of per-visit invoices.';

CREATE INDEX IF NOT EXISTS draw_applications_draw_idx
  ON draw_invoice_applications (tenant_id, draw_id);

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['external_invoices','draw_invoice_applications'] LOOP
    EXECUTE format('ALTER TABLE projects.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE projects.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON projects.%I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON projects.%I
        USING (projects.tenant_enabled(tenant_id))
        WITH CHECK (projects.tenant_enabled(tenant_id))
    $p$, t);
  END LOOP;
END $rls$;

-- ---------------------------------------------------------------------------
-- How much of each draw has actually been invoiced, by application rather than
-- by the scalar. security_invoker so RLS on the base tables carries through.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_draw_application WITH (security_invoker = true) AS
SELECT d.tenant_id, d.project_id, d.id AS draw_id, d.sequence_number, d.label,
       d.amount AS draw_amount, d.is_retainage, d.status,
       COALESCE(a.applied, 0)              AS applied_amount,
       d.amount - COALESCE(a.applied, 0)   AS unapplied_amount,
       COALESCE(a.invoice_count, 0)        AS invoice_count
FROM draws d
LEFT JOIN LATERAL (
  SELECT SUM(amount_applied) AS applied, count(*) AS invoice_count
    FROM draw_invoice_applications x WHERE x.draw_id = d.id
) a ON true;

-- ---------------------------------------------------------------------------
-- The leakage control. An invoice that exists over there and has not been
-- applied to anything here — including one nobody has even matched to a
-- project. This is the report Mason described: money that moved in ServiceTitan
-- or QuickBooks and never landed against a job.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_unapplied_invoices WITH (security_invoker = true) AS
SELECT i.tenant_id, i.id AS external_invoice_id, i.external_invoice_number,
       i.external_job_id, i.amount, i.invoiced_on, i.source,
       i.project_id, p.project_number, p.name AS project_name,
       i.amount - COALESCE(a.applied, 0) AS unapplied_amount,
       (i.project_id IS NULL)            AS unmatched_to_project,
       (CURRENT_DATE - i.invoiced_on)    AS days_since_invoiced
FROM external_invoices i
LEFT JOIN projects p ON p.id = i.project_id
LEFT JOIN LATERAL (
  SELECT SUM(amount_applied) AS applied
    FROM draw_invoice_applications x WHERE x.external_invoice_id = i.id
) a ON true
WHERE i.amount - COALESCE(a.applied, 0) <> 0;
