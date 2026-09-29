import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQuotaHistoryLoader, parseQuotaHistory } from '../../src/lib/quota-history-client';

const now = '2026-09-29T00:00:00.000Z';
const body = {
  accountId: 'account/a', range: '7d', from: '2026-09-22T00:00:00.000Z', to: now, generatedAt: now,
  retentionDays: 90, bucketSeconds: 7200,
  series: [{ id: 'balance', key: 'wallet', label: '余额', kind: 'balance', unit: 'USD', windowDurationSeconds: null,
    points: [{ observedAt: now, value: '9007199254740992.01', resetsAt: null, breakBefore: true }] }],
} as const;

afterEach(() => vi.unstubAllGlobals());

describe('quota history client', () => {
  it('validates the DTO and preserves high precision balances', () => {
    expect(parseQuotaHistory(body)).toEqual(body);
    expect(() => parseQuotaHistory({ ...body, retentionDays: 91 })).toThrow('INVALID_QUOTA_HISTORY');
    expect(() => parseQuotaHistory({ ...body, series: [{ ...body.series[0], points: [{ ...body.series[0].points[0], value: 'NaN' }] }] })).toThrow('INVALID_QUOTA_HISTORY');
    expect(() => parseQuotaHistory({ ...body, series: [{ ...body.series[0], kind: 'quota-window', unit: '%', points: [{ ...body.series[0].points[0], value: 101 }] }] })).toThrow('INVALID_QUOTA_HISTORY');
  });

  it('loads same-origin and display-origin history with encoded accounts, signal, and no-store', async () => {
    const fetcher = vi.fn(async () => Response.json(body));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    await createQuotaHistoryLoader()('account/a', '7d', controller.signal);
    expect(fetcher).toHaveBeenCalledWith('/api/provider-accounts/account%2Fa/history?range=7d', expect.objectContaining({
      cache: 'no-store', signal: expect.any(AbortSignal),
    }));
    await createQuotaHistoryLoader({ apiOrigin: 'https://api.example', token: 'display-token' })('account/a', '7d', controller.signal);
    expect(fetcher).toHaveBeenLastCalledWith('https://api.example/api/display/provider-accounts/account%2Fa/history?range=7d', expect.objectContaining({
      headers: { Authorization: 'Bearer display-token' }, cache: 'no-store', signal: expect.any(AbortSignal),
    }));
  });

  it('turns HTTP and response identity failures into stable client errors', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(createQuotaHistoryLoader()('account-a', '24h', new AbortController().signal)).rejects.toThrow('QUOTA_HISTORY_503');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...body, accountId: 'other' })));
    await expect(createQuotaHistoryLoader()('account-a', '7d', new AbortController().signal)).rejects.toThrow('INVALID_QUOTA_HISTORY');
  });
});
