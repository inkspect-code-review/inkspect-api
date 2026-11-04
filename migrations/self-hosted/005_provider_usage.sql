CREATE TABLE IF NOT EXISTS workspace_provider_usage (
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('review','embedding','chat')),
  operation_id text NOT NULL,
  user_id text NOT NULL,
  repository_id text,
  measurement jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,category,operation_id)
);
CREATE INDEX IF NOT EXISTS workspace_provider_usage_history ON workspace_provider_usage(organization_id,created_at DESC);
