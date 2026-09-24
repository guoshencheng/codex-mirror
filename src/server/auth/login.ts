import type { Pool } from 'pg';
import { authDatabasePool } from './database';
import { clearLoginAttempts, consumeLoginAttempt, trustedClientIp } from './rate-limit';
import { createAdminSession } from './session';
import { matchesConfiguredUserToken } from './configured-token';

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
  userToken: string,
  pool: Pool = authDatabasePool(),
  now = new Date(),
): Promise<LoginResult> {
  const authenticated = await authenticateAdminToken(request, userToken, pool, now);
  if (authenticated.status !== 'ok' || !authenticated.adminId) return authenticated;
  const session = await createAdminSession(authenticated.adminId, pool, now);
  return { ...authenticated, ...session };
}

export async function authenticateAdminToken(
  request: Request,
  userToken: string,
  pool: Pool = authDatabasePool(),
  now = new Date(),
): Promise<Pick<LoginResult, 'status' | 'retryAfterSeconds' | 'adminId'>> {
  const normalizedUsername = 'owner';
  const ip = trustedClientIp(request);
  const limit = await consumeLoginAttempt(ip, normalizedUsername, pool, now);
  if (!limit.allowed) return { status: 'limited', retryAfterSeconds: limit.retryAfterSeconds };

  if (!matchesConfiguredUserToken(userToken)) return { status: 'invalid' };

  await clearLoginAttempts(ip, normalizedUsername, pool);
  return { status: 'ok', adminId: 'owner' };
}
