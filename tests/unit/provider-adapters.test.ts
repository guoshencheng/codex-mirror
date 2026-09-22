import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderAccountConfig, ProviderContext } from '../../src/contracts/quota';
import { CodexQuotaStrategy } from '../../src/server/providers/codex/strategy';
import { DeepSeekBalanceStrategy } from '../../src/server/providers/deepseek/strategy';
import { KimiCodeQuotaStrategy } from '../../src/server/providers/kimi-code/strategy';
import { ProviderRegistry } from '../../src/server/providers/registry';

const servers: Server[] = [];

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
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

function context(secret = 'test-token'): ProviderContext {
  return { signal: new AbortController().signal, readSecret: vi.fn(async () => secret) };
}

function account(providerId: string, options: Record<string, unknown> = {}): ProviderAccountConfig {
  return { id: 'primary', providerId, label: 'Primary', credentialRef: 'primary-secret', options };
}

describe('provider strategies', () => {
  it('registers each concrete adapter through the strategy interface', () => {
    const registry = new ProviderRegistry();
    registry.register(new CodexQuotaStrategy(() => ({ readRateLimits: async () => ({}) })));
    registry.register(new DeepSeekBalanceStrategy());
    registry.register(new KimiCodeQuotaStrategy());
    expect(registry.list().map(item => item.id)).toEqual(['codex', 'deepseek', 'kimi-code']);
  });

  it('queries the official DeepSeek balance path with the server secret', async () => {
    let authorization = '';
    let path = '';
    const url = await serve((request, response) => {
      authorization = String(request.headers.authorization);
      path = String(request.url);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ is_available: true, balance_infos: [
        { currency: 'USD', total_balance: '1.25', granted_balance: '0', topped_up_balance: '1.25' },
      ] }));
    });
    const strategy = new DeepSeekBalanceStrategy(`${url}/user/balance`, () => new Date('2026-09-22T00:00:00Z'));
    const credentials = context('deepseek-server-key');
    const result = await strategy.fetchSnapshot(account('deepseek'), credentials);

    expect(path).toBe('/user/balance');
    expect(authorization).toBe('Bearer deepseek-server-key');
    expect(credentials.readSecret).toHaveBeenCalledWith('primary-secret');
    expect(result).toMatchObject({ ok: true, snapshot: { providerId: 'deepseek', metrics: [{ total: '1.25' }] } });
  });

  it('delegates Codex reads to the configured account runtime without reading a token', async () => {
    const raw = JSON.parse(await readFile(join(process.cwd(), 'tests/fixtures/providers/codex-rate-limits.json'), 'utf8'));
    const readRateLimits = vi.fn(async () => raw);
    const strategy = new CodexQuotaStrategy(accountId => {
      expect(accountId).toBe('primary');
      return { readRateLimits };
    }, () => new Date('2026-09-22T00:00:00Z'));
    const result = await strategy.fetchSnapshot(account('codex'), context());
    expect(readRateLimits).toHaveBeenCalledOnce();
    if (!result.ok) throw new Error(`Codex fetch failed: ${result.error.code}`);
    expect(result.snapshot.providerId).toBe('codex');
    expect(result.snapshot.metrics[0]).toMatchObject({ key: 'codex:primary' });
  });

  it('queries Kimi usage through a loopback client with its server token', async () => {
    let authorization = '';
    let path = '';
    const url = await serve((request, response) => {
      authorization = String(request.headers.authorization);
      path = String(request.url);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ code: 0, data: { kind: 'ok', quota: { usages: {}, extraUsage: null } } }));
    });
    const credentials = context('kimi-loopback-token');
    const strategy = new KimiCodeQuotaStrategy(() => new Date('2026-09-22T00:00:00Z'));
    const result = await strategy.fetchSnapshot(account('kimi-code', { baseUrl: url }), credentials);

    expect(path).toBe('/api/v1/oauth/usage');
    expect(authorization).toBe('Bearer kimi-loopback-token');
    expect(credentials.readSecret).toHaveBeenCalledWith('primary-secret');
    expect(result).toMatchObject({ ok: true, snapshot: { providerId: 'kimi-code', metrics: [] } });
  });

  it('rejects unsupported config and never fetches from a remote Kimi host', async () => {
    const deepseek = new DeepSeekBalanceStrategy();
    const readSecret = vi.fn(async () => 'must-not-read');
    expect(deepseek.validateConfig(account('deepseek', { url: 'https://example.com' }))).not.toEqual([]);
    expect((await deepseek.fetchSnapshot(account('deepseek', { url: 'https://example.com' }), {
      signal: new AbortController().signal, readSecret,
    })).ok).toBe(false);
    expect(readSecret).not.toHaveBeenCalled();

    const kimi = new KimiCodeQuotaStrategy();
    expect(kimi.validateConfig(account('kimi-code', { baseUrl: 'https://example.com' }))).not.toEqual([]);
    expect(kimi.validateConfig(account('kimi-code', { extra: true }))).not.toEqual([]);
    expect(new CodexQuotaStrategy(() => ({ readRateLimits: async () => ({}) }))
      .validateConfig(account('codex', { home: '/tmp/attacker' }))).not.toEqual([]);
  });

  it('returns safe errors when API credentials are missing or permissions are denied', async () => {
    const missing = new DeepSeekBalanceStrategy('http://127.0.0.1:1/user/balance');
    const noSecret = await missing.fetchSnapshot(account('deepseek'), {
      signal: new AbortController().signal,
      readSecret: async () => { throw new Error('SECRET_NOT_FOUND'); },
    });
    expect(noSecret).toEqual({ ok: false, error: { code: 'AUTH_REQUIRED' } });

    const forbiddenUrl = await serve((_request, response) => response.writeHead(403).end());
    const forbidden = await new DeepSeekBalanceStrategy(`${forbiddenUrl}/user/balance`)
      .fetchSnapshot(account('deepseek'), context());
    expect(forbidden).toEqual({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});
