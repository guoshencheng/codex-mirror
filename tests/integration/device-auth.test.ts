import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { authenticateDevice, consumeDeviceRateLimit } from '../../src/server/events/device-auth';
import { createDevice, revokeDevice } from '../../src/server/events/devices';
import { createAgentHandlers } from '../../src/server/events/handlers';

function connectionString(): string {
  const value = process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
  const db = decodeURIComponent(new URL(value).pathname.replace(/^\//, ''));
  if (!db.endsWith('_test')) throw new Error('TEST_DATABASE_NAME_REQUIRED');
  return value;
}

async function withAuthDb<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  const schema = `device_auth_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: connectionString(), max: 1 });
  const setup = await admin.connect();
  try { await setup.query(`CREATE SCHEMA ${schema}`); } finally { setup.release(); }
  const pool = new Pool({ connectionString: connectionString(), max: 4, options: `-c search_path=${schema}` });
  try {
    for (const file of ['001-quota.sql', '002-events.sql']) {
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

describe('device bearer authentication', () => {
  it('returns the authenticated device ID for migration preflight without changing heartbeat state', async () => {
    await withAuthDb(async pool => {
      const created = await createDevice('Mac mini', pool);
      const request = new Request('https://dashboard.example/api/agent/identity', {
        headers: { authorization: `Bearer ${created.token}` },
      });
      const response = await createAgentHandlers(pool).identity(request);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ deviceId: created.id });
      expect(response.headers.get('cache-control')).toBe('no-store');
      const unknown = await createAgentHandlers(pool).identity(new Request(request.url, {
        headers: { authorization: `Bearer ${'x'.repeat(43)}` },
      }));
      expect(unknown.status).toBe(401);
      expect(await unknown.json()).toEqual({ error: 'UNAUTHORIZED' });
    });
  });
  it('creates a high-entropy one-time token and authenticates only its bearer', async () => {
    await withAuthDb(async pool => {
      const created = await createDevice('Mac mini', pool);
      expect(created.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      const request = new Request('https://dashboard.example/api/agent/events', { headers: { authorization: `Bearer ${created.token}` } });
      await expect(authenticateDevice(request, pool)).resolves.toEqual({ id: created.id });
      expect(await pool.query('SELECT token_hash FROM devices WHERE id = $1', [created.id]).then(result => result.rows[0]?.token_hash))
        .not.toBe(created.token);
    });
  });

  it('rejects missing, malformed, incorrect, and revoked credentials without exposing identity', async () => {
    await withAuthDb(async pool => {
      const created = await createDevice('Mac mini', pool);
      for (const authorization of [undefined, 'Basic abc', 'Bearer', 'Bearer invalid-token']) {
        const headers = new Headers();
        if (authorization) headers.set('authorization', authorization);
        await expect(authenticateDevice(new Request('https://dashboard.example/api/agent/events', { headers }), pool)).resolves.toBeNull();
      }
      await revokeDevice(created.id, pool);
      await expect(authenticateDevice(new Request('https://dashboard.example/api/agent/events', {
        headers: { authorization: `Bearer ${created.token}` },
      }), pool)).resolves.toBeNull();
    });
  });

  it('limits burst traffic per device and replenishes tokens by elapsed time', async () => {
    await withAuthDb(async pool => {
      const created = await createDevice('Mac mini', pool);
      const rate = await pool.query('SELECT rate_limit_updated_at FROM devices WHERE id = $1', [created.id]);
      const start = new Date(rate.rows[0]!.rate_limit_updated_at as string | Date);
      const outcomes = [];
      for (let count = 0; count < 21; count++) outcomes.push(await consumeDeviceRateLimit(created.id, pool, start));
      expect(outcomes.filter(value => value.allowed)).toHaveLength(20);
      expect(outcomes[20]?.allowed).toBe(false);
      expect(await consumeDeviceRateLimit(created.id, pool, new Date(start.getTime() + 1_000))).toMatchObject({ allowed: true });
    });
  });
});
