CREATE TABLE repository_indexes (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  id text NOT NULL,
  subject text NOT NULL,
  connection_id text NOT NULL,
  installation_id bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  progress jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, repository_id, id)
);
CREATE UNIQUE INDEX repository_index_active ON repository_indexes (tenant_id, repository_id)
  WHERE status IN ('queued', 'running');
