import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSecretStore } from '../../src/server/providers/secret-store';
import { requestJson, ProviderTransportError } from '../../src/server/providers/http';
import { CodexUsageApi } from '../../src/server/providers/codex/usage-api';
import { KimiUsageClient } from '../../src/server/providers/kimi-code/client';

const servers: Server[] = [];

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('FileSecretStore', () => {
  it('refuses path traversal and symlinks outside the secret root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dashboard-secret-'));
    const root = await mkdtemp(join(parent, 'root-'));
    await writeFile(join(parent, 'outside'), 'SECRET_CANARY');
    await symlink(join(parent, 'outside'), join(root, 'escape'));

    const store = new FileSecretStore(root);
    await expect(store.read('../outside')).rejects.toThrow('INVALID_SECRET_REF');
    await expect(store.read('escape')).rejects.toThrow('INVALID_SECRET_REF');
  });
});

describe('requestJson', () => {
  it('maps authentication, permission, and rate limit failures without exposing bodies', async () => {
    for (const [status, code] of [[401, 'AUTH_EXPIRED'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED']] as const) {
      const url = await serve((_req, res) => {
        res.writeHead(status, { 'retry-after': '17' });
        res.end('SECRET_CANARY');
      });
      await expect(requestJson(`${url}/data`, { signal: AbortSignal.timeout(1000), timeoutMs: 1000 }))
        .rejects.toMatchObject({ code, retryAfterSeconds: status === 429 ? 17 : undefined });
      try {
        await requestJson(`${url}/data`, { signal: AbortSignal.timeout(1000), timeoutMs: 1000 });
      } catch (error) {
        expect(String(error)).not.toContain('SECRET_CANARY');
      }
    }

    const date = await serve((_req, res) => {
      res.writeHead(429, { 'retry-after': new Date(Date.now() + 45_000).toUTCString() }).end();
    });
    await expect(requestJson(date, { signal: AbortSignal.timeout(1000), timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: expect.any(Number) });
  });

  it('rejects redirects and oversized responses', async () => {
    const redirect = await serve((_req, res) => { res.writeHead(302, { location: '/next' }).end(); });
    await expect(requestJson(redirect, { signal: AbortSignal.timeout(1000), timeoutMs: 1000 }))
      .rejects.toBeInstanceOf(ProviderTransportError);

    const large = await serve((_req, res) => { res.end('x'.repeat(1024 * 1024 + 1)); });
    await expect(requestJson(large, { signal: AbortSignal.timeout(1000), timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: 'SCHEMA_CHANGED' });
  });

  it('distinguishes timeout and malformed JSON', async () => {
    const slow = await serve((_req, _res) => {});
    await expect(requestJson(slow, { signal: new AbortController().signal, timeoutMs: 25 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });

    const malformed = await serve((_req, res) => { res.end('{not-json'); });
    await expect(requestJson(malformed, { signal: AbortSignal.timeout(1000), timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: 'SCHEMA_CHANGED' });
  });
});

describe('KimiUsageClient', () => {
  it('uses the authenticated loopback usage endpoint and returns its envelope', async () => {
    let authorization = '';
    let requestPath = '';
    const baseUrl = await serve((req, res) => {
      authorization = String(req.headers.authorization);
      requestPath = String(req.url);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 0, data: { kind: 'ok', quota: { usages: {}, extraUsage: null } } }));
    });
    const raw = await new KimiUsageClient(baseUrl, 'token-canary').readUsage(new AbortController().signal);

    expect(authorization).toBe('Bearer token-canary');
    expect(requestPath).toBe('/api/v1/oauth/usage');
    expect(raw).toMatchObject({ data: { kind: 'ok' } });
    expect(() => new KimiUsageClient('http://example.com', 'token')).toThrow('KIMI_LOOPBACK_REQUIRED');
  });

  it('rejects an in-band provider error without returning its message', async () => {
    const baseUrl = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 0, data: { kind: 'error', status: 401, message: 'SECRET_CANARY' } }));
    });
    await expect(new KimiUsageClient(baseUrl, 'token').readUsage(new AbortController().signal))
      .rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  });
});

