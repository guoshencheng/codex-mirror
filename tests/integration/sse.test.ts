import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdmin } from '../../src/server/auth/admin';
import { sessionCookieName } from '../../src/server/auth/cookie';
import { createAdminSession } from '../../src/server/auth/session';
import { createAdminStream } from '../../src/server/stream/sse';
import { PgNotificationHub } from '../../src/server/db/notifications';
import { createDashboardHandlers } from '../../src/server/read-model/handlers';
import { createDevice } from '../../src/server/events/devices';

const previousOrigin = process.env.APP_ORIGIN;

function testConnectionString(): string {
  const value = process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
  const database = decodeURIComponent(new URL(value).pathname.replace(/^\//, ''));
  if (!database.endsWith('_test')) throw new Error('TEST_DATABASE_NAME_REQUIRED');
  return value;
}

async function withSseDb<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  const schema = `dashboard_sse_test_${randomUUID().replaceAll('-', '')}`;
  const connectionString = testConnectionString();
  const admin = new Pool({ connectionString, max: 1 });
  const setup = await admin.connect();
  try { await setup.query(`CREATE SCHEMA ${schema}`); } finally { setup.release(); }
  const pool = new Pool({ connectionString, max: 10, options: `-c search_path=${schema}` });
  process.env.APP_ORIGIN = 'http://dashboard.test';
  try {
    for (const file of ['001-quota.sql', '002-events.sql', '003-admin.sql']) {
      await pool.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
    }
    await createAdmin('owner@example.test', 'correct horse battery staple 7', pool);
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

function eventName(frame: string): string {
  return /^event: (.+)$/m.exec(frame)?.[1] ?? '';
}

async function nextFrame(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 2_000): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SSE_READ_TIMEOUT')), timeoutMs); }),
    ]);
    if (result.done) return null;
    return new TextDecoder().decode(result.value);
  } finally { if (timer) clearTimeout(timer); }
}

describe('administrator server-sent events', () => {
  afterEach(() => {
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousOrigin;
  });

  it('sends an initial sync and only topic invalidations for committed PostgreSQL notifications', async () => {
    await withSseDb(async pool => {
      const session = await createAdminSession('owner', pool);
      const sessionId = await sessionIdFrom(pool, session.token);
      const appName = `sse-test-${randomUUID()}`;
      const hub = new PgNotificationHub(pool, { applicationName: appName, retryDelayMs: 20, maxRetryDelayMs: 100 });
      try {
        const response = await createAdminStream(new Request('http://dashboard.test/api/stream'), sessionId, {
          pool, hub, heartbeatMs: 60_000,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(response.headers.get('cache-control')).toContain('no-store');
        const reader = response.body!.getReader();
        expect(eventName((await nextFrame(reader))!)).toBe('sync');
        await pool.query("SELECT pg_notify('dashboard_changed', 'quota')");
        const invalidation = (await nextFrame(reader))!;
        expect(eventName(invalidation)).toBe('invalidate');
        expect(invalidation).toContain('"topic":"quota"');
        expect(invalidation).not.toContain('credential');
        await reader.cancel();
      } finally { await hub.close(); }
    });
  });

  it('sends a full sync after PostgreSQL LISTEN reconnects and closes after logout', async () => {
    await withSseDb(async pool => {
      const session = await createAdminSession('owner', pool);
      const sessionId = await sessionIdFrom(pool, session.token);
      const appName = `sse-reconnect-${randomUUID()}`;
      const hub = new PgNotificationHub(pool, { applicationName: appName, retryDelayMs: 20, maxRetryDelayMs: 100 });
      try {
        const response = await createAdminStream(new Request('http://dashboard.test/api/stream'), sessionId, {
          pool, hub, heartbeatMs: 25,
        });
        const reader = response.body!.getReader();
        expect(eventName((await nextFrame(reader))!)).toBe('sync');
        const listener = await pool.query("SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND state = 'idle'", [appName]);
        expect(listener.rowCount).toBe(1);
        await pool.query('SELECT pg_terminate_backend($1)', [(listener.rows[0] as { pid: number }).pid]);
        let reconnected = false;
        for (let attempt = 0; attempt < 8; attempt++) {
          const frame = await nextFrame(reader, 1_000);
          if (frame === null) break;
          if (eventName(frame) === 'sync') { reconnected = true; break; }
        }
        expect(reconnected).toBe(true);
        await pool.query('DELETE FROM admin_sessions WHERE id = $1', [sessionId]);
        let closed = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          if (await nextFrame(reader, 100) === null) { closed = true; break; }
        }
        expect(closed).toBe(true);
      } finally { await hub.close(); }
    });
  });

  it('protects SSE with the administrator cookie and enforces five concurrent connections', async () => {
    await withSseDb(async pool => {
      const session = await createAdminSession('owner', pool);
      const sessionId = await sessionIdFrom(pool, session.token);
      const device = await createDevice('agent', pool);
      const hub = new PgNotificationHub(pool, { applicationName: `sse-cap-${randomUUID()}`, retryDelayMs: 20, maxRetryDelayMs: 100 });
      const handlers = createDashboardHandlers(pool, { stream: { pool, hub, heartbeatMs: 60_000 } });
      try {
        const noCookie = await handlers.stream(new Request('http://dashboard.test/api/stream'));
        expect(noCookie.status).toBe(401);
        const deviceToken = await handlers.stream(new Request('http://dashboard.test/api/stream', {
          headers: { authorization: `Bearer ${device.token}` },
        }));
        expect(deviceToken.status).toBe(401);

        const opened = await Promise.all(Array.from({ length: 5 }, () => createAdminStream(
          new Request('http://dashboard.test/api/stream'), sessionId, { pool, hub, heartbeatMs: 60_000 },
        )));
        expect(opened.every(response => response.status === 200)).toBe(true);
        await expect(createAdminStream(new Request('http://dashboard.test/api/stream'), sessionId, {
          pool, hub, heartbeatMs: 60_000,
        })).rejects.toThrow('STREAM_LIMIT');
        const readers = opened.map(response => response.body!.getReader());
        await Promise.all(readers.map(reader => reader.cancel()));
        const afterClose = await createAdminStream(new Request('http://dashboard.test/api/stream'), sessionId, {
          pool, hub, heartbeatMs: 60_000,
        });
        expect(afterClose.status).toBe(200);
        await afterClose.body!.cancel();

        const cookieRequest = new Request('http://dashboard.test/api/stream', {
          headers: { cookie: `${sessionCookieName()}=${session.token}` },
        });
        const authenticated = await handlers.stream(cookieRequest);
        expect(authenticated.status).toBe(200);
        await authenticated.body!.cancel();
      } finally { await hub.close(); }
    });
  });
});

async function sessionIdFrom(pool: Pool, token: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(token).digest('hex');
  const result = await pool.query('SELECT id FROM admin_sessions WHERE token_hash = $1', [hash]);
  return String((result.rows[0] as { id: string }).id);
}
