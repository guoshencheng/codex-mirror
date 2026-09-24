import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { eventDatabasePool } from './database';
import { consumeLoginAttempt, trustedClientIp } from '../auth/rate-limit';

export interface CreatedDevice {
  id: string;
  name: string;
  token: string;
}

export interface DeviceInstallGrant {
  token: string;
  expiresAt: string;
}

export type InstallGrantRegistration =
  | { status: 'ok'; device: CreatedDevice }
  | { status: 'invalid-grant' }
  | { status: 'conflict' }
  | { status: 'limited' };

export const DEVICE_INSTALL_GRANT_TTL_SECONDS = 15 * 60;

export async function createDevice(name: string, pool: Pool = eventDatabasePool()): Promise<CreatedDevice> {
  const label = name.trim();
  if (label.length < 1 || label.length > 120) throw new Error('INVALID_DEVICE_NAME');
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await pool.query('INSERT INTO devices(id, name, token_hash) VALUES ($1, $2, $3)', [id, label, tokenHash]);
  return { id, name: label, token };
}

export async function registerDevice(
  name: string,
  idempotencyKey: string,
  idempotencySecret: string,
  request: Request,
  pool: Pool = eventDatabasePool(),
): Promise<CreatedDevice | null> {
  const result = await registerDeviceInternal(name, idempotencyKey, idempotencySecret, request, pool);
  return result.status === 'ok' ? result.device : null;
}

export async function createDeviceInstallGrant(
  pool: Pool = eventDatabasePool(),
  now = new Date(),
): Promise<DeviceInstallGrant> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(now.getTime() + DEVICE_INSTALL_GRANT_TTL_SECONDS * 1_000);
  await pool.query('DELETE FROM device_install_grants WHERE expires_at <= $1 OR redeemed_at IS NOT NULL', [now]);
  await pool.query('INSERT INTO device_install_grants(token_hash, created_at, expires_at) VALUES ($1, $2, $3)', [tokenHash, now, expiresAt]);
  return { token, expiresAt: expiresAt.toISOString() };
}

export async function hasUsableDeviceInstallGrant(
  token: string,
  pool: Pool = eventDatabasePool(),
  now = new Date(),
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const result = await pool.query(`SELECT 1 FROM device_install_grants
    WHERE token_hash = $1 AND expires_at > $2`, [tokenHash, now]);
  return (result.rowCount ?? 0) === 1;
}

export async function registerDeviceWithInstallGrant(
  name: string,
  installGrant: string,
  idempotencyKey: string,
  idempotencySecret: string,
  request: Request,
  pool: Pool = eventDatabasePool(),
): Promise<InstallGrantRegistration> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(installGrant)) return { status: 'invalid-grant' };
  return registerDeviceInternal(name, idempotencyKey, idempotencySecret, request, pool, installGrant);
}

export async function adoptDeviceWithInstallGrant(
  name: string, installGrant: string, deviceId: string, deviceToken: string,
  request: Request, pool: Pool = eventDatabasePool(),
): Promise<InstallGrantRegistration> {
  const label = name.trim();
  if (label.length < 1 || label.length > 120 || !/^[A-Za-z0-9_-]{43}$/.test(installGrant) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId) || !/^[A-Za-z0-9_-]{32,256}$/.test(deviceToken)) {
    throw new Error('INVALID_DEVICE_REGISTRATION');
  }
  const grantHash = createHash('sha256').update(installGrant).digest('hex');
  const tokenHash = createHash('sha256').update(deviceToken).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const grant = await client.query(`SELECT token_hash FROM device_install_grants
      WHERE token_hash = $1 AND redeemed_at IS NULL AND expires_at > now() FOR UPDATE`, [grantHash]);
    if (grant.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { status: 'invalid-grant' };
    }
    const limit = await consumeLoginAttempt(trustedClientIp(request), 'device-registration', client);
    if (!limit.allowed) {
      await client.query('ROLLBACK');
      return { status: 'limited' };
    }
    const collision = await client.query('SELECT id FROM devices WHERE id = $1 OR token_hash = $2', [deviceId, tokenHash]);
    if (collision.rowCount) {
      await client.query('ROLLBACK');
      return { status: 'conflict' };
    }
    await client.query('INSERT INTO devices(id, name, token_hash) VALUES ($1, $2, $3)', [deviceId, label, tokenHash]);
    await client.query(`UPDATE device_install_grants SET redeemed_at = now(), device_id = $2
      WHERE token_hash = $1`, [grantHash, deviceId]);
    await client.query('COMMIT');
    return { status: 'ok', device: { id: deviceId, name: label, token: deviceToken } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') return { status: 'conflict' };
    throw error;
  } finally { client.release(); }
}

