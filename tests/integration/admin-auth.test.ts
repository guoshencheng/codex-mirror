import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as getSession } from '../../src/app/api/auth/session/route';
import { POST as postLogin } from '../../src/app/api/auth/login/route';
import { POST as postLogout } from '../../src/app/api/auth/logout/route';
import { closeAuthDatabasePool } from '../../src/server/auth/database';
import { requireAdmin, verifyCsrf } from '../../src/server/auth/session';
import { createAdmin, updateAdminPassword } from '../../src/server/auth/admin';
import { serializeSessionCookie } from '../../src/server/auth/cookie';
import { createDevice } from '../../src/server/events/devices';

const TEST_PASSWORD = 'correct horse battery staple 7';

function testConnectionString(): string {
  const value = process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
  const database = decodeURIComponent(new URL(value).pathname.replace(/^\//, ''));
  if (!database.endsWith('_test')) throw new Error('TEST_DATABASE_NAME_REQUIRED');
  return value;
}

function requestFromIncoming(message: IncomingMessage, body: string): Request {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    headers.append(message.rawHeaders[index]!, message.rawHeaders[index + 1]!);
  }
  return new Request(`http://${message.headers.host}${message.url}`, {
    method: message.method,
    headers,
    ...(message.method === 'GET' || message.method === 'HEAD' ? {} : { body }),
  });
}

let server: Server;
let baseUrl: string;
let admin: Pool;
let pool: Pool;
let schema: string;

async function respond(message: IncomingMessage, body: string): Promise<Response> {
  const request = requestFromIncoming(message, body);
  const pathname = new URL(request.url).pathname;
  if (pathname === '/api/auth/login' && request.method === 'POST') return postLogin(request);
  if (pathname === '/api/auth/logout' && request.method === 'POST') return postLogout(request);
  if (pathname === '/api/auth/session' && request.method === 'GET') return getSession(request);
  if (pathname === '/api/test/protected' && request.method === 'GET') {
    const authenticated = await requireAdmin(request);
    return authenticated ? Response.json({ ok: true }) : Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  if (pathname === '/api/test/write' && request.method === 'POST') {
    const authenticated = await requireAdmin(request);
    if (!authenticated) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
    if (!await verifyCsrf(request, authenticated.sessionId)) return Response.json({ error: 'FORBIDDEN' }, { status: 403 });
    return new Response(null, { status: 204 });
  }
  return new Response('Not found', { status: 404 });
}

class AuthHttp {
  private cookie = '';
  csrfToken = '';

  constructor(readonly origin: string) {}

  async request(path: string, options: { method?: string; body?: unknown; csrf?: boolean; origin?: string } = {}): Promise<Response> {
    const method = options.method ?? 'GET';
    const headers = new Headers({ origin: options.origin ?? this.origin });
    if (this.cookie) headers.set('cookie', this.cookie);
    if (options.body !== undefined) {
      headers.set('content-type', 'application/json');
      if (options.csrf && this.csrfToken) headers.set('x-csrf-token', this.csrfToken);
    }
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: 'manual',
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';', 1)[0]!;
    return response;
  }

  async login(username = 'owner@example.test', password = TEST_PASSWORD, origin?: string): Promise<Response> {
    const response = await this.request('/api/auth/login', {
      method: 'POST', body: { username, password }, ...(origin ? { origin } : {}),
    });
    if (response.ok) this.csrfToken = String((await response.clone().json() as { csrfToken: string }).csrfToken);
    return response;
  }
}

describe('administrator authentication over HTTP', () => {
  beforeAll(async () => {
    schema = `admin_auth_test_${randomUUID().replaceAll('-', '')}`;
    admin = new Pool({ connectionString: testConnectionString(), max: 1 });
    const setup = await admin.connect();
    try { await setup.query(`CREATE SCHEMA ${schema}`); } finally { setup.release(); }
    pool = new Pool({ connectionString: testConnectionString(), max: 4, options: `-c search_path=${schema}` });
    for (const file of ['001-quota.sql', '002-events.sql', '003-admin.sql']) {
      await pool.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
    }

    const appDatabaseUrl = new URL(testConnectionString());
    appDatabaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = appDatabaseUrl.toString();
    process.env.APP_ORIGIN = 'http://127.0.0.1';
    process.env.AUTH_TRUSTED_CLIENT_IP_HEADER = 'x-test-client-ip';
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';

    server = createServer(async (message, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of message) chunks.push(Buffer.from(chunk));
      try {
        const result = await respond(message, Buffer.concat(chunks).toString('utf8'));
        response.statusCode = result.status;
        result.headers.forEach((value, key) => response.setHeader(key, value));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch {
        response.statusCode = 500;
        response.end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_NOT_LISTENING');
    baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.APP_ORIGIN = baseUrl;
    await createAdmin('owner@example.test', TEST_PASSWORD, pool);
  }, 30_000);

  beforeEach(async () => {
    await pool.query('DELETE FROM admin_sessions');
    await pool.query('DELETE FROM login_attempts');
  });

  afterAll(async () => {
    server?.close();
    await once(server, 'close').catch(() => undefined);
    await closeAuthDatabasePool();
    await pool?.end();
    if (admin && schema) {
      const cleanup = await admin.connect();
      try { await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); }
      finally { cleanup.release(); await admin.end(); }
    }
  });

  it('accepts a correct password and returns a secure session cookie without storing the raw tokens', async () => {
    const auth = new AuthHttp(baseUrl);
    const response = await auth.login();
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^dashboard_session=[A-Za-z0-9_-]{40,};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    const payload = await response.json() as { csrfToken: string; expiresAt: string };
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(payload.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(payload.expiresAt).toBeTruthy();
    expect(new Date(payload.expiresAt).getTime() - Date.now()).toBeGreaterThan(7 * 60 * 60 * 1_000);
    expect(new Date(payload.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(8 * 60 * 60 * 1_000);
    expect(payload).not.toHaveProperty('token');
    const session = await pool.query('SELECT token_hash, csrf_hash FROM admin_sessions');
    expect(session.rowCount).toBe(1);
    expect(session.rows[0]?.token_hash).not.toBe(setCookie.split('=', 2)[1]?.split(';', 1)[0]);
    expect(session.rows[0]?.csrf_hash).not.toBe(payload.csrfToken);
    expect((await auth.request('/api/test/protected')).status).toBe(200);
  });

  it('rejects a device bearer token as an administrator session', async () => {
    const device = await createDevice('test device', pool);
    const response = await fetch(`${baseUrl}/api/test/protected`, {
      headers: { authorization: `Bearer ${device.token}` }, redirect: 'manual',
    });
    expect(response.status).toBe(401);
  });

  it('uses the same unauthorized response for unknown users and incorrect passwords', async () => {
    const wrongPassword = await new AuthHttp(baseUrl).login('owner@example.test', 'wrong password 1234');
    const unknownUser = await new AuthHttp(baseUrl).login('not-an-admin@example.test', 'wrong password 1234');
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(await wrongPassword.text()).toBe(await unknownUser.text());
  });

  it('allows one administrator and enforces the password length and UTF-8 byte limits', async () => {
    await expect(createAdmin('another@example.test', TEST_PASSWORD, pool)).rejects.toThrow('ADMIN_ALREADY_EXISTS');
    await expect(createAdmin('another@example.test', 'short', pool)).rejects.toThrow('INVALID_ADMIN_PASSWORD');
    await expect(createAdmin('another@example.test', '🙂'.repeat(257), pool)).rejects.toThrow('INVALID_ADMIN_PASSWORD');
    expect(await pool.query('SELECT id FROM admins')).toMatchObject({ rowCount: 1 });
  });

  it('enforces the production cookie prefix and Secure attribute', () => {
    const env = process.env as Record<string, string | undefined>;
    const prior = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      expect(serializeSessionCookie('a'.repeat(43))).toContain('__Host-dashboard_session=');
      expect(serializeSessionCookie('a'.repeat(43))).toContain('; Secure');
    } finally {
      env.NODE_ENV = prior;
    }
  });

  it('limits failed login attempts by trusted client IP and account for 15 minutes', async () => {
    const responses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          origin: baseUrl,
          'content-type': 'application/json',
          'x-test-client-ip': '203.0.113.8',
          'x-forwarded-for': `198.51.100.${attempt + 1}`,
        },
        body: JSON.stringify({ username: 'owner@example.test', password: 'wrong password 1234' }),
      });
      responses.push(response.status);
    }
    expect(responses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('requires exact same-origin JSON login and rejects cross-origin writes', async () => {
    const wrongOrigin = await new AuthHttp(baseUrl).login('owner@example.test', TEST_PASSWORD, 'https://evil.example');
    expect(wrongOrigin.status).toBe(403);
    const auth = new AuthHttp(baseUrl);
    await auth.login();
    expect((await auth.request('/api/test/write', { method: 'POST', body: {}, csrf: true, origin: 'https://evil.example' })).status).toBe(403);
    expect((await auth.request('/api/test/write', { method: 'POST', body: {}, csrf: false })).status).toBe(403);
  });

  it('rejects malformed or duplicate Origin values', async () => {
    const duplicate = new Request(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: [['origin', baseUrl], ['origin', 'https://evil.example'], ['content-type', 'application/json']],
      body: JSON.stringify({ username: 'owner@example.test', password: TEST_PASSWORD }),
    });
    const malformed = new Request(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { origin: `${baseUrl}/unexpected-path`, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner@example.test', password: TEST_PASSWORD }),
    });
    expect((await postLogin(duplicate)).status).toBe(403);
    expect((await postLogin(malformed)).status).toBe(403);
  });

  it('caps streamed login bodies when Content-Length is absent', async () => {
    let cancelled = false;
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) controller.enqueue(new TextEncoder().encode('x'.repeat(5_000)));
        else {
          controller.enqueue(new TextEncoder().encode('additional data'));
          controller.close();
        }
      },
      cancel() { cancelled = true; },
    });
    const streamed = new Request(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect((await postLogin(streamed)).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(reads).toBe(1);

    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner@example.test', password: 'x'.repeat(5_000) }),
    });
    expect(response.status).toBe(413);
  });

  it('rejects a session after expiry and deletes it when logging out', async () => {
    const auth = new AuthHttp(baseUrl);
    await auth.login();
    const row = await pool.query('SELECT id FROM admin_sessions LIMIT 1');
    await pool.query(`UPDATE admin_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = $1`, [row.rows[0]?.id]);
    expect((await auth.request('/api/auth/session')).status).toBe(401);

    await auth.login();
    expect((await auth.request('/api/auth/logout', { method: 'POST', body: {}, csrf: true })).status).toBe(204);
    expect((await auth.request('/api/auth/session')).status).toBe(401);
    expect((await auth.request('/api/test/protected')).status).toBe(401);
  });

  it('revokes every existing session when the administrator password is updated', async () => {
    const auth = new AuthHttp(baseUrl);
    await auth.login();
    await auth.login();
    expect(await pool.query('SELECT id FROM admin_sessions')).toMatchObject({ rowCount: 2 });
    expect(await updateAdminPassword('owner', 'a different long secure password 8', pool)).toBe(true);
    expect((await auth.request('/api/test/protected')).status).toBe(401);
    const updated = await new AuthHttp(baseUrl).login('owner@example.test', 'a different long secure password 8');
    expect(updated.status).toBe(200);
    expect(await pool.query('SELECT id FROM admin_sessions')).toMatchObject({ rowCount: 1 });
  });
});
