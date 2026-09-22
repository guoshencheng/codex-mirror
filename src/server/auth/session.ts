import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { authDatabasePool } from './database';
import { SESSION_LIFETIME_SECONDS, sessionCookieName } from './cookie';
import { hasValidOrigin, hashCsrfToken, csrfTokenMatches } from './csrf';

export interface CreatedAdminSession {
  token: string;
  csrfToken: string;
  expiresAt: string;
}

export interface AuthenticatedAdmin {
  id: string;
  sessionId: string;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function readCookie(request: Request, name: string): string | null {
  const value = request.headers.get('cookie');
  if (!value) return null;
  const matches: string[] = [];
  for (const item of value.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    matches.push(item.slice(separator + 1).trim());
  }
  if (matches.length !== 1 || !/^[A-Za-z0-9_-]{40,128}$/.test(matches[0]!)) return null;
  return matches[0]!;
}

export async function createAdminSession(adminId: string, pool: Pool = authDatabasePool(), now = new Date()): Promise<CreatedAdminSession> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_SECONDS * 1_000);
  await pool.query(`INSERT INTO admin_sessions(id, admin_id, token_hash, csrf_hash, created_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)`, [randomUUID(), adminId, tokenHash(token), hashCsrfToken(csrfToken), now, expiresAt]);
  return { token, csrfToken, expiresAt: expiresAt.toISOString() };
}

export async function requireAdmin(request: Request, pool?: Pool, now = new Date()): Promise<AuthenticatedAdmin | null> {
  const token = readCookie(request, sessionCookieName());
  if (!token) return null;
  const database = pool ?? authDatabasePool();
  const result = await database.query(`SELECT s.id AS session_id, s.admin_id
    FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
    WHERE s.token_hash = $1 AND s.expires_at > $2`, [tokenHash(token), now]);
  const row = result.rows[0] as { session_id?: string; admin_id?: string } | undefined;
  return row?.session_id && row.admin_id ? { id: row.admin_id, sessionId: row.session_id } : null;
}

export async function verifyCsrf(request: Request, sessionId: string, pool: Pool = authDatabasePool(), now = new Date()): Promise<boolean> {
  if (!hasValidOrigin(request)) return false;
  const token = request.headers.get('x-csrf-token');
  if (!token || !/^[A-Za-z0-9_-]{40,128}$/.test(token)) return false;
  const result = await pool.query('SELECT csrf_hash FROM admin_sessions WHERE id = $1 AND expires_at > $2', [sessionId, now]);
  const hash = result.rows[0] as { csrf_hash?: string } | undefined;
  return Boolean(hash?.csrf_hash && csrfTokenMatches(token, hash.csrf_hash));
}

export async function deleteAdminSession(sessionId: string, pool: Pool = authDatabasePool()): Promise<void> {
  await pool.query('DELETE FROM admin_sessions WHERE id = $1', [sessionId]);
}
