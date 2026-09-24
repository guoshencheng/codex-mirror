import type { QuotaProviderStrategy } from '../../contracts/quota';
import { DeepSeekBalanceStrategy } from './deepseek/strategy';
import { KimiCodeChinaStrategy } from './kimi-code/china-strategy';

export type ManagedProviderId = 'deepseek' | 'kimi-code-cn';

export function managedStrategy(providerId: string): QuotaProviderStrategy | null {
  if (providerId === 'deepseek') return new DeepSeekBalanceStrategy();
  if (providerId === 'kimi-code-cn') return new KimiCodeChinaStrategy();
  return null;
}
