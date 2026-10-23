SET search_path=projects,public;
ALTER TABLE vendor_documents ADD COLUMN IF NOT EXISTS coverage_kinds doc_kind[] NOT NULL DEFAULT '{}';
ALTER TABLE vendor_documents ADD CONSTRAINT vendor_documents_insurance_coverage CHECK (
 cardinality(coverage_kinds)=0 OR (
 kind IN ('gl_insurance','wc_insurance','auto_insurance')
 AND coverage_kinds <@ ARRAY['gl_insurance','wc_insurance','auto_insurance']::doc_kind[]
 AND kind = ANY(coverage_kinds)
 AND array_position(coverage_kinds,NULL) IS NULL
 AND expires_on IS NOT NULL
 ));
CREATE OR REPLACE VIEW v_vendor_compliance WITH (security_invoker = true) AS
SELECT
  v.tenant_id, v.id AS vendor_id, v.legal_name, r.kind, r.blocks_scheduling, d.expires_on,
  CASE
    WHEN d.id IS NULL                THEN 'missing'
    WHEN d.expires_on IS NULL        THEN 'valid'
    WHEN d.expires_on < CURRENT_DATE THEN 'expired'
    WHEN d.expires_on < CURRENT_DATE + (r.warn_days||' days')::interval THEN 'expiring'
    ELSE 'valid'
  END AS state
FROM vendors v
JOIN compliance_requirements r ON r.tenant_id = v.tenant_id AND r.required
LEFT JOIN LATERAL (
  SELECT * FROM vendor_documents vd
  WHERE vd.vendor_id = v.id AND (vd.kind = r.kind OR r.kind = ANY(vd.coverage_kinds))
  ORDER BY vd.expires_on DESC NULLS LAST LIMIT 1
) d ON true;
