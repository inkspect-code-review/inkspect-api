CREATE TABLE IF NOT EXISTS api_finding_resolution (
  organization_id text NOT NULL,
  repository_id text NOT NULL,
  connection_id text NOT NULL,
  installation_id bigint NOT NULL,
  job_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  finding_id text NOT NULL,
  resolved_by text NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, repository_id, connection_id, installation_id, job_id, ordinal)
);
