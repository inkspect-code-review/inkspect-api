CREATE TABLE IF NOT EXISTS workspace_provider_settings (
  organization_id text PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  review_provider text NOT NULL CHECK (review_provider IN ('managed','byok'))
);
CREATE TABLE IF NOT EXISTS workspace_provider_credential (
  organization_id text PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  id text NOT NULL UNIQUE,
  provider text NOT NULL,
  model text NOT NULL,
  envelope jsonb NOT NULL,
  key_suffix text NOT NULL,
  updated_by text NOT NULL REFERENCES "user"(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
