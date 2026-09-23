CREATE TABLE codex_login_requests (
  id uuid PRIMARY KEY,
  account_id text NOT NULL UNIQUE,
  session_id uuid NOT NULL REFERENCES admin_sessions(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  status text NOT NULL CHECK (status IN ('queued', 'starting', 'awaiting', 'succeeded', 'failed', 'cancelled', 'expired')),
  login_id uuid,
  verification_url text,
  user_code text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX codex_login_one_active_per_session ON codex_login_requests(session_id)
  WHERE status IN ('queued', 'starting', 'awaiting');
CREATE INDEX codex_login_queue ON codex_login_requests(created_at) WHERE status = 'queued';
CREATE INDEX codex_login_expiry ON codex_login_requests(expires_at)
  WHERE status IN ('queued', 'starting', 'awaiting');
