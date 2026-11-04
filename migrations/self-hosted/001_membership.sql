-- Run after the shared authentication schema. No Cloud/payment tables required.
CREATE TABLE IF NOT EXISTS workspace_invitation (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email)),
  role text NOT NULL CHECK (role IN ('member', 'admin')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'cancelled', 'expired')),
  invited_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitation_pending_email
  ON workspace_invitation(organization_id,email) WHERE status='pending';
