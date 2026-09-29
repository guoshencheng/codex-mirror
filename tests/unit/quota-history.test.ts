import { describe, expect, it } from 'vitest';
import type { ProviderSnapshot } from '../../src/contracts/quota';
import type { QuotaHistoryRow } from '../../src/server/quota/repository';
import { buildQuotaHistory } from '../../src/server/quota/history';

const accountId = 'history-account';
const now = new Date('2026-09-29T00:00:00.000Z');

function row(at: string, snapshot: Partial<ProviderSnapshot> = {}): QuotaHistoryRow {
  return {
    id: String(Date.parse(at)),
    observedAt: at,
    snapshot: {
      accountId,
      providerId: 'fake',
      observedAt: at,
      serviceAvailable: true,
      metrics: [{ kind: 'quota-window', key: 'primary', label: '主窗口', usedPercent: 28, windowDurationSeconds: 18_000, resetsAt: null }],
      ...snapshot,
    },
  };
}

function series(dto: ReturnType<typeof buildQuotaHistory>, idPart: string) {
  return dto.series.find(item => item.id.includes(idPart));
}

describe('quota history series', () => {
  it('returns remaining percentage, range bucket sizes, and stable window series', () => {
    const dto = buildQuotaHistory(accountId, '24h', [row('2026-09-28T23:00:00.000Z')], now);
    expect(dto.from).toBe('2026-09-28T00:00:00.000Z');
    expect(dto.to).toBe(now.toISOString());
    expect(dto.bucketSeconds).toBe(300);
    expect(dto.retentionDays).toBe(90);
    expect(dto.series).toHaveLength(1);
    expect(dto.series[0]).toMatchObject({ kind: 'quota-window', unit: '%', windowDurationSeconds: 18_000 });
    expect(dto.series[0]?.points[0]).toMatchObject({ value: 72, breakBefore: true });
  });

  it('uses the designed sampling bucket for each history range', () => {
    const expected = { '24h': 300, '7d': 1_800, '30d': 7_200, '90d': 21_600 } as const;
    for (const [range, bucketSeconds] of Object.entries(expected) as Array<[keyof typeof expected, number]>) {
      expect(buildQuotaHistory(accountId, range, [row('2026-09-28T23:00:00.000Z')], now).bucketSeconds).toBe(bucketSeconds);
    }
  });

  it('marks missing metrics, service outages, and gaps beyond fifteen minutes as breaks', () => {
    const dto = buildQuotaHistory(accountId, '24h', [
      row('2026-09-28T20:00:00.000Z'),
      row('2026-09-28T20:05:00.000Z', { metrics: [] }),
      row('2026-09-28T20:10:00.000Z', { metrics: [{ kind: 'quota-window', key: 'primary', label: '主窗口', usedPercent: 40, windowDurationSeconds: 18_000, resetsAt: null }] }),
      row('2026-09-28T20:25:00.000Z', { metrics: [{ kind: 'quota-window', key: 'primary', label: '主窗口', usedPercent: 50, windowDurationSeconds: 18_000, resetsAt: null }] }),
      row('2026-09-28T20:40:00.000Z', { serviceAvailable: false }),
      row('2026-09-28T20:50:00.000Z', { metrics: [{ kind: 'quota-window', key: 'primary', label: '主窗口', usedPercent: 10, windowDurationSeconds: 18_000, resetsAt: null }] }),
    ], now);
    const points = series(dto, 'primary')!.points;
    expect(points.map(point => point.value)).toEqual([72, 60, 50, 90]);
    expect(points.map(point => point.breakBefore)).toEqual([true, true, false, true]);

    const exact = buildQuotaHistory(accountId, '24h', [
      row('2026-09-28T21:00:00.000Z', { metrics: [{ kind: 'quota-window', key: 'primary', label: '主窗口', usedPercent: 20, windowDurationSeconds: 18_000, resetsAt: null }] }),
      row('2026-09-28T21:15:00.000Z', { metrics: [{ kind: 'quota-window', key: 'primary', label: '主窗口', usedPercent: 30, windowDurationSeconds: 18_000, resetsAt: null }] }),
    ], now);
    expect(series(exact, 'primary')!.points.map(point => point.breakBefore)).toEqual([true, false]);

    const after = buildQuotaHistory(accountId, '24h', [
      row('2026-09-28T21:00:00.000Z'),
      row('2026-09-28T21:15:00.001Z', { metrics: [{ kind: 'quota-window', key: 'primary', label: '主窗口', usedPercent: 30, windowDurationSeconds: 18_000, resetsAt: null }] }),
    ], now);
    expect(series(after, 'primary')!.points[1]?.breakBefore).toBe(true);
  });

  it('splits window durations and currencies while preserving balance precision', () => {
    const dto = buildQuotaHistory(accountId, '7d', [row('2026-09-28T20:00:00.000Z', {
      metrics: [
        { kind: 'quota-window', key: 'primary', label: '5H', usedPercent: 10, windowDurationSeconds: 18_000, resetsAt: null },
        { kind: 'quota-window', key: 'primary', label: '周', usedPercent: 20, windowDurationSeconds: 604_800, resetsAt: null },
        { kind: 'balance', key: 'wallet', label: '余额', currency: 'USD', total: '9007199254740992.01', granted: null, toppedUp: null },
        { kind: 'balance', key: 'wallet', label: '余额', currency: 'CNY', total: '1.00', granted: null, toppedUp: null },
      ],
    }), row('2026-09-28T20:10:00.000Z', {
      metrics: [
        { kind: 'quota-window', key: 'primary', label: '5H', usedPercent: 90, windowDurationSeconds: 18_000, resetsAt: null },
        { kind: 'balance', key: 'wallet', label: '余额', currency: 'USD', total: '9007199254740992.02', granted: null, toppedUp: null },
      ],
    })], now);
    expect(dto.series.filter(item => item.key === 'primary')).toHaveLength(2);
    expect(dto.series.filter(item => item.kind === 'balance')).toHaveLength(2);
    expect(dto.series.find(item => item.kind === 'balance' && item.unit === 'USD')?.points.map(point => point.value)).toEqual([
      '9007199254740992.01', '9007199254740992.02',
    ]);
    expect(dto.series.find(item => item.kind === 'balance' && item.unit === 'CNY')?.points[0]?.breakBefore).toBe(true);
  });

  it('keeps reset peaks and propagates breaks through bucket sampling', () => {
    const rows = [
      row('2026-09-20T00:00:00.000Z', { metrics: [{ kind: 'quota-window', key: 'primary', label: '主窗口', usedPercent: 0, windowDurationSeconds: 18_000, resetsAt: null }] }),
      row('2026-09-20T00:10:00.000Z', { metrics: [{ kind: 'quota-window', key: 'primary', label: '主窗口', usedPercent: 100, windowDurationSeconds: 18_000, resetsAt: null }] }),
      row('2026-09-20T00:20:00.000Z', { metrics: [] }),
      row('2026-09-20T00:30:00.000Z', { metrics: [{ kind: 'quota-window', key: 'primary', label: '主窗口', usedPercent: 20, windowDurationSeconds: 18_000, resetsAt: null }] }),
    ];
    const dto = buildQuotaHistory(accountId, '30d', rows, now);
    const points = series(dto, 'primary')!.points;
    expect(points.map(point => point.value)).toEqual(expect.arrayContaining([100, 0, 80]));
    expect(points.some(point => point.breakBefore && point.value === 80)).toBe(true);
    expect(points.length).toBeLessThanOrEqual(1_444);
  });
});
