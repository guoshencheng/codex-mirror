import { z } from 'zod';
import type {
  ProviderAccountConfig,
  ProviderCapabilities,
  ProviderContext,
  ProviderFetchResult,
  ProviderSnapshot,
  QuotaProviderStrategy,
} from '../../../contracts/quota';
import { ProviderTransportError, requestJson } from '../http';
import { validateProviderSnapshot } from '../metric-schema';

const decimalAmount = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const balanceSchema = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    total_balance: decimalAmount,
    granted_balance: decimalAmount,
    topped_up_balance: decimalAmount,
  }).passthrough()),
}).passthrough();

const emptyOptions = z.object({}).strict();

export function normalizeDeepSeek(raw: unknown, accountId: string, observedAt: string): ProviderSnapshot {
  const parsed = balanceSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderTransportError('SCHEMA_CHANGED');
  return validateProviderSnapshot({
    accountId,
    providerId: 'deepseek',
    observedAt,
    serviceAvailable: parsed.data.is_available,
    metrics: parsed.data.balance_infos.map(info => ({
      kind: 'balance' as const,
      key: info.currency,
      label: `${info.currency} balance`,
      currency: info.currency,
      total: info.total_balance,
      granted: info.granted_balance,
      toppedUp: info.topped_up_balance,
    })),
  });
}

export class DeepSeekBalanceStrategy implements QuotaProviderStrategy {
  readonly id = 'deepseek';
  readonly capabilities: ProviderCapabilities = {
    metricKinds: ['balance'],
    authModes: ['api-key'],
  };

  constructor(
    private readonly apiUrl = 'https://api.deepseek.com/user/balance',
    private readonly now: () => Date = () => new Date(),
  ) {}

  validateConfig(config: ProviderAccountConfig): readonly string[] {
    const errors: string[] = [];
    if (config.providerId !== this.id) errors.push('providerId must be deepseek');
    if (!config.id.trim()) errors.push('account id is required');
    if (!config.credentialRef.trim()) errors.push('credential reference is required');
    if (!emptyOptions.safeParse(config.options).success) errors.push('deepseek options are not supported');
    return errors;
  }

  async fetchSnapshot(config: ProviderAccountConfig, context: ProviderContext): Promise<ProviderFetchResult> {
    if (this.validateConfig(config).length) return { ok: false, error: { code: 'UNSUPPORTED' } };
    try {
      const apiKey = await context.readSecret(config.credentialRef);
      const raw = await requestJson(this.apiUrl, {
        signal: context.signal,
        timeoutMs: 15_000,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      return { ok: true, snapshot: normalizeDeepSeek(raw, config.id, this.now().toISOString()) };
    } catch (error) {
      return { ok: false, error: error instanceof ProviderTransportError
        ? { code: error.code, ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) }
        : error instanceof Error && error.message === 'SECRET_NOT_FOUND'
          ? { code: 'AUTH_REQUIRED' }
          : { code: 'UNAVAILABLE' } };
    }
  }
}
