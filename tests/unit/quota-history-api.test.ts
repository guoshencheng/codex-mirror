import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { QuotaHistoryDto } from '../../src/contracts/quota-history';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  readQuotaHistory: vi.fn(),
  matchesConfiguredUserToken: vi.fn(),
}));
vi.mock('../../src/server/auth/session', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../src/server/quota/history', () => ({
  readQuotaHistory: mocks.readQuotaHistory,
  isQuotaHistoryRange: (value: unknown) => value === '24h' || value === '7d' || value === '30d' || value === '90d',
}));
vi.mock('../../src/server/auth/configured-token', () => ({ matchesConfiguredUserToken: mocks.matchesConfiguredUserToken }));

import { createQuotaHistoryHandlers } from '../../src/server/quota/history-handlers';
import { authorizeDisplayRequest, displayPreflight } from '../../src/server/auth/display';

const now = new Date('2026-09-29T00:00:00.000Z');
const token = `cdu_${'a'.repeat(43)}`;
const dto: QuotaHistoryDto = {
  accountId: 'account-a', range: '7d', from: '2026-09-22T00:00:00.000Z', to: now.toISOString(), generatedAt: now.toISOString(),
  retentionDays: 90, bucketSeconds: 7200,
  series: [{ id: '["quota-window","primary",18000]', key: 'primary', label: '主窗口', kind: 'quota-window', unit: '%', windowDurationSeconds: 18000,
    points: [{ observedAt: '2026-09-28T00:00:00.000Z', value: 72, resetsAt: null, breakBefore: true }] }],
};

afterEach(() => {
  delete process.env.DASHBOARD_DISPLAY_ORIGINS;
  delete process.env.APP_ORIGIN;
  vi.clearAllMocks();
});

describe('quota history HTTP handlers', () => {
  it('serves the same bounded DTO to an authenticated admin', async () => {
    mocks.requireAdmin.mockResolvedValue({ id: 'admin', sessionId: 'session' });
    mocks.readQuotaHistory.mockResolvedValue(dto);
    const handlers = createQuotaHistoryHandlers({} as Pool, () => now);
    const response = await handlers.admin(new Request('https://dashboard.test/api/provider-accounts/account-a/history?range=7d'), {
      params: Promise.resolve({ id: 'account-a' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(dto);
    expect(mocks.readQuotaHistory).toHaveBeenCalledWith(expect.anything(), 'account-a', '7d', now);
  });

  it('rejects invalid ranges, duplicate ranges, and unavailable accounts without querying history', async () => {
    mocks.requireAdmin.mockResolvedValue({ id: 'admin', sessionId: 'session' });
    const handlers = createQuotaHistoryHandlers({} as Pool, () => now);
    expect((await handlers.admin(new Request('https://dashboard.test/api/provider-accounts/account-a/history?range=2h'), {
      params: Promise.resolve({ id: 'account-a' }),
    })).status).toBe(400);
    expect((await handlers.admin(new Request('https://dashboard.test/api/provider-accounts/account-a/history?range=7d&range=24h'), {
      params: Promise.resolve({ id: 'account-a' }),
    })).status).toBe(400);
    mocks.readQuotaHistory.mockResolvedValue(null);
    expect((await handlers.admin(new Request('https://dashboard.test/api/provider-accounts/missing/history'), {
      params: Promise.resolve({ id: 'missing' }),
    })).status).toBe(404);
    expect(mocks.readQuotaHistory).toHaveBeenCalledTimes(1);
  });

  it('keeps admin and display authentication separate and applies display CORS rules', async () => {
    mocks.requireAdmin.mockResolvedValue(null);
    const handlers = createQuotaHistoryHandlers({} as Pool, () => now);
    expect((await handlers.admin(new Request('https://dashboard.test/api/provider-accounts/account-a/history'), {
      params: Promise.resolve({ id: 'account-a' }),
    })).status).toBe(401);

    process.env.DASHBOARD_DISPLAY_ORIGINS = 'https://display.example';
    mocks.matchesConfiguredUserToken.mockReturnValue(true);
    mocks.readQuotaHistory.mockResolvedValue(dto);
    const display = await handlers.display(new Request('https://api.example/api/display/provider-accounts/account-a/history?range=7d', {
      headers: { authorization: `Bearer ${token}`, origin: 'https://display.example' },
    }), { params: Promise.resolve({ id: 'account-a' }) });
    expect(display.status).toBe(200);
    expect(display.headers.get('access-control-allow-origin')).toBe('https://display.example');
    expect(await display.json()).toEqual(dto);

    const evil = await handlers.display(new Request('https://api.example/api/display/provider-accounts/account-a/history', {
      headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' },
    }), { params: Promise.resolve({ id: 'account-a' }) });
    expect(evil.status).toBe(403);
    const missing = await handlers.display(new Request('https://api.example/api/display/provider-accounts/account-a/history'), {
      params: Promise.resolve({ id: 'account-a' }),
    });
    expect(missing.status).toBe(401);
  });

  it('handles trusted display preflight without exposing credentials', async () => {
    process.env.DASHBOARD_DISPLAY_ORIGINS = 'https://display.example';
    const response = displayPreflight(new Request('https://api.example/api/display/provider-accounts/account-a/history', {
      method: 'OPTIONS', headers: { origin: 'https://display.example', 'access-control-request-method': 'GET' },
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toBe('Authorization');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://display.example');
    expect(authorizeDisplayRequest(new Request('https://api.example/'))).toMatchObject({ response: expect.any(Response) });
  });
});
