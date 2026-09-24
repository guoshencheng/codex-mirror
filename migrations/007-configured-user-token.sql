-- The shared user Token is read from a private server file. Keep only the
-- owner row needed by the existing short-lived session foreign key.
INSERT INTO admins (id, username, password_hash)
VALUES ('owner', 'owner', repeat('0', 64))
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash;

-- Sessions minted by the former database-backed login cannot be validated
-- after switching to configured Token authentication.
DELETE FROM admin_sessions;
