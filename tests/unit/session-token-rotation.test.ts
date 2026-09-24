import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createAdminSession, requireAdmin } from '../../src/server/auth/session';
import { sessionCookieName } from '../../src/server/auth/cookie';

const directory = mkdtempSync(join(tmpdir(), 'dashboard-session-test-'));
const tokenFile = join(directory, 'token');

afterEach(() => {
  delete process.env.DASHBOARD_USER_TOKEN_FILE;
  rmSync(tokenFile, { force: true });
});

it('invalidates an existing admin session when the configured user Token rotates', async () => {
  process.env.DASHBOARD_USER_TOKEN_FILE = tokenFile;
  writeFileSync(tokenFile, `cdu_${'a'.repeat(43)}\n`, { mode: 0o600 });
  const query = vi.fn(async (sql: string) => sql.startsWith('SELECT')
    ? { rows: [{ session_id: 'session-id', admin_id: 'owner' }] }
    : { rows: [] });
  const pool = { query } as unknown as Pool;
  const session = await createAdminSession('owner', pool);
  const request = new Request('https://dashboard.example/', {
    headers: { cookie: `${sessionCookieName()}=${session.token}` },
  });
  expect(await requireAdmin(request, pool)).toEqual({ id: 'owner', sessionId: 'session-id' });
  const before = query.mock.calls.length;
  writeFileSync(tokenFile, `cdu_${'b'.repeat(43)}\n`, { mode: 0o600 });
  expect(await requireAdmin(request, pool)).toBeNull();
  expect(query).toHaveBeenCalledTimes(before);
});
