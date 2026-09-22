import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/contracts/events';
import type { ProviderSnapshot } from '../../src/contracts/quota';
import { createAdmin } from '../../src/server/auth/admin';
import { sessionCookieName } from '../../src/server/auth/cookie';
import { createAdminSession } from '../../src/server/auth/session';
import { createDashboardHandlers } from '../../src/server/read-model/handlers';
import { getDashboard } from '../../src/server/read-model/dashboard';
import { ingestBatch, recordHeartbeat } from '../../src/server/events/ingest';
import { createDevice } from '../../src/server/events/devices';

const appOrigin = 'http://dashboard.test';
const password = 'correct horse battery staple 7';
const sessionCookie = (token: string) => `${sessionCookieName()}=${token}`;
const previousOrigin = process.env.APP_ORIGIN;

function testConnectionString(): string {
  const value = process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
  const database = decodeURIComponent(new URL(value).pathname.replace(/^\//, ''));
  if (!database.endsWith('_test')) throw new Error('TEST_DATABASE_NAME_REQUIRED');
  return value;
}

async function withDashboardDb<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  const schema = `dashboard_read_test_${randomUUID().replaceAll('-', '')}`;
  const connectionString = testConnectionString();
  const admin = new Pool({ connectionString, max: 1 });
  const setup = await admin.connect();
  try { await setup.query(`CREATE SCHEMA ${schema}`); } finally { setup.release(); }
  const pool = new Pool({ connectionString, max: 10, options: `-c search_path=${schema}` });
  process.env.APP_ORIGIN = appOrigin;
  try {
    for (const file of ['001-quota.sql', '002-events.sql', '003-admin.sql']) {
      await pool.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
    }
    await createAdmin('owner@example.test', password, pool);
    return await run(pool);
  } finally {
    await pool.end();
    const cleanup = await admin.connect();
    try { await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { cleanup.release(); await admin.end(); }
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousOrigin;
  }
}

async function addAccount(pool: Pool, devices: string[]): Promise<void> {
  await pool.query(`INSERT INTO provider_accounts(id, provider_id, label, credential_ref, options)
    VALUES ('account-a', 'deepseek', 'DeepSeek', 'file:SECRET_CANARY', '{"apiKey":"SECRET_CANARY"}'::jsonb)`);
  await pool.query("INSERT INTO quota_refresh_status(account_id) VALUES ('account-a')");
  await pool.query(`INSERT INTO quota_latest(account_id, snapshot) VALUES ('account-a', $1::jsonb)`, [JSON.stringify({
    accountId: 'account-a', providerId: 'deepseek', observedAt: '2026-09-22T01:00:00.000Z', serviceAvailable: true,
    metrics: [{ kind: 'balance', key: 'balance:CNY', label: '余额', currency: 'CNY', total: '0.00', granted: '0.00', toppedUp: '0.00' }],
  } satisfies ProviderSnapshot)]);
  for (const id of devices) await pool.query('INSERT INTO device_account_links(device_id, account_id) VALUES ($1, $2)', [id, 'account-a']);
}

async function seedTurn(pool: Pool, deviceId: string, at: string): Promise<void> {
  const event: AgentEvent = {
    schemaVersion: 1, eventId: `evt-${deviceId}`, deviceId, collectorEpoch: `epoch-${deviceId}`,
    sequence: 1, sessionId: `session-${deviceId}`, turnId: 'turn-1', type: 'turn.started',
    occurredAt: at, metadata: { projectKey: 'repo:abc', projectName: 'dashboard', title: 'check status' },
  };
  await recordHeartbeat(deviceId, {
    epoch: event.collectorEpoch, bootId: `boot-${deviceId}`, queuedThrough: 0, queueDepth: 0, eventLoss: false,
  }, at, { pool });
  await ingestBatch(deviceId, { epoch: event.collectorEpoch, events: [event] }, { pool, receivedAt: at });
}

describe('dashboard read model and admin APIs', () => {
  afterEach(() => {
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousOrigin;
  });

  it('returns a consistent device/session/account snapshot without secrets', async () => {
    await withDashboardDb(async pool => {
      const first = await createDevice('Laptop', pool);
      const second = await createDevice('Workstation', pool);
      await addAccount(pool, [first.id, second.id]);
      const now = new Date('2026-09-22T01:00:00.000Z');
      await seedTurn(pool, first.id, new Date(now.getTime() - 10_000).toISOString());
      const priorAt = new Date(now.getTime() - 130_000).toISOString();
      await seedTurn(pool, second.id, priorAt);
      await recordHeartbeat(second.id, {
        epoch: 'epoch-next', bootId: 'boot-next', queuedThrough: 0, queueDepth: 0, eventLoss: true,
      }, new Date(now.getTime() - 125_000).toISOString(), { pool });

      const dashboard = await getDashboard(now, pool);
      expect(dashboard.devices).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: first.id, connection: 'online', streamIncomplete: false }),
        expect.objectContaining({ id: second.id, connection: 'offline', streamIncomplete: true }),
      ]));
      expect(dashboard.sessions).toEqual(expect.arrayContaining([expect.objectContaining({
        id: `session-${first.id}`, deviceId: first.id, projectId: 'repo:abc', projectName: 'dashboard',
        title: 'check status', state: 'WORKING', confidence: 'confirmed', currentTool: null,
      }), expect.objectContaining({
        id: `session-${second.id}`, deviceId: second.id, state: 'WORKING', confidence: 'unconfirmed',
      })]));
      expect(dashboard.accounts).toEqual([expect.objectContaining({
        id: 'account-a', providerId: 'deepseek', deviceIds: [first.id, second.id].sort(), refreshStatus: 'idle',
        snapshot: expect.objectContaining({ metrics: [expect.objectContaining({ total: '0.00' })] }),
      })]);
      expect(JSON.stringify(dashboard)).not.toContain('SECRET_CANARY');
      expect(dashboard.accounts[0]).not.toHaveProperty('credentialRef');
      expect(dashboard.accounts[0]).not.toHaveProperty('options');
    });
  });

  it('protects read APIs and queues manual quota refresh only after CSRF validation', async () => {
    await withDashboardDb(async pool => {
      const handlers = createDashboardHandlers(pool);
      const denied = await handlers.dashboard(new Request(`${appOrigin}/api/dashboard`));
      expect(denied.status).toBe(401);
      const device = await createDevice('Laptop', pool);
      await addAccount(pool, [device.id]);
      const session = await createAdminSession('owner', pool);
      const authHeaders = { cookie: sessionCookie(session.token) };
      const dashboard = await handlers.dashboard(new Request(`${appOrigin}/api/dashboard`, { headers: authHeaders }));
      expect(dashboard.status).toBe(200);
      expect(dashboard.headers.get('cache-control')).toContain('no-store');
      const accountResponse = await handlers.accounts(new Request(`${appOrigin}/api/provider-accounts`, { headers: authHeaders }));
      expect(accountResponse.status).toBe(200);
      expect(JSON.stringify(await accountResponse.json())).not.toContain('SECRET_CANARY');

      const post = (csrf?: string) => handlers.refresh(new Request(`${appOrigin}/api/provider-accounts/account-a/refresh`, {
        method: 'POST', headers: { ...authHeaders, origin: appOrigin, ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      }), { params: Promise.resolve({ id: 'account-a' }) });
      expect((await post()).status).toBe(403);
      const workerLock = await pool.connect();
      try {
        await workerLock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', ['account-a']);
        const running = await post(session.csrfToken);
        expect(running.status).toBe(202);
        expect(await running.json()).toEqual({ status: 'running' });
      } finally {
        await workerLock.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['account-a']).catch(() => undefined);
        workerLock.release();
      }
      expect((await post(session.csrfToken)).status).toBe(202);
      const cooldown = await post(session.csrfToken);
      expect(cooldown.status).toBe(429);
      expect(cooldown.headers.get('retry-after')).toBe('30');
      const missing = await handlers.refresh(new Request(`${appOrigin}/api/provider-accounts/no-account/refresh`, {
        method: 'POST', headers: { ...authHeaders, origin: appOrigin, 'x-csrf-token': session.csrfToken },
      }), { params: Promise.resolve({ id: 'no-account' }) });
      expect(missing.status).toBe(404);
    });
  });
});
