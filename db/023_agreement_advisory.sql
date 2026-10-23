SET search_path=projects,public;
-- Keep agreements in the checklist, but do not block work on a signature.
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT id FROM projects.tenants LOOP
  PERFORM set_config('app.tenant_id',t.id::text,true);
  UPDATE projects.compliance_requirements SET blocks_scheduling=false
   WHERE tenant_id=t.id AND kind='master_agreement';
 END LOOP;
END $$;
CREATE FUNCTION agreement_advisory_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='master_agreement' THEN NEW.blocks_scheduling=false; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agreement_advisory_default BEFORE INSERT ON compliance_requirements
 FOR EACH ROW EXECUTE FUNCTION agreement_advisory_default();
