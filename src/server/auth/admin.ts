import type { Pool } from 'pg';
import { authDatabasePool } from './database';
import { hashPassword, validatePassword } from './password';

export interface AdminRecord {
  id: string;
  username: string;
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export async function createAdmin(username: string, password: string, pool: Pool = authDatabasePool()): Promise<AdminRecord> {
  const normalized = normalizeUsername(username);
  if (!/^[a-z0-9._@+-]{3,120}$/.test(normalized)) throw new Error('INVALID_ADMIN_USERNAME');
  validatePassword(password);
  const passwordHash = await hashPassword(password);
  try {
    await pool.query('INSERT INTO admins(id, username, password_hash) VALUES (\'owner\', $1, $2)', [normalized, passwordHash]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error('ADMIN_ALREADY_EXISTS');
    throw error;
  }
  return { id: 'owner', username: normalized };
}

export async function updateAdminPassword(adminId: string, password: string, pool: Pool = authDatabasePool()): Promise<boolean> {
  validatePassword(password);
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query('UPDATE admins SET password_hash = $2 WHERE id = $1', [adminId, passwordHash]);
    if (updated.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('DELETE FROM admin_sessions WHERE admin_id = $1', [adminId]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
