import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createAdminSession, requireAdmin } from '../../src/server/auth/session';
import { sessionCookieName } from '../../src/server/auth/cookie';
import { CodexLoginRepository } from '../../src/server/providers/codex/login-repository';
import { processCodexLoginOnce } from '../../src/worker/codex-login';

describe('Codex login worker', () => {
  it('persists a logged-in account and its first quota snapshot', async () => {
    const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
    const schema = `codex_worker_${randomUUID().replaceAll('-', '')}`;
    const adminPool = new Pool({ connectionString });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'codex-login-worker-'));
    try {
      for (const file of ['001-quota.sql', '003-admin.sql', '008-codex-login-requests.sql'])
        await pool.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
      await pool.query("INSERT INTO admins(id, username, password_hash) VALUES ('owner', 'owner', $1)", ['a'.repeat(40)]);
      const session = await createAdminSession('owner', pool);
      const admin = await requireAdmin(new Request('http://dashboard.test', { headers: { Cookie: `${sessionCookieName()}=${session.token}` } }), pool);
      const repository = new CodexLoginRepository(pool);
      const request = await repository.create(admin!.sessionId, 'Codex Personal');
      await processCodexLoginOnce(pool, new AbortController().signal, {
        runtimeRoot,
        login: async (_home, _signal, onCode) => {
          await onCode({ loginId: '11111111-1111-4111-8111-111111111111', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
          return { rateLimits: { rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1790200000 } } } };
        },
      });
      expect((await repository.read(request.id, admin!.sessionId))?.status).toBe('succeeded');
      const account = await pool.query(`SELECT a.provider_id, a.credential_ref, q.snapshot FROM provider_accounts a
        JOIN quota_latest q ON q.account_id = a.id WHERE a.id = $1`, [request.accountId]);
      expect(account.rows[0].provider_id).toBe('codex');
      expect(account.rows[0].credential_ref).toBe('managed-codex-login');
      expect(account.rows[0].snapshot.metrics[0].usedPercent).toBe(25);
      const failed = await repository.create(admin!.sessionId, 'Failed account');
      await processCodexLoginOnce(pool, new AbortController().signal, {
        runtimeRoot,
        login: async (_home, _signal, onCode) => {
          await onCode({ loginId: '22222222-2222-4222-8222-222222222222', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'EFGH-5678' });
          throw new Error('CODEX_AUTH_FAILED');
        },
      });
      expect((await repository.read(failed.id, admin!.sessionId))?.status).toBe('failed');
      expect((await pool.query('SELECT id FROM provider_accounts WHERE id = $1', [failed.accountId])).rowCount).toBe(0);
      await expect(access(join(runtimeRoot, failed.accountId))).rejects.toThrow();
      const forbidden = await repository.create(admin!.sessionId, 'Forbidden account');
      await processCodexLoginOnce(pool, new AbortController().signal, {
        runtimeRoot,
        login: async () => { throw new Error('CODEX_AUTH_FORBIDDEN'); },
      });
      expect((await repository.read(forbidden.id, admin!.sessionId))?.error).toBe('CODEX_AUTH_FORBIDDEN');
      const interrupted = await repository.create(admin!.sessionId, 'Interrupted account');
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const controller = new AbortController();
      const login = vi.fn(async () => { throw new Error('SHOULD_NOT_LOGIN'); });
      const task = processCodexLoginOnce(pool, controller.signal, {
        runtimeRoot,
        claim: async repo => { await gate; return repo.claimNext(); },
        login,
      });
      controller.abort();
      release();
      await task;
      expect(login).not.toHaveBeenCalled();
      expect((await repository.read(interrupted.id, admin!.sessionId))?.status).toBe('failed');
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
      await pool.end();
      await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
