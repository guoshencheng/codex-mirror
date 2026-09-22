import type { Pool } from 'pg';
import { authDatabasePool } from './database';
import { clearLoginAttempts, consumeLoginAttempt, trustedClientIp } from './rate-limit';
import { createAdminSession } from './session';
import { hashPassword, verifyPassword } from './password';

const dummyPasswordHash = hashPassword('nonexistent account timing equalizer password');

export interface LoginResult {
  status: 'ok' | 'invalid' | 'limited';
  retryAfterSeconds?: number;
  token?: string;
  csrfToken?: string;
  expiresAt?: string;
  adminId?: string;
}

export async function authenticateAdmin(
  request: Request,
  username: string,
  password: string,
  pool: Pool = authDatabasePool(),
  now = new Date(),
): Promise<LoginResult> {
  const normalizedUsername = username.trim().toLowerCase();
  const ip = trustedClientIp(request);
  const limit = await consumeLoginAttempt(ip, normalizedUsername, pool, now);
  if (!limit.allowed) return { status: 'limited', retryAfterSeconds: limit.retryAfterSeconds };

  const lookup = await pool.query('SELECT id, username, password_hash FROM admins WHERE username = $1', [normalizedUsername]);
  const row = lookup.rows[0] as { id: string; username: string; password_hash: string } | undefined;
  const matches = await verifyPassword(password, row?.password_hash ?? await dummyPasswordHash);
  if (!row || !matches) return { status: 'invalid' };

  await clearLoginAttempts(ip, normalizedUsername, pool);
  const session = await createAdminSession(row.id, pool, now);
  return { status: 'ok', adminId: row.id, ...session };
}
