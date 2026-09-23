import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createAdminSession, requireAdmin } from '../../src/server/auth/session';
import { sessionCookieName } from '../../src/server/auth/cookie';
import { CodexLoginRepository } from '../../src/server/providers/codex/login-repository';
import { QuotaRepository } from '../../src/server/quota/repository';

describe('Codex login requests', () => {
  it('isolates requests by session, claims once, and preserves managed accounts', async () => {
    const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
    const schema = `codex_login_${randomUUID().replaceAll('-', '')}`;
    const adminPool = new Pool({ connectionString });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    try {
      for (const file of ['001-quota.sql', '003-admin.sql', '008-codex-login-requests.sql'])
        await pool.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
      await pool.query("INSERT INTO admins(id, username, password_hash) VALUES ('owner', 'owner', $1)", ['a'.repeat(40)]);
      const first = await createAdminSession('owner', pool);
      const second = await createAdminSession('owner', pool);
      const getSession = async (token: string) => (await requireAdmin(new Request('http://dashboard.test', {
        headers: { Cookie: `${sessionCookieName()}=${token}` },
      }), pool))!.sessionId;
      const firstId = await getSession(first.token);
      const secondId = await getSession(second.token);
      const repository = new CodexLoginRepository(pool);
      const request = await repository.create(firstId, 'Personal');
      expect(request.status).toBe('queued');
      expect(await repository.read(request.id, secondId)).toBeNull();
      await expect(repository.create(firstId, 'Again')).rejects.toThrow('LOGIN_IN_PROGRESS');
      expect((await repository.claimNext())?.id).toBe(request.id);
      expect(await repository.claimNext()).toBeNull();
      await pool.query("INSERT INTO provider_accounts(id, provider_id, label, credential_ref) VALUES ($1, 'codex', 'Personal', 'managed-codex-login')", [request.accountId]);
      await new QuotaRepository(pool).upsertConfiguredAccounts([]);
      const account = await pool.query('SELECT enabled FROM provider_accounts WHERE id = $1', [request.accountId]);
      expect(account.rows[0].enabled).toBe(true);
    } finally {
      await pool.end();
      await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
