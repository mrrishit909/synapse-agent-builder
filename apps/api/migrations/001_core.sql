-- Platform tables shared by every service: tenants, API tokens, audit log, idempotency keys, schema version.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now());

CREATE TABLE organizations (
  id UUID PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('developer', 'startup', 'scale', 'enterprise')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- tokens are stored hashed; role decides what a token may do, organization decides which rows it may see
CREATE TABLE api_tokens (
  token_sha256 TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- append-only, hash-chained: each row's hash covers the previous row's hash
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail JSONB,
  trace_id TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE idempotency_keys (
  tenant_id UUID NOT NULL,
  key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  status INT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
