import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const snapshot = { generatedAt: '2026-09-23T00:00:00.000Z', devices: [], sessions: [], accounts: [] };
vi.mock('../../src/server/read-model/dashboard', () => ({ getDashboard: vi.fn(async () => snapshot) }));
import { GET, OPTIONS } from '../../src/app/api/display/dashboard/route';

const directory = mkdtempSync(join(tmpdir(), 'display-api-test-'));
const path = join(directory, 'user-token');
const token = `cdu_${'a'.repeat(43)}`;

beforeEach(() => {
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  process.env.DASHBOARD_USER_TOKEN_FILE = path;
  process.env.DASHBOARD_DISPLAY_ORIGINS = 'https://display.example';
});
afterEach(() => {
  delete process.env.DASHBOARD_USER_TOKEN_FILE;
  delete process.env.DASHBOARD_DISPLAY_ORIGINS;
  rmSync(path, { force: true });
});

describe('display snapshot API', () => {
  it('returns a no-store snapshot for the configured Bearer Token', async () => {
    const response = await GET(new Request('https://api.example/api/display/dashboard', {
      headers: { authorization: `Bearer ${token}`, origin: 'https://display.example' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://display.example');
    expect(await response.json()).toEqual(snapshot);
  });

  it('rejects missing and incorrect Tokens', async () => {
    const missing = await GET(new Request('https://api.example/api/display/dashboard'));
    const incorrect = await GET(new Request('https://api.example/api/display/dashboard', {
      headers: { authorization: `Bearer cdu_${'b'.repeat(43)}` },
    }));
    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
  });

  it('does not allow an untrusted browser origin', async () => {
    const response = await GET(new Request('https://api.example/api/display/dashboard', {
      headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' },
    }));
    expect(response.status).toBe(403);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('answers a trusted browser preflight without exposing the Token', async () => {
    const response = await OPTIONS(new Request('https://api.example/api/display/dashboard', {
      method: 'OPTIONS', headers: { origin: 'https://display.example', 'access-control-request-method': 'GET' },
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toBe('Authorization');
  });
});
