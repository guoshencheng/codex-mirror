import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { eventDatabasePool } from './database';

export interface CreatedDevice {
  id: string;
  name: string;
  token: string;
}

export async function createDevice(name: string, pool: Pool = eventDatabasePool()): Promise<CreatedDevice> {
  const label = name.trim();
  if (label.length < 1 || label.length > 120) throw new Error('INVALID_DEVICE_NAME');
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await pool.query('INSERT INTO devices(id, name, token_hash) VALUES ($1, $2, $3)', [id, label, tokenHash]);
  return { id, name: label, token };
}

export async function revokeDevice(id: string, pool: Pool = eventDatabasePool()): Promise<boolean> {
  const result = await pool.query('UPDATE devices SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND revoked_at IS NULL', [id]);
  return (result.rowCount ?? 0) === 1;
}
