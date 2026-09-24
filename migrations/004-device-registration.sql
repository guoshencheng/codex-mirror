CREATE TABLE device_registrations (
  idempotency_hash char(64) PRIMARY KEY CHECK (idempotency_hash ~ '^[0-9a-f]{64}$'),
  device_id text NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