describe('CodexUsageApi', () => {
  const AUTH_DOC = {
    auth_mode: 'chatgpt',
    tokens: { access_token: 'access-canary', refresh_token: 'refresh-canary', account_id: 'account-canary' },
  };

  async function authHome(doc: unknown = AUTH_DOC): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'codex-usage-'));
    await writeFile(join(home, 'auth.json'), JSON.stringify(doc), { mode: 0o600 });
    return home;
  }

  it('reads usage with the stored bearer token and normalizes both windows', async () => {
    let authorization = '';
    let accountId = '';
    const usageUrl = await serve((req, res) => {
      authorization = String(req.headers.authorization);
      accountId = String(req.headers['chatgpt-account-id']);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 72, limit_window_seconds: 18000, reset_at: 1_700_000_000 },
          secondary_window: { used_percent: 38, limit_window_seconds: 604800, reset_at: '2026-08-18T00:00:00Z' },
        },
      }));
    });
    const home = await authHome();
    const raw = await new CodexUsageApi(home, usageUrl).readRateLimits(new AbortController().signal, 5000);

    expect(authorization).toBe('Bearer access-canary');
    expect(accountId).toBe('account-canary');
    expect(raw).toEqual({
      rateLimits: {
        primary: { usedPercent: 72, windowDurationMins: 300, resetsAt: 1_700_000_000 },
        secondary: { usedPercent: 38, windowDurationMins: 10080, resetsAt: Math.floor(Date.parse('2026-08-18T00:00:00Z') / 1000) },
      },
    });
  });

  it('refreshes an expired token, retries, and persists the new tokens', async () => {
    let usageCalls = 0;
    let refreshBody = '';
    const usageUrl = await serve((_req, res) => {
      usageCalls += 1;
      if (usageCalls === 1) { res.writeHead(401).end(); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: null } },
      }));
    });
    const refreshUrl = await serve(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      refreshBody = Buffer.concat(chunks).toString('utf8');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: 'access-renewed', refresh_token: 'refresh-renewed' }));
    });
    const home = await authHome();
    const raw = await new CodexUsageApi(home, usageUrl, refreshUrl).readRateLimits(new AbortController().signal, 5000);

    expect(usageCalls).toBe(2);
    expect(refreshBody).toContain('grant_type=refresh_token');
    expect(refreshBody).toContain('refresh_token=refresh-canary');
    expect(raw).toMatchObject({ rateLimits: { primary: { usedPercent: 5 } } });
    const persisted = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
    expect(persisted.tokens.access_token).toBe('access-renewed');
    expect(persisted.tokens.refresh_token).toBe('refresh-renewed');
    expect(persisted.tokens.account_id).toBe('account-canary');
  });

  it('fails without stored credentials or a usable refresh token', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'codex-usage-'));
    await expect(new CodexUsageApi(missing, 'http://127.0.0.1:1').readRateLimits(new AbortController().signal, 500))
      .rejects.toMatchObject({ code: 'AUTH_EXPIRED' });

    const usageUrl = await serve((_req, res) => { res.writeHead(401).end(); });
    const noRefresh = await authHome({ tokens: { access_token: 'access-canary', account_id: 'account-canary' } });
    await expect(new CodexUsageApi(noRefresh, usageUrl).readRateLimits(new AbortController().signal, 500))
      .rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  });

  it('rejects a malformed usage payload', async () => {
    const usageUrl = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ rate_limit: {} }));
    });
    const home = await authHome();
    await expect(new CodexUsageApi(home, usageUrl).readRateLimits(new AbortController().signal, 5000))
      .rejects.toMatchObject({ code: 'SCHEMA_CHANGED' });
  });
});
