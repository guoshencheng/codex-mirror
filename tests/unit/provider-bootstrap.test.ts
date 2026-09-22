import { describe, expect, it } from 'vitest';
import { makeProviderRegistry, parseProviderAccounts, validateProviderAccounts } from '../../src/server/providers/bootstrap';

describe('provider bootstrap', () => {
  it('registers each concrete strategy through the common registry', () => {
    const registry = makeProviderRegistry({ codexRuntimeRoot: '/tmp/codex-status-test-runtime' });
    expect(registry.list().map(strategy => strategy.id).sort()).toEqual(['codex', 'deepseek', 'kimi-code']);
    expect(registry.get('codex').capabilities.metricKinds).toContain('quota-window');
    expect(registry.get('deepseek').capabilities.metricKinds).toContain('balance');
  });

  it('validates deployment account config and rejects duplicate ids', () => {
    const account = { id: 'deepseek-main', providerId: 'deepseek', label: 'DeepSeek', credentialRef: 'deepseek/token', options: {} };
    expect(parseProviderAccounts([account])).toEqual([account]);
    expect(() => parseProviderAccounts([account, account])).toThrow('INVALID_PROVIDER_ACCOUNTS_CONFIG');
    expect(() => parseProviderAccounts([{ ...account, providerId: 'unknown' }])).toThrow('INVALID_PROVIDER_ACCOUNTS_CONFIG');
    expect(() => parseProviderAccounts([{ ...account, extra: 'secret' }])).toThrow('INVALID_PROVIDER_ACCOUNTS_CONFIG');
  });

  it('rejects provider-specific runtime configuration before scheduling', () => {
    const kimi = { id: 'kimi-main', providerId: 'kimi-code', label: 'Kimi', credentialRef: 'kimi/token', options: { baseUrl: 'https://example.com' } };
    expect(() => validateProviderAccounts([kimi], makeProviderRegistry())).toThrow('INVALID_PROVIDER_ACCOUNTS_CONFIG');
  });
});
