-- Cached installation capabilities; dashboard reads never call GitHub.
CREATE TABLE IF NOT EXISTS api_github_permissions (
 installation_id text PRIMARY KEY CHECK (installation_id ~ '^[1-9][0-9]*$'),
 app_id text NOT NULL,
 contents text CHECK (contents IN ('read','write','none')),
 installation_url text,
 checked_at timestamptz,
 unavailable boolean NOT NULL DEFAULT false,
 next_check_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz
);
