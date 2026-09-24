ALTER TABLE sessions
  ADD COLUMN harness text CHECK (harness IN ('codex', 'kimi')),
  ADD COLUMN client_type text CHECK (client_type IN ('cli', 'desktop'));

-- Existing Kimi sessions were namespaced by the collector; earlier sessions were Codex-only.
UPDATE sessions
SET harness = CASE WHEN session_id LIKE 'kimi:%' THEN 'kimi' ELSE 'codex' END;
