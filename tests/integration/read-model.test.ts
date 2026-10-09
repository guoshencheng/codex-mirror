import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderSnapshot } from '../../src/contracts/quota';
import { sessionCookieName } from '../../src/server/auth/cookie';
import { createAdminSession } from '../../src/server/auth/session';
import { createDashboardHandlers } from '../../src/server/read-model/handlers';
import { getDashboard } from '../../src/server/read-model/dashboard';

const appOrigin = 'http://dashboard.test';
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
    for (const file of ['001-quota.sql', '003-admin.sql', '007-configured-user-token.sql']) {
      await pool.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
    }
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

async function addAccount(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO provider_accounts(id, provider_id, label, credential_ref, options)
    VALUES ('account-a', 'deepseek', 'DeepSeek', 'file:SECRET_CANARY', '{"apiKey":"SECRET_CANARY"}'::jsonb)`);
  await pool.query("INSERT INTO quota_refresh_status(account_id) VALUES ('account-a')");
  await pool.query(`INSERT INTO quota_latest(account_id, snapshot) VALUES ('account-a', $1::jsonb)`, [JSON.stringify({
    accountId: 'account-a', providerId: 'deepseek', observedAt: '2026-09-22T01:00:00.000Z', serviceAvailable: true,
    metrics: [{ kind: 'balance', key: 'balance:CNY', label: '余额', currency: 'CNY', total: '0.00', granted: '0.00', toppedUp: '0.00' }],
  } satisfies ProviderSnapshot)]);
}

describe('Provider quota read model and admin APIs', () => {
  afterEach(() => {
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousOrigin;
  });

  it('returns provider quota snapshots without secrets or device/session data', async () => {
    await withDashboardDb(async pool => {
      await addAccount(pool);
      const now = new Date('2026-09-22T01:00:00.000Z');
      const dashboard = await getDashboard(now, pool);
      expect(dashboard).toEqual({ generatedAt: now.toISOString(), accounts: [expect.objectContaining({
        id: 'account-a', providerId: 'deepseek', label: 'DeepSeek', refreshStatus: 'idle',
        snapshot: expect.objectContaining({ metrics: [expect.objectContaining({ total: '0.00' })] }),
      })] });
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
      await addAccount(pool);
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
