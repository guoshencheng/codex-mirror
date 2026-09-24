import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Pool, PoolClient } from 'pg';
import { authDatabasePool } from './database';

const WINDOW_MILLISECONDS = 15 * 60 * 1_000;
const MAX_ATTEMPTS = 5;

export interface LoginLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function trustedClientIp(request: Request): string {
  const headerName = process.env.NODE_ENV === 'production'
    ? 'x-vercel-forwarded-for'
    : process.env.AUTH_TRUSTED_CLIENT_IP_HEADER;
  if (!headerName) return 'unknown';
  const raw = request.headers.get(headerName)?.trim();
  if (!raw) return 'unknown';
  const candidate = raw.split(',', 1)[0]!.trim();
  return isIP(candidate) ? candidate : 'unknown';
}

export function loginLimitKey(ip: string, username: string): string {
  return createHash('sha256').update(`${ip}\0${username.trim().toLowerCase()}`).digest('hex');
}

export async function consumeLoginAttempt(
  ip: string,
  username: string,
  pool: Pool | PoolClient = authDatabasePool(),
  now = new Date(),
): Promise<LoginLimitResult> {
  const key = loginLimitKey(ip, username);
  await pool.query('DELETE FROM login_attempts WHERE window_started_at < $1', [new Date(now.getTime() - 24 * 60 * 60 * 1_000)]);
  const result = await pool.query(`INSERT INTO login_attempts(key_hash, window_started_at, attempt_count)
      VALUES ($1, $2, 1)
    ON CONFLICT (key_hash) DO UPDATE SET
      window_started_at = CASE
        WHEN login_attempts.window_started_at <= $2::timestamptz - interval '15 minutes' THEN $2
        ELSE login_attempts.window_started_at END,
      attempt_count = CASE
        WHEN login_attempts.window_started_at <= $2::timestamptz - interval '15 minutes' THEN 1
        ELSE login_attempts.attempt_count + 1 END
    RETURNING attempt_count, window_started_at`, [key, now]);
  const row = result.rows[0] as { attempt_count: number; window_started_at: Date | string };
  const attemptCount = Number(row.attempt_count);
  const resetAt = new Date(row.window_started_at).getTime() + WINDOW_MILLISECONDS;
  return {
    allowed: attemptCount <= MAX_ATTEMPTS,
    retryAfterSeconds: attemptCount <= MAX_ATTEMPTS ? 0 : Math.max(1, Math.ceil((resetAt - now.getTime()) / 1_000)),
  };
}

export async function clearLoginAttempts(ip: string, username: string, pool: Pool = authDatabasePool()): Promise<void> {
  await pool.query('DELETE FROM login_attempts WHERE key_hash = $1', [loginLimitKey(ip, username)]);
}
