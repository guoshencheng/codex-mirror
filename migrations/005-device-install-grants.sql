CREATE TABLE device_install_grants (
  token_hash char(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  device_id text UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
  CHECK (expires_at > created_at),
  CHECK ((redeemed_at IS NULL) = (device_id IS NULL))
);

CREATE INDEX device_install_grants_expiry
  ON device_install_grants(expires_at)
  WHERE redeemed_at IS NULL;