async function registerDeviceInternal(
  name: string,
  idempotencyKey: string,
  idempotencySecret: string,
  request: Request,
  pool: Pool,
  installGrant?: string,
): Promise<InstallGrantRegistration> {
  const label = name.trim();
  if (label.length < 1 || label.length > 120 || !/^[A-Za-z0-9_-]{43}$/.test(idempotencyKey)) throw new Error('INVALID_DEVICE_REGISTRATION');
  if (idempotencySecret.length < 32) throw new Error('DEVICE_REGISTRATION_SECRET_REQUIRED');
  const keyHash = createHash('sha256').update(idempotencyKey).digest('hex');
  const token = createHmac('sha256', idempotencySecret).update(idempotencyKey).digest('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const grantHash = installGrant ? createHash('sha256').update(installGrant).digest('hex') : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [keyHash]);
    const existing = await client.query(`SELECT d.id, d.name, d.token_hash, d.revoked_at
      FROM device_registrations r JOIN devices d ON d.id = r.device_id
      WHERE r.idempotency_hash = $1 FOR UPDATE OF d`, [keyHash]);
    if (existing.rowCount) {
      const row = existing.rows[0] as { id: string; name: string; token_hash: string; revoked_at: Date | null };
      if (row.revoked_at || row.token_hash !== tokenHash) {
        await client.query('ROLLBACK');
        return { status: installGrant ? 'invalid-grant' : 'limited' };
      }
      await client.query('COMMIT');
      return { status: 'ok', device: { id: row.id, name: row.name, token } };
    }

    if (grantHash) {
      const grant = await client.query(`SELECT token_hash FROM device_install_grants
        WHERE token_hash = $1 AND redeemed_at IS NULL AND expires_at > now() FOR UPDATE`, [grantHash]);
      if (grant.rowCount !== 1) {
        await client.query('ROLLBACK');
        return { status: 'invalid-grant' };
      }
    }

    const ip = trustedClientIp(request);
    const limit = await consumeLoginAttempt(ip, 'device-registration', client);
    if (!limit.allowed) {
      await client.query('ROLLBACK');
      return { status: 'limited' };
    }
    const id = randomUUID();
    await client.query('INSERT INTO devices(id, name, token_hash) VALUES ($1, $2, $3)', [id, label, tokenHash]);
    await client.query('INSERT INTO device_registrations(idempotency_hash, device_id) VALUES ($1, $2)', [keyHash, id]);
    if (grantHash) {
      const consumed = await client.query(`UPDATE device_install_grants SET redeemed_at = now(), device_id = $2
        WHERE token_hash = $1 AND redeemed_at IS NULL RETURNING token_hash`, [grantHash, id]);
      if (consumed.rowCount !== 1) {
        await client.query('ROLLBACK');
        return { status: 'invalid-grant' };
      }
    }
    await client.query('COMMIT');
    return { status: 'ok', device: { id, name: label, token } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeDevice(id: string, pool: Pool = eventDatabasePool()): Promise<boolean> {
  const result = await pool.query('UPDATE devices SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND revoked_at IS NULL', [id]);
  return (result.rowCount ?? 0) === 1;
}
