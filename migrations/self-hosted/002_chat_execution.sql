CREATE TABLE IF NOT EXISTS workspace_chat_turn (
  message_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  model text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done','failed')),
  redacted boolean NOT NULL DEFAULT false,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_chat_turn_conversation ON workspace_chat_turn(organization_id,conversation_id);
CREATE TABLE IF NOT EXISTS workspace_chat_usage (
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  user_id text NOT NULL,
  message_id text NOT NULL,
  calls integer NOT NULL CHECK (calls >= 0),
  measurement jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,operation_id)
);
