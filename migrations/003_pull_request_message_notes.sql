-- Text written next to an App mention. It reaches the next review as a bounded,
-- untrusted note; the engine validates it again before any model call.
ALTER TABLE api_pull_request_message ADD COLUMN IF NOT EXISTS note text
 CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000);
