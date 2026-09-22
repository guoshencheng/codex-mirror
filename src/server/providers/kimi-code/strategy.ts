import { z } from 'zod';
import type {
  ProviderAccountConfig,
  ProviderCapabilities,
  ProviderContext,
  ProviderFetchResult,
  ProviderSnapshot,
  QuotaMetric,
  QuotaProviderStrategy,
} from '../../../contracts/quota';
import { ProviderTransportError } from '../http';
import { validateProviderSnapshot } from '../metric-schema';
import { KimiUsageClient } from './client';

const moneyCents = z.number().int().nonnegative().safe();
const usageSchema = z.object({
  usedRatio: z.number().finite().min(0).max(1),
  resetAt: z.string().datetime({ offset: true }).optional(),
}).passthrough();
const quotaSchema = z.object({
  usages: z.record(z.string(), usageSchema),
  extraUsage: z.object({
    balanceCents: moneyCents,
    totalCents: moneyCents,
    monthlyChargeLimitEnabled: z.boolean(),
    monthlyChargeLimitCents: moneyCents.nullable(),
    monthlyUsedCents: moneyCents,
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).passthrough().nullable(),
});
const envelopeSchema = z.object({
  code: z.literal(0),
  data: z.object({ kind: z.literal('ok'), quota: quotaSchema }),
}).passthrough();
const optionsSchema = z.object({ baseUrl: z.string().url().optional() }).strict();
const windowDurations: Readonly<Record<string, number>> = { limit5h: 18_000, limit7d: 604_800 };

function asMoney(cents: number): string {
  const value = BigInt(cents);
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

function displayWindow(key: string): string {
  const known: Record<string, string> = {
    limit5h: '5-hour quota', limit7d: '7-day quota', monthTotal: 'Monthly total quota', monthCode: 'Monthly coding quota',
  };
  return known[key] ?? key;
}

export function normalizeKimiCode(raw: unknown, accountId: string, observedAt: string): ProviderSnapshot {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const inBand = z.object({ code: z.literal(0), data: z.object({ kind: z.literal('error'), status: z.number().optional() }) }).safeParse(raw);
    if (inBand.success) {
      const status = inBand.data.data.status;
      const code = status === 401 ? 'AUTH_EXPIRED' : status === 403 ? 'FORBIDDEN'
        : status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE';
      throw new ProviderTransportError(code);
    }
    throw new ProviderTransportError('SCHEMA_CHANGED');
  }

  const quota = parsed.data.data.quota;
  const metrics: QuotaMetric[] = Object.entries(quota.usages).sort(([a], [b]) => a.localeCompare(b)).map(([key, usage]) => ({
    kind: 'quota-window',
    key,
    label: displayWindow(key),
    usedPercent: usage.usedRatio * 100,
    windowDurationSeconds: windowDurations[key] ?? null,
    resetsAt: usage.resetAt ? new Date(usage.resetAt).toISOString() : null,
  }));

  if (quota.extraUsage) {
    const extra = quota.extraUsage;
    metrics.push({
      kind: 'balance',
      key: 'extraUsage',
      label: 'Extra Usage balance',
      currency: extra.currency,
      total: asMoney(extra.balanceCents),
      granted: null,
      toppedUp: null,
      details: [
        { key: 'total', label: 'Wallet total', value: asMoney(extra.totalCents) },
        { key: 'monthlyUsed', label: 'Monthly used', value: asMoney(extra.monthlyUsedCents) },
        { key: 'monthlyLimit', label: 'Monthly charge limit', value: !extra.monthlyChargeLimitEnabled
          ? 'Disabled' : extra.monthlyChargeLimitCents === null ? 'Unlimited' : asMoney(extra.monthlyChargeLimitCents) },
      ],
    });
  }

  return validateProviderSnapshot({ accountId, providerId: 'kimi-code', observedAt, metrics, serviceAvailable: null });
}

export class KimiCodeQuotaStrategy implements QuotaProviderStrategy {
  readonly id = 'kimi-code';
  readonly capabilities: ProviderCapabilities = {
    metricKinds: ['quota-window', 'balance'],
    authModes: ['managed-login'],
  };

  constructor(private readonly now: () => Date = () => new Date()) {}

  validateConfig(config: ProviderAccountConfig): readonly string[] {
    const errors: string[] = [];
    if (config.providerId !== this.id) errors.push('providerId must be kimi-code');
    if (!config.id.trim()) errors.push('account id is required');
    if (!config.credentialRef.trim()) errors.push('credential reference is required');
    const options = optionsSchema.safeParse(config.options);
    if (!options.success) errors.push('invalid Kimi Code options');
    else if (options.data.baseUrl) {
      try { new KimiUsageClient(options.data.baseUrl, 'validation-only-token'); }
      catch { errors.push('Kimi Code endpoint must be loopback'); }
    }
    return errors;
  }

  async fetchSnapshot(config: ProviderAccountConfig, context: ProviderContext): Promise<ProviderFetchResult> {
    const errors = this.validateConfig(config);
    if (errors.length) return { ok: false, error: { code: 'UNSUPPORTED' } };
    try {
      const token = await context.readSecret(config.credentialRef);
      const options = optionsSchema.parse(config.options);
      const baseUrl = options.baseUrl ?? 'http://127.0.0.1:58627';
      const raw = await new KimiUsageClient(baseUrl, token).readUsage(context.signal);
      return { ok: true, snapshot: normalizeKimiCode(raw, config.id, this.now().toISOString()) };
    } catch (error) {
      return { ok: false, error: error instanceof ProviderTransportError
        ? { code: error.code, ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) }
        : error instanceof Error && error.message === 'SECRET_NOT_FOUND'
          ? { code: 'AUTH_REQUIRED' }
          : { code: 'UNAVAILABLE' } };
    }
  }
}
