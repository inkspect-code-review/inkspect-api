ALTER TABLE api_repository_worker
  ADD COLUMN IF NOT EXISTS index_limit_bytes bigint
  CHECK (index_limit_bytes BETWEEN 1 AND 9007199254740991);
