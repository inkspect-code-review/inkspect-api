-- An empty list preserves automatic reviews for every author.
ALTER TABLE api_review_settings ADD COLUMN IF NOT EXISTS ignored_authors text[] NOT NULL DEFAULT '{}';
