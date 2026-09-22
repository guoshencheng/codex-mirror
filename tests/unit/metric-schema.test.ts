import { describe, expect, it } from 'vitest';
import { validateProviderSnapshot } from '../../src/server/providers/metric-schema';

const base = {
  accountId: 'a', providerId: 'test', observedAt: '2026-09-22T00:00:00.000Z', serviceAvailable: null,
};

describe('provider snapshot schema', () => {
  it('accepts both normalized metric variants and Kimi wallet details', () => {
    expect(validateProviderSnapshot({ ...base, metrics: [
      { kind: 'quota-window', key: 'x', label: 'X', usedPercent: null, windowDurationSeconds: null, resetsAt: null },
      { kind: 'balance', key: 'wallet', label: 'Wallet', currency: 'CNY', total: '12.30', granted: null, toppedUp: null,
        details: [{ key: 'spent', label: 'Monthly used', value: '1.20' }] },
    ] })).toMatchObject({ metrics: [{ usedPercent: null }, { total: '12.30', details: [{ value: '1.20' }] }] });
  });

  it('rejects values that could make the UI misrepresent malformed provider data', () => {
    expect(() => validateProviderSnapshot({ ...base, metrics: [{
      kind: 'quota-window', key: 'x', label: 'X', usedPercent: 101,
      windowDurationSeconds: -1, resetsAt: 'tomorrow',
    }] })).toThrow('SCHEMA_CHANGED');
    expect(() => validateProviderSnapshot({ ...base, metrics: [{
      kind: 'balance', key: 'x', label: 'X', currency: 'CNY', total: 'NaN', granted: null, toppedUp: null,
    }] })).toThrow('SCHEMA_CHANGED');
  });
});
