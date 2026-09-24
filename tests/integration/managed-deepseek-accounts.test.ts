import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminSession } from '../../src/server/auth/session';
import { sessionCookieName } from '../../src/server/auth/cookie';
import { createDashboardHandlers } from '../../src/server/read-model/handlers';
import { QuotaRepository } from '../../src/server/quota/repository';
import { refreshDueAccountsOnce } from '../../src/worker/main';

const holder = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock('../../src/server/events/database', () => ({ eventDatabasePool: () => holder.pool }));
import { POST } from '../../src/app/api/provider-accounts/route';

const oldOrigin = process.env.APP_ORIGIN;
const oldKey = process.env.PROVIDER_CREDENTIAL_KEY;
afterEach(() => {
  vi.unstubAllGlobals();
  holder.pool = null;
  if (oldOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = oldOrigin;
  if (oldKey === undefined) delete process.env.PROVIDER_CREDENTIAL_KEY; else process.env.PROVIDER_CREDENTIAL_KEY = oldKey;
});

describe('managed API accounts', () => {
  it('saves DeepSeek and Kimi China accounts from one batch and reports failures by row', async () => {
    const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
    if (!decodeURIComponent(new URL(connectionString).pathname).endsWith('_test')) throw new Error('TEST_DATABASE_NAME_REQUIRED');
    const schema = `managed_accounts_${randomUUID().replaceAll('-', '')}`;
    const adminPool = new Pool({ connectionString });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    holder.pool = pool;
    try {
      for (const file of ['001-quota.sql', '002-events.sql', '003-admin.sql', '006-provider-credentials.sql', '007-configured-user-token.sql']) {
        await pool.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
      }
      const session = await createAdminSession('owner', pool);
      process.env.APP_ORIGIN = 'http://dashboard.test';
      process.env.PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString('base64url');
      vi.stubGlobal('fetch', vi.fn(async (url: string, options: { headers: Record<string, string> }) => {
        if (options.headers.Authorization === 'Bearer sk-valid') return Response.json({ is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' }] });
        if (url === 'https://api.kimi.com/coding/v1/usages' && options.headers.Authorization === 'Bearer sk-kimi-valid')
          return Response.json({ usage: { limit: '100', remaining: '75', resetTime: '2026-09-24T00:00:00Z' } });
        return Response.json({}, { status: 401 });
      }));
      const response = await POST(new Request('http://dashboard.test/api/provider-accounts', {
        method: 'POST', headers: { Origin: 'http://dashboard.test', Cookie: `${sessionCookieName()}=${session.token}`,
          'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ accounts: [
          { providerId: 'deepseek', label: 'Primary', apiKey: 'sk-valid' },
          { providerId: 'kimi-code-cn', label: 'Kimi China', apiKey: 'sk-kimi-valid' },
          { providerId: 'deepseek', label: 'Other', apiKey: 'sk-invalid' },
        ] }),
      }));
      expect(response.status).toBe(207);
      const body = await response.json() as { results: { ok: boolean; error?: string }[] };
      expect(body.results).toMatchObject([{ ok: true }, { ok: true }, { ok: false, error: 'AUTH_EXPIRED' }]);
      const stored = await pool.query(`SELECT a.id, a.label, a.provider_id, c.ciphertext, q.snapshot FROM provider_accounts a
        JOIN provider_credentials c ON c.account_id = a.id JOIN quota_latest q ON q.account_id = a.id`);
      expect(stored.rows).toHaveLength(2);
      const deepseek = stored.rows.find(row => row.provider_id === 'deepseek');
      const kimi = stored.rows.find(row => row.provider_id === 'kimi-code-cn');
      expect(deepseek.label).toBe('Primary');
      expect(deepseek.ciphertext).not.toContain('sk-valid');
      expect(deepseek.snapshot.metrics[0].total).toBe('12.34');
      expect(kimi.label).toBe('Kimi China');
      expect(kimi.ciphertext).not.toContain('sk-kimi-valid');
      expect(kimi.snapshot.metrics[0].usedPercent).toBe(25);
      const refresh = await createDashboardHandlers(pool).refresh(new Request(`http://dashboard.test/api/provider-accounts/${kimi.id}/refresh`, {
        method: 'POST', headers: { Origin: 'http://dashboard.test', Cookie: `${sessionCookieName()}=${session.token}`,
          'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: '{}',
      }), { params: Promise.resolve({ id: kimi.id }) });
      expect(refresh.status).toBe(200);
      expect(await refresh.json()).toMatchObject({ status: 'success' });
      await pool.query("UPDATE quota_refresh_status SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE account_id = $1", [deepseek.id]);
      const repository = new QuotaRepository(pool);
      expect(await repository.listDueAccounts(new Date(), 12)).toContain(deepseek.id);
      await refreshDueAccountsOnce(pool, repository, [], new AbortController().signal);
      const status = await pool.query('SELECT last_attempt_at, error_code, next_attempt_at FROM quota_refresh_status WHERE account_id = $1', [deepseek.id]);
      expect(status.rows[0].last_attempt_at).not.toBeNull();
      expect(status.rows[0].error_code).toBeNull();
      expect(new Date(status.rows[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    } finally {
      await pool.end();
      await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
