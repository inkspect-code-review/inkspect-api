-- Additive: old Go queues remain readable while their owners finish work.
CREATE TABLE IF NOT EXISTS api_engine_runtime (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 generation text NOT NULL DEFAULT '',
 origin text NOT NULL DEFAULT '',
 legacy_draining boolean NOT NULL DEFAULT false
);
INSERT INTO api_engine_runtime(id) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS api_engine_legacy_queue (
 queue_database text NOT NULL,
 queue_schema text NOT NULL,
 PRIMARY KEY(queue_database,queue_schema)
);
CREATE TABLE IF NOT EXISTS api_engine_job (
 id text PRIMARY KEY CHECK(id ~ '^J-[a-f0-9]{32}$'),
 request_id text UNIQUE NOT NULL,
 organization_id text NOT NULL,
 repository_id text NOT NULL,
 connection_id text NOT NULL,
 installation_id bigint NOT NULL,
 subject text NOT NULL,
 request jsonb NOT NULL,
 snapshot jsonb NOT NULL,
 host_config jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','completed','failed','cancelled')),
 owner text,
 cancel_requested boolean NOT NULL DEFAULT false,
 report jsonb,
 billing_usage jsonb,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_engine_job_queue ON api_engine_job(created_at) WHERE status='queued';
CREATE TABLE IF NOT EXISTS api_engine_event (
 id bigserial PRIMARY KEY,
 job_id text NOT NULL REFERENCES api_engine_job(id),
 event jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
