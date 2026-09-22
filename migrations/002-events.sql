CREATE TABLE devices (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_heartbeat_at timestamptz,
  last_boot_id text,
  last_queue_depth integer NOT NULL DEFAULT 0 CHECK (last_queue_depth >= 0),
  event_loss boolean NOT NULL DEFAULT false,
  current_epoch text,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  rate_limit_tokens numeric NOT NULL DEFAULT 20 CHECK (rate_limit_tokens >= 0 AND rate_limit_tokens <= 20),
  rate_limit_updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX devices_active_heartbeat ON devices(last_heartbeat_at) WHERE revoked_at IS NULL;

CREATE TABLE device_streams (
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  epoch text NOT NULL CHECK (char_length(epoch) BETWEEN 1 AND 128),
  generation integer NOT NULL CHECK (generation > 0),
  contiguous_sequence bigint NOT NULL DEFAULT 0 CHECK (contiguous_sequence >= 0),
  active boolean NOT NULL DEFAULT true,
  retired_at timestamptz,
  gap_detected boolean NOT NULL DEFAULT false,
  queue_lost boolean NOT NULL DEFAULT false,
  incomplete boolean NOT NULL DEFAULT false,
  recovery_through bigint NOT NULL DEFAULT 0 CHECK (recovery_through >= 0),
  boot_id text,
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_event_at timestamptz,
  PRIMARY KEY (device_id, epoch),
  CHECK (active = (retired_at IS NULL))
);

CREATE UNIQUE INDEX one_active_stream_per_device ON device_streams(device_id) WHERE active;
CREATE INDEX device_stream_history ON device_streams(device_id, generation DESC);

CREATE TABLE projects (
  project_key text PRIMARY KEY CHECK (char_length(project_key) BETWEEN 1 AND 160),
  name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 160),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  session_id text NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 128),
  generation integer NOT NULL CHECK (generation > 0),
  state jsonb NOT NULL,
  project_key text REFERENCES projects(project_key) ON DELETE SET NULL,
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 160),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, session_id)
);

CREATE INDEX sessions_device_generation ON sessions(device_id, generation);

CREATE TABLE agent_events (
  device_id text NOT NULL,
  epoch text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 128),
  session_id text NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  applied boolean NOT NULL DEFAULT false,
  PRIMARY KEY (device_id, epoch, sequence),
  UNIQUE (device_id, event_id),
  FOREIGN KEY (device_id, epoch) REFERENCES device_streams(device_id, epoch) ON DELETE CASCADE
);

CREATE INDEX agent_events_retention ON agent_events(received_at);
CREATE INDEX agent_events_session ON agent_events(device_id, session_id, received_at DESC);

CREATE TABLE device_account_links (
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, account_id)
);

CREATE INDEX device_account_links_account ON device_account_links(account_id);
