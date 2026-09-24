import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

function connectionString(): string {
  const value = process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
  const db = decodeURIComponent(new URL(value).pathname.replace(/^\//, ''));
  if (!db.endsWith('_test')) throw new Error('TEST_DATABASE_NAME_REQUIRED');
  return value;
}

async function withInstallDb<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  const schema = `device_install_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: connectionString(), max: 1 });
  const setup = await admin.connect();
  try { await setup.query(`CREATE SCHEMA ${schema}`); } finally { setup.release(); }
  const pool = new Pool({ connectionString: connectionString(), max: 4, options: `-c search_path=${schema}` });
  try {
    for (const file of [
      '001-quota.sql',
      '002-events.sql',
      '003-admin.sql',
      '004-device-registration.sql',
      '005-device-install-grants.sql',
    ]) {
      await pool.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
    }
    return await run(pool);
  } finally {
    await pool.end();
    const cleanup = await admin.connect();
    try { await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { cleanup.release(); await admin.end(); }
  }
}

const registrationKey = () => randomBytes(32).toString('base64url');
const registrationSecret = 'device-registration-secret-with-more-than-32-characters';

describe('one-time device install grants', () => {
  it('adopts an existing device identity once without storing its plain token', async () => {
    await withInstallDb(async pool => {
      const { adoptDeviceWithInstallGrant, createDeviceInstallGrant } = await import('../../src/server/events/devices');
      const grant = await createDeviceInstallGrant(pool);
      const request = new Request('https://dashboard.example/api/agent/register');
      const token = randomBytes(32).toString('base64url');
      const adopted = await adoptDeviceWithInstallGrant('Laptop', grant.token, 'old-device', token, request, pool);
      expect(adopted).toEqual({ status: 'ok', device: { id: 'old-device', name: 'Laptop', token } });
      expect((await pool.query('SELECT id, token_hash FROM devices')).rows).toEqual([
        { id: 'old-device', token_hash: createHash('sha256').update(token).digest('hex') },
      ]);
      expect(await adoptDeviceWithInstallGrant('Other', grant.token, 'other-device', randomBytes(32).toString('base64url'), request, pool))
        .toEqual({ status: 'invalid-grant' });
      const secondGrant = await createDeviceInstallGrant(pool);
      expect(await adoptDeviceWithInstallGrant('Laptop', secondGrant.token, 'old-device', token, request, pool))
        .toEqual({ status: 'conflict' });
    });
  });
  it('stores only a hash and permits one device, while an interrupted install can retry idempotently', async () => {
    await withInstallDb(async pool => {
      const { createDeviceInstallGrant, hasUsableDeviceInstallGrant, registerDeviceWithInstallGrant } = await import('../../src/server/events/devices');
      const issued = await createDeviceInstallGrant(pool);
      expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Date.parse(issued.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(Date.parse(issued.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);

      const stored = await pool.query('SELECT token_hash FROM device_install_grants');
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]?.token_hash).toBe(createHash('sha256').update(issued.token).digest('hex'));
      expect(stored.rows[0]?.token_hash).not.toBe(issued.token);

      const request = new Request('https://dashboard.example/api/agent/register');
      const key = registrationKey();
      const created = await registerDeviceWithInstallGrant('Mac mini', issued.token, key, registrationSecret, request, pool);
      expect(created).toMatchObject({ status: 'ok', device: { name: 'Mac mini' } });
      await expect(hasUsableDeviceInstallGrant(issued.token, pool)).resolves.toBe(true);

      const retry = await registerDeviceWithInstallGrant('Mac mini', issued.token, key, registrationSecret, request, pool);
      expect(retry).toEqual(created);
      const secondDevice = await registerDeviceWithInstallGrant('Linux', issued.token, registrationKey(), registrationSecret, request, pool);
      expect(secondDevice).toEqual({ status: 'invalid-grant' });
      expect((await pool.query('SELECT id FROM devices')).rows).toHaveLength(1);
    });
  });

  it('rejects an expired grant without creating a device', async () => {
    await withInstallDb(async pool => {
      const { createDeviceInstallGrant, hasUsableDeviceInstallGrant, registerDeviceWithInstallGrant } = await import('../../src/server/events/devices');
      const issued = await createDeviceInstallGrant(pool, new Date(Date.now() - 16 * 60_000));
      const request = new Request('https://dashboard.example/api/agent/register');
      await expect(hasUsableDeviceInstallGrant(issued.token, pool)).resolves.toBe(false);
      const outcome = await registerDeviceWithInstallGrant('Expired', issued.token, registrationKey(), registrationSecret, request, pool);
      expect(outcome).toEqual({ status: 'invalid-grant' });
      expect((await pool.query('SELECT id FROM devices')).rows).toHaveLength(0);
    });
  });
});
