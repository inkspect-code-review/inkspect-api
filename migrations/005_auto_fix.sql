ALTER TABLE api_review_settings ADD COLUMN IF NOT EXISTS auto_fix boolean NOT NULL DEFAULT false;
ALTER TABLE api_review_settings ADD COLUMN IF NOT EXISTS auto_fix_by text;
ALTER TABLE api_review_settings ADD COLUMN IF NOT EXISTS auto_fix_since timestamptz;
ALTER TABLE api_review_settings ADD COLUMN IF NOT EXISTS auto_fix_version bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS api_engine_auto_fix_scan ON api_engine_job(finished_at)
  WHERE status='completed' AND NOT (request ? 'fix_of') AND NOT (snapshot ? 'auto_fix_outcome');
