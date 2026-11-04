-- Provisioned by trusted operator tooling, never by browser input.
CREATE TABLE IF NOT EXISTS api_repository_worker (
 organization_id text NOT NULL,
 repository_id text NOT NULL,
 connection_id text NOT NULL,
 installation_id bigint NOT NULL,
 full_name text NOT NULL,
 queue_database text NOT NULL CHECK (queue_database IN ('app','legacy')),
 queue_schema text NOT NULL CHECK (queue_schema ~ '^[a-z][a-z0-9_]{0,62}$'),
 app_id bigint NOT NULL,
 private_key_file text NOT NULL,
 size_bytes bigint,
 access_verified_at timestamptz,
 access_error text,
 metadata_due_at timestamptz NOT NULL DEFAULT now(),
 metadata_lease_until timestamptz,
 PRIMARY KEY(organization_id,repository_id)
);
CREATE INDEX IF NOT EXISTS api_repository_metadata_due ON api_repository_worker(metadata_due_at);
