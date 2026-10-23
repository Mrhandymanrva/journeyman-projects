SET search_path=projects,public;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS specialties text[] NOT NULL DEFAULT '{}';
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS availability_status text NOT NULL DEFAULT 'unknown' CHECK(availability_status IN ('unknown','available','limited','booked','unavailable'));
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS available_from date;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS availability_notes text;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS license_expires_on date;
ALTER TABLE vendor_documents ADD COLUMN IF NOT EXISTS file_name text;
ALTER TABLE vendor_documents ADD COLUMN IF NOT EXISTS media_type text;
ALTER TABLE vendor_documents ADD COLUMN IF NOT EXISTS file_data bytea;
ALTER TABLE vendor_documents ADD COLUMN IF NOT EXISTS file_size integer CHECK(file_size BETWEEN 1 AND 8388608);
CREATE TABLE IF NOT EXISTS bid_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 project_id uuid NOT NULL,subject text NOT NULL,scope text NOT NULL,due_on date,window_start date,window_end date,
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),closed_at timestamptz,
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES staff(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS bid_recipients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,vendor_id uuid NOT NULL,email text NOT NULL,
 delivery_status text NOT NULL DEFAULT 'draft' CHECK(delivery_status IN ('draft','prepared','sending','sent','failed','uncertain')),
 response_status text NOT NULL DEFAULT 'awaiting' CHECK(response_status IN ('awaiting','interested','declined','quoted','awarded','not_selected')),
 quote_amount numeric(14,2) CHECK(quote_amount>=0),response_notes text,available_from date,
 sent_at timestamptz,responded_at timestamptz,token_hash text,token_expires_at timestamptz,provider_id text,last_error text,
 history jsonb NOT NULL DEFAULT '[]',
 UNIQUE(tenant_id,id),UNIQUE(request_id,vendor_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES bid_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,vendor_id) REFERENCES vendors(tenant_id,id)
);
ALTER TABLE bid_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE bid_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bid_requests USING(projects.tenant_enabled(tenant_id)) WITH CHECK(projects.tenant_enabled(tenant_id));
ALTER TABLE bid_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE bid_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bid_recipients USING(projects.tenant_enabled(tenant_id)) WITH CHECK(projects.tenant_enabled(tenant_id));
