CREATE TABLE provider_credentials (
  account_id text PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

UPDATE provider_accounts SET enabled = false WHERE provider_id = 'manual';
