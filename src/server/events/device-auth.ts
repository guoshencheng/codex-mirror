import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { eventDatabasePool } from './database';

export async function authenticateDevice(request: Request, pool: Pool = eventDatabasePool()): Promise<{ id: string } | null> {
  const value = request.headers.get('authorization');
  const match = value && /^Bearer ([A-Za-z0-9_-]{40,128})$/.exec(value);
  if (!match) return null;
  const tokenHash = createHash('sha256').update(match[1]!).digest('hex');
  const result = await pool.query('SELECT id FROM devices WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash]);
  const id = (result.rows[0] as { id?: string } | undefined)?.id;
  return id ? { id } : null;
}

export interface DeviceRateLimit {
  allowed: boolean;
  retryAfterSeconds: number;
}

export async function consumeDeviceRateLimit(
  deviceId: string,
  pool: Pool = eventDatabasePool(),
  now = new Date(),
): Promise<DeviceRateLimit> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT rate_limit_tokens, rate_limit_updated_at FROM devices
      WHERE id = $1 AND revoked_at IS NULL FOR UPDATE`, [deviceId]);
    if (!result.rowCount) {
      await client.query('COMMIT');
      return { allowed: false, retryAfterSeconds: 60 };
    }
    const row = result.rows[0] as { rate_limit_tokens: string | number; rate_limit_updated_at: Date | string };
    const elapsed = Math.max(0, now.getTime() - new Date(row.rate_limit_updated_at).getTime()) / 1_000;
    const available = Math.min(20, Number(row.rate_limit_tokens) + elapsed * 10);
    const allowed = available >= 1;
    const remaining = allowed ? available - 1 : available;
    await client.query('UPDATE devices SET rate_limit_tokens = $2, rate_limit_updated_at = GREATEST(rate_limit_updated_at, $3) WHERE id = $1', [deviceId, remaining, now]);
    await client.query('COMMIT');
    return { allowed, retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((1 - available) / 10)) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
