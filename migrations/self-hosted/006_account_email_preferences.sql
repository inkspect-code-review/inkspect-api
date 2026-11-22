CREATE TABLE IF NOT EXISTS account_email_preference (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  product boolean NOT NULL DEFAULT true,
  transactional boolean NOT NULL DEFAULT true
);
