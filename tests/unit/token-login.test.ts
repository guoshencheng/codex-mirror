import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticateAdmin } from '../../src/server/auth/login';
import { POST } from '../../src/app/api/auth/login/route';
import type { Pool } from 'pg';
vi.mock('../../src/server/auth/rate-limit', () => ({ consumeLoginAttempt: async () => ({ allowed: true }), clearLoginAttempts: async () => {}, trustedClientIp: () => '127.0.0.1' }));
vi.mock('../../src/server/auth/session', () => ({ createAdminSession: async () => ({ token: 'session', csrfToken: 'csrf', expiresAt: 'tomorrow' }) }));
vi.mock('../../src/server/auth/database', () => ({ authDatabasePool: () => ({ query: async () => ({ rows: [] }) }) }));
const token = 'cdu_' + 'a'.repeat(43);
const directory = mkdtempSync(join(tmpdir(), 'dashboard-login-test-'));
const tokenFile = join(directory, 'token');
describe('user Token authentication', () => {
  beforeEach(() => {
    process.env.APP_ORIGIN = 'https://dashboard.example';
    process.env.DASHBOARD_USER_TOKEN_FILE = tokenFile;
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  });
  afterEach(() => {
    delete process.env.DASHBOARD_USER_TOKEN_FILE;
    rmSync(tokenFile, { force: true });
  });
  it('authenticates with only a user Token and rejects incorrect and device tokens', async () => {
    const pool = { query: vi.fn() } as unknown as Pool;
    const request = new Request('https://dashboard.example/api/auth/login');
    expect((await authenticateAdmin(request, token, pool)).status).toBe('ok');
    expect((await authenticateAdmin(request, 'cdu_' + 'b'.repeat(43), pool)).status).toBe('invalid');
    expect((await authenticateAdmin(request, 'a'.repeat(43), pool)).status).toBe('invalid');
    expect(pool.query).not.toHaveBeenCalled();
  });
  it('rejects the old username/password HTTP payload', async () => {
    const request = new Request('https://dashboard.example/api/auth/login', { method: 'POST', headers: { origin: 'https://dashboard.example', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: token }) });
    expect((await POST(request)).status).toBe(400);
  });
});
