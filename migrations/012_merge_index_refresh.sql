CREATE TABLE IF NOT EXISTS api_merge_index_refresh (
  organization_id text NOT NULL, repository_id text NOT NULL,
  connection_id text NOT NULL, installation_id bigint NOT NULL,
  merged_at timestamptz NOT NULL, due_at timestamptz, request_id uuid NOT NULL,
  PRIMARY KEY (organization_id, repository_id, connection_id, installation_id)
);
CREATE INDEX IF NOT EXISTS api_merge_index_due ON api_merge_index_refresh(due_at) WHERE due_at IS NOT NULL;
