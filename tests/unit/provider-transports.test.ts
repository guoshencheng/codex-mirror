import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSecretStore } from '../../src/server/providers/secret-store';
import { requestJson, ProviderTransportError } from '../../src/server/providers/http';
import { CodexRpc } from '../../src/server/providers/codex/rpc';
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

describe('CodexRpc', () => {
  it('initializes once, announces initialized, and matches the requested response id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-app-server-'));
    const executable = join(home, 'fake-codex');
    const source = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
rl.on('line', line => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n');
  } else if (req.method === 'initialized') {
    initialized = true;
  } else if (req.method === 'account/rateLimits/read' && initialized) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: {} }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 77, result: { ignored: true } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { rateLimitsByLimitId: { codex: { primary: null } } } }) + '\\n');
    setImmediate(() => process.exit(0));
  }
});`;
    await writeFile(executable, source, { mode: 0o700 });
    const raw = await new CodexRpc(home, executable).readRateLimits(new AbortController().signal, 1000);
    expect(raw).toEqual({ rateLimitsByLimitId: { codex: { primary: null } } });
  });

  it('times out a process that never answers and rejects an exited process', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-app-server-'));
    const silent = join(home, 'silent-codex');
    await writeFile(silent, '#!/usr/bin/env node\nprocess.stdin.resume();\n', { mode: 0o700 });
    await expect(new CodexRpc(home, silent).readRateLimits(new AbortController().signal, 30))
      .rejects.toMatchObject({ code: 'TIMEOUT' });

    const exited = join(home, 'exited-codex');
    await writeFile(exited, '#!/usr/bin/env node\nprocess.exit(7);\n', { mode: 0o700 });
    await expect(new CodexRpc(home, exited).readRateLimits(new AbortController().signal, 1000))
      .rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
