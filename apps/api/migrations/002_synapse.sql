-- SYNAPSE tables (blueprint 02 section 5), with tenant_id, created_by, updated_at and soft delete added where rows belong to one
-- organisation, plus (+) secrets, endpoints and the stored run payloads. Row-level security on every tenant table.
CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  owner_org_id UUID NOT NULL REFERENCES organizations(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE workflows (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id),   -- (+)
  workspace_id UUID REFERENCES workspaces(id),
  slug TEXT NOT NULL,                                       -- (+) the client's workflow id, e.g. "wf-support"
  name TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  graph_json JSONB NOT NULL,
  status TEXT,
  created_by TEXT, updated_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, slug, version)
);
CREATE TABLE workflow_nodes (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id),   -- (+)
  workflow_id UUID REFERENCES workflows(id),
  node_key TEXT NOT NULL,                                   -- (+) the node's id inside the graph
  node_type TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  config JSONB NOT NULL,
  x DOUBLE PRECISION,
  y DOUBLE PRECISION
);
CREATE TABLE runs (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id),   -- (+)
  workflow_id UUID REFERENCES workflows(id),
  workflow_version INT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  total_cost_usd NUMERIC,
  total_latency_ms BIGINT,
  options JSONB NOT NULL,                                   -- (+) e-mail id, faults, overrides: what replay needs
  result JSONB NOT NULL                                     -- (+) the whole (redacted) trace
);
CREATE TABLE run_steps (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id),   -- (+)
  run_id UUID REFERENCES runs(id),
  node_id UUID REFERENCES workflow_nodes(id),
  sequence_no INT NOT NULL,
  input_json JSONB,
  output_json JSONB,
  latency_ms INT,
  token_in INT,
  token_out INT,
  cost_usd NUMERIC,
  status TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX run_steps_run ON run_steps (run_id, sequence_no);
CREATE TABLE evaluations (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id),   -- (+)
  run_step_id UUID REFERENCES run_steps(id),
  evaluator_type TEXT,
  score DOUBLE PRECISION,
  rationale TEXT,
  metadata JSONB
);
CREATE TABLE secrets (                                       -- (+) AES-256-GCM; the key comes from the environment, never the database
  tenant_id UUID NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  nonce BYTEA NOT NULL,
  value_enc BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tenant_id, name)
);
CREATE TABLE endpoints (                                     -- (+) published workflow versions
  slug TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id),
  workflow_id UUID NOT NULL REFERENCES workflows(id),
  key_sha256 TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE client_telemetry (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ DEFAULT now(), sample JSONB NOT NULL);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synapse_app') THEN CREATE ROLE synapse_app LOGIN PASSWORD 'app-dev-only'; END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO synapse_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO synapse_app;
REVOKE UPDATE, DELETE ON audit_log FROM synapse_app;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['workflows','workflow_nodes','runs','run_steps','evaluations','secrets','audit_log','idempotency_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant'', true)::uuid)', t);
  END LOOP;
END $$;
-- endpoints are looked up by slug before the tenant is known (the caller holds an endpoint key, not a user token): no RLS there,
-- the key hash is the check
