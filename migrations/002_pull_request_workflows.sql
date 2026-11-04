-- One durable conversation per connected PR; revisions reuse its comment.
CREATE TABLE IF NOT EXISTS api_pull_request_workflow (
 id uuid PRIMARY KEY,
 organization_id text NOT NULL,
 repository_id text NOT NULL,
 connection_id text NOT NULL,
 installation_id bigint NOT NULL,
 number integer NOT NULL CHECK (number > 0),
 state jsonb NOT NULL DEFAULT '{}',
 wake_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 next_run_at timestamptz DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (organization_id,repository_id,connection_id,installation_id,number)
);
CREATE INDEX IF NOT EXISTS api_pull_request_due ON api_pull_request_workflow(next_run_at) WHERE next_run_at IS NOT NULL;

-- Absence of a row means enabled, including newly created organizations.
CREATE TABLE IF NOT EXISTS api_review_settings (
 organization_id text PRIMARY KEY,
 automatic boolean NOT NULL DEFAULT true,
 updated_by text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS api_pull_request_message (
 workflow_id uuid NOT NULL REFERENCES api_pull_request_workflow(id),
 comment_id bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN ('issue','inline')),
 sender text NOT NULL,
 intent text NOT NULL CHECK(intent IN ('review','explain')),
 reply_to bigint,
 state jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workflow_id,kind,comment_id)
);
