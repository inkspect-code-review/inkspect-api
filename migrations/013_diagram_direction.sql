ALTER TABLE api_review_settings
  ADD COLUMN IF NOT EXISTS diagram_direction text NOT NULL DEFAULT 'TD'
  CHECK (diagram_direction IN ('TD', 'LR'));
