ALTER TABLE api_review_settings
  ADD COLUMN IF NOT EXISTS check_threshold text NOT NULL DEFAULT 'P0'
  CHECK (check_threshold IN ('P0', 'P1', 'P2', 'P3'));
