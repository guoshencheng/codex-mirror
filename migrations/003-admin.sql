CREATE TABLE admins (
  id text PRIMARY KEY DEFAULT 'owner' CHECK (id = 'owner'),
  username text NOT NULL UNIQUE CHECK (char_length(username) BETWEEN 3 AND 120 AND username = lower(username)),
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 40 AND 256),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY,
  admin_id text NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash char(64) NOT NULL CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE login_attempts (
  key_hash char(64) PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count > 0)
);
