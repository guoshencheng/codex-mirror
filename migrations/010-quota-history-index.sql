CREATE INDEX IF NOT EXISTS quota_history_account_time
  ON quota_snapshots(account_id, observed_at, id);
