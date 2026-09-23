import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminSession } from '../../src/server/auth/session';
import { sessionCookieName } from '../../src/server/auth/cookie';

const holder = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock('../../src/server/events/database', () => ({ eventDatabasePool: () => holder.pool }));
import { POST } from '../../src/app/api/provider-accounts/codex-login/route';
import { GET, DELETE } from '../../src/app/api/provider-accounts/codex-login/[id]/route';

afterEach(() => { holder.pool = null; });

describe('Codex login routes', () => {
  it('requires admin, CSRF, and creator session', async () => {
    const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
    const schema = `codex_routes_${randomUUID().replaceAll('-', '')}`;
    const adminPool = new Pool({ connectionString });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    holder.pool = pool;
    const oldOrigin = process.env.APP_ORIGIN;
    try {
      for (const file of ['001-quota.sql', '003-admin.sql', '008-codex-login-requests.sql'])
        await pool.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
      await pool.query("INSERT INTO admins(id, username, password_hash) VALUES ('owner', 'owner', $1)", ['a'.repeat(40)]);
      const first = await createAdminSession('owner', pool);
      const second = await createAdminSession('owner', pool);
      process.env.APP_ORIGIN = 'http://dashboard.test';
      const base = 'http://dashboard.test/api/provider-accounts/codex-login';
      const post = (cookie?: string, csrf?: string, label = 'Personal') => POST(new Request(base, {
        method: 'POST', headers: { Origin: 'http://dashboard.test', 'Content-Type': 'application/json',
          ...(cookie ? { Cookie: `${sessionCookieName()}=${cookie}` } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
        body: JSON.stringify({ label }),
      }));
      expect((await post()).status).toBe(401);
      expect((await post(first.token)).status).toBe(403);
      expect((await post(first.token, first.csrfToken, '')).status).toBe(400);
      const created = await post(first.token, first.csrfToken);
      expect(created.status).toBe(202);
      expect(created.headers.get('cache-control')).toBe('private, no-store');
      const body = await created.json() as { id: string };
      const context = { params: Promise.resolve({ id: body.id }) };
      const other = await GET(new Request(`${base}/${body.id}`, { headers: { Cookie: `${sessionCookieName()}=${second.token}` } }), context);
      expect(other.status).toBe(404);
      const own = await GET(new Request(`${base}/${body.id}`, { headers: { Cookie: `${sessionCookieName()}=${first.token}` } }), context);
      expect(own.status).toBe(200);
      expect(await own.json()).toMatchObject({ status: 'queued', verificationUrl: null });
      const cancel = await DELETE(new Request(`${base}/${body.id}`, { method: 'DELETE', headers: {
        Origin: 'http://dashboard.test', Cookie: `${sessionCookieName()}=${first.token}`, 'X-CSRF-Token': first.csrfToken,
      } }), context);
      expect(cancel.status).toBe(200);
    } finally {
      if (oldOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = oldOrigin;
      await pool.end();
      await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
