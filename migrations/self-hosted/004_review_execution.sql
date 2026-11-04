CREATE TABLE IF NOT EXISTS workspace_review_execution (
  request_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  repository_id text NOT NULL,
  connection_id text NOT NULL,
  installation_id text NOT NULL,
  request jsonb NOT NULL,
  job_id text UNIQUE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed','failed','cancelled','rejected')),
  measurement jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  last_checked_at timestamptz
);
CREATE INDEX IF NOT EXISTS workspace_review_pending ON workspace_review_execution(organization_id,last_checked_at) WHERE state='pending';
