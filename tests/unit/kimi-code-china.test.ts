import { describe, expect, it } from 'vitest';
import { normalizeKimiCodeChina } from '../../src/server/providers/kimi-code/china-strategy';

describe('Kimi Code China quota', () => {
  it('maps the 300-minute window and plan usage without assuming the plan period', () => {
    const snapshot = normalizeKimiCodeChina({
      usage: { limit: '100', used: '26', remaining: '74', resetTime: '2026-08-11T15:53:05.519605Z' },
      limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: {
        limit: '100', used: '27', remaining: '73', resetTime: '2026-08-08T14:53:05.519605Z',
      } }],
    }, 'api-test', '2026-09-23T00:00:00.000Z');
    expect(snapshot.providerId).toBe('kimi-code-cn');
    expect(snapshot.metrics).toMatchObject([
      { kind: 'quota-window', key: 'window:18000', usedPercent: 27, windowDurationSeconds: 18_000,
        resetsAt: '2026-08-08T14:53:05.519Z' },
      { kind: 'quota-window', key: 'plan', label: '套餐额度', usedPercent: 26, windowDurationSeconds: null,
        resetsAt: '2026-08-11T15:53:05.519Z' },
    ]);
  });

  it('does not turn a missing or zero limit into a fabricated percentage', () => {
    const snapshot = normalizeKimiCodeChina({ usage: { limit: '0', remaining: '0' } }, 'api-test', '2026-09-23T00:00:00.000Z');
    expect(snapshot.metrics[0]).toMatchObject({ usedPercent: null, resetsAt: null });
    expect(() => normalizeKimiCodeChina({}, 'api-test', '2026-09-23T00:00:00.000Z')).toThrow();
  });
});
