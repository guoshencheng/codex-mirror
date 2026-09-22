import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { authDatabasePool } from './database';

export function expectedAppOrigin(): string {
  const configured = process.env.APP_ORIGIN;
  if (!configured) throw new Error('APP_ORIGIN_REQUIRED');
  let parsed: URL;
  try { parsed = new URL(configured); } catch { throw new Error('APP_ORIGIN_INVALID'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('APP_ORIGIN_INVALID');
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') throw new Error('APP_ORIGIN_MUST_USE_HTTPS');
  return parsed.origin;
}

export function hasValidOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && parsed.origin === expectedAppOrigin();
  } catch {
    return false;
  }
}

export function isJsonRequest(request: Request): boolean {
  const value = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  return value === 'application/json';
}

export function hashCsrfToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function csrfTokenMatches(token: string, storedHash: string): boolean {
  const actual = Buffer.from(hashCsrfToken(token), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function rotateCsrfToken(sessionId: string, pool: Pool = authDatabasePool()): Promise<string | null> {
  const token = randomBytes(32).toString('base64url');
  const result = await pool.query(`UPDATE admin_sessions SET csrf_hash = $2
    WHERE id = $1 AND expires_at > now() RETURNING id`, [sessionId, hashCsrfToken(token)]);
  return result.rowCount === 1 ? token : null;
}
