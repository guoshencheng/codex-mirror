import type { QuotaProviderStrategy } from '../../contracts/quota';

export class ProviderRegistry {
  private readonly strategies = new Map<string, QuotaProviderStrategy>();

  register(strategy: QuotaProviderStrategy): void {
    if (this.strategies.has(strategy.id)) {
      throw new Error('DUPLICATE_PROVIDER');
    }

    this.strategies.set(strategy.id, strategy);
  }

  get(id: string): QuotaProviderStrategy {
    const strategy = this.strategies.get(id);
    if (!strategy) {
      throw new Error('UNKNOWN_PROVIDER');
    }

    return strategy;
  }

  list(): readonly QuotaProviderStrategy[] {
    return [...this.strategies.values()];
  }
}
