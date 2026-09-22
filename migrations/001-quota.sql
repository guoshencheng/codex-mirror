CREATE TABLE provider_accounts (
  id text PRIMARY KEY,
  provider_id text NOT NULL,
  label text NOT NULL,
  credential_ref text NOT NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quota_refresh_status (
  account_id text PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  error_code text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  manual_requested_at timestamptz,
  last_manual_at timestamptz,
  auth_blocked boolean NOT NULL DEFAULT false
);

CREATE TABLE quota_latest (
  account_id text PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
  snapshot jsonb NOT NULL
);

CREATE TABLE quota_snapshots (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL
);

CREATE INDEX quota_history_age ON quota_snapshots(observed_at);
CREATE INDEX quota_refresh_due ON quota_refresh_status(next_attempt_at) WHERE auth_blocked = false;
