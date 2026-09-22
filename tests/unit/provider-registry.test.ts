import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/server/providers/registry';
import type { QuotaProviderStrategy } from '../../src/contracts/quota';

const fake: QuotaProviderStrategy = {
  id: 'test-provider',
  capabilities: { metricKinds: ['balance'], authModes: ['api-key'] },
  validateConfig: () => [],
  fetchSnapshot: async config => ({
    ok: true,
    snapshot: {
      accountId: config.id,
      providerId: config.providerId,
      observedAt: '2026-09-22T00:00:00Z',
      serviceAvailable: true,
      metrics: [],
    },
  }),
};

describe('ProviderRegistry', () => {
  it('registers a new provider without changing dispatch code', () => {
    const registry = new ProviderRegistry();
    registry.register(fake);

    expect(registry.get('test-provider')).toBe(fake);
    expect(registry.list()).toEqual([fake]);
  });

  it('rejects duplicate and unknown providers', () => {
    const registry = new ProviderRegistry();
    registry.register(fake);

    expect(() => registry.register(fake)).toThrow('DUPLICATE_PROVIDER');
    expect(() => registry.get('missing')).toThrow('UNKNOWN_PROVIDER');
  });
});
