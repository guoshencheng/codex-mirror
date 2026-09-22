import { describe, expect, it } from 'vitest';
import { normalizeCodex } from '../../src/server/providers/codex/strategy';
import { normalizeDeepSeek } from '../../src/server/providers/deepseek/strategy';
import { normalizeKimiCode } from '../../src/server/providers/kimi-code/strategy';
import type { QuotaWindowMetric } from '../../src/contracts/quota';
import codex from '../fixtures/providers/codex-rate-limits.json';
import deepseek from '../fixtures/providers/deepseek-balance.json';
import kimi from '../fixtures/providers/kimi-usage.json';

const observedAt = '2026-09-22T00:00:00.000Z';

describe('provider response normalization', () => {
  it('preserves each Codex bucket and its available windows', () => {
    const snapshot = normalizeCodex(codex, 'codex-primary', observedAt);
    expect(snapshot).toMatchObject({ providerId: 'codex', serviceAvailable: null });
    expect(snapshot.metrics).toMatchObject([
      { kind: 'quota-window', key: 'codex:primary', usedPercent: 25, windowDurationSeconds: 900, resetsAt: '2026-09-22T01:00:00.000Z' },
      { kind: 'quota-window', key: 'codex:secondary', usedPercent: 42, windowDurationSeconds: 3600 },
      { kind: 'quota-window', key: 'codex_other:primary', usedPercent: 7, windowDurationSeconds: 3600 },
    ]);
  });

  it('supports a legacy single bucket while leaving absent windows missing', () => {
    const snapshot = normalizeCodex({ rateLimits: {
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null }, secondary: null,
    } }, 'legacy', observedAt);
    expect(snapshot.metrics).toHaveLength(1);
    expect(snapshot.metrics[0]).toMatchObject({ key: 'codex:primary', usedPercent: 0, resetsAt: null });
  });

  it('preserves zero balances, currency, and decimal precision', () => {
    const snapshot = normalizeDeepSeek(deepseek, 'deepseek-a', observedAt);
    expect(snapshot).toMatchObject({ providerId: 'deepseek', serviceAvailable: true });
    expect(snapshot.metrics).toMatchObject([
      { kind: 'balance', currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00' },
      { kind: 'balance', currency: 'USD', total: '0.000001', granted: '0', toppedUp: '0.000001' },
    ]);
    const zero = normalizeDeepSeek({ is_available: false, balance_infos: [
      { currency: 'CNY', total_balance: '0.00', granted_balance: '0', topped_up_balance: '0.00' },
    ] }, 'empty', observedAt);
    expect(zero.serviceAvailable).toBe(false);
    expect(zero.metrics[0]).toMatchObject({ total: '0.00' });
  });

  it('normalizes Kimi windows and keeps wallet details in exact cents', () => {
    const snapshot = normalizeKimiCode(kimi, 'kimi-a', observedAt);
    expect(snapshot.metrics).toMatchObject([
      { kind: 'quota-window', key: 'limit5h', usedPercent: 12.5, windowDurationSeconds: 18_000 },
      { kind: 'quota-window', key: 'monthCode', usedPercent: 75, windowDurationSeconds: null },
      { kind: 'balance', key: 'extraUsage', total: '123.45', currency: 'CNY', details: [
        { key: 'total', value: '500.00' },
        { key: 'monthlyUsed', value: '123.45' },
        { key: 'monthlyLimit', value: '800.00' },
      ] },
    ]);
  });

  it('distinguishes an unlimited monthly charge cap from a disabled cap', () => {
    const make = (enabled: boolean) => normalizeKimiCode({ code: 0, data: { kind: 'ok', quota: {
      usages: {}, extraUsage: {
        balanceCents: 0, totalCents: 0, monthlyChargeLimitEnabled: enabled,
        monthlyChargeLimitCents: null, monthlyUsedCents: 0, currency: 'CNY',
      },
    } } }, 'kimi-a', observedAt);
    expect(make(true).metrics[0]).toMatchObject({ details: [{ key: 'total', value: '0.00' },
      { key: 'monthlyUsed', value: '0.00' }, { key: 'monthlyLimit', value: 'Unlimited' }] });
    expect(make(false).metrics[0]).toMatchObject({ details: [{ key: 'total', value: '0.00' },
      { key: 'monthlyUsed', value: '0.00' }, { key: 'monthlyLimit', value: 'Disabled' }] });
  });

  it('rejects invalid percentages and changed payloads rather than inventing values', () => {
    expect(() => normalizeCodex({ rateLimits: { primary: {
      usedPercent: 101, windowDurationMins: 5, resetsAt: null,
    } } }, 'a', observedAt)).toThrow('SCHEMA_CHANGED');
    expect(() => normalizeDeepSeek({ is_available: true, balance_infos: [{
      currency: 'CNY', total_balance: 'NaN', granted_balance: '0', topped_up_balance: '0',
    }] }, 'a', observedAt)).toThrow('SCHEMA_CHANGED');
    expect(() => normalizeKimiCode({ code: 0, data: { kind: 'ok', quota: {
      usages: { limit5h: { usedRatio: 1.1 } }, extraUsage: null,
    } } }, 'a', observedAt)).toThrow('SCHEMA_CHANGED');
  });

  it('does not confuse missing quota windows with a full quota', () => {
    const snapshot = normalizeCodex({ rateLimitsByLimitId: {} }, 'a', observedAt);
    expect(snapshot.metrics).toEqual([]);
    expect(snapshot.metrics as QuotaWindowMetric[]).not.toContainEqual(expect.objectContaining({ usedPercent: 0 }));
  });
});
