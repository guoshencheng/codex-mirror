import { z } from 'zod';
import type {
  ProviderAccountConfig,
  ProviderCapabilities,
  ProviderContext,
  ProviderFetchResult,
  ProviderSnapshot,
  QuotaProviderStrategy,
  QuotaWindowMetric,
} from '../../../contracts/quota';
import { ProviderTransportError } from '../http';
import { validateProviderSnapshot } from '../metric-schema';
import type { CodexUsageApi } from './usage-api';

const quotaWindowSchema = z.object({
  usedPercent: z.number().finite().min(0).max(100),
  windowDurationMins: z.number().int().positive(),
  resetsAt: z.number().finite().nullable().optional(),
}).passthrough();

const bucketSchema = z.object({
  limitId: z.string().min(1).nullable().optional(),
  limitName: z.string().nullable().optional(),
  primary: quotaWindowSchema.nullish(),
  secondary: quotaWindowSchema.nullish(),
}).passthrough();

const codexResponseSchema = z.object({
  rateLimitsByLimitId: z.record(z.string(), bucketSchema).nullable().optional(),
  rateLimits: bucketSchema.nullish(),
}).passthrough();

const emptyOptions = z.object({}).strict();

function resetTime(epochSeconds: number | null | undefined): string | null {
  if (epochSeconds == null) return null;
  const date = new Date(epochSeconds * 1000);
  if (!Number.isFinite(date.valueOf())) throw new ProviderTransportError('SCHEMA_CHANGED');
  return date.toISOString();
}

function bucketMetrics(id: string, label: string, bucket: z.infer<typeof bucketSchema>): QuotaWindowMetric[] {
  const windows: Array<['primary' | 'secondary', z.infer<typeof quotaWindowSchema> | null | undefined]> = [
    ['primary', bucket.primary],
    ['secondary', bucket.secondary],
  ];
  return windows.flatMap(([name, window]) => window ? [{
    kind: 'quota-window' as const,
    key: `${id}:${name}`,
    label: `${label} · ${name === 'primary' ? 'Primary' : 'Secondary'}`,
    usedPercent: window.usedPercent,
    windowDurationSeconds: window.windowDurationMins * 60,
    resetsAt: resetTime(window.resetsAt),
  }] : []);
}

export function normalizeCodex(raw: unknown, accountId: string, observedAt: string): ProviderSnapshot {
  const parsed = codexResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderTransportError('SCHEMA_CHANGED');
  const payload = parsed.data;
  let metrics: QuotaWindowMetric[];

  if (payload.rateLimitsByLimitId != null) {
    metrics = Object.entries(payload.rateLimitsByLimitId).sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([key, bucket]) => bucketMetrics(
        bucket.limitId ?? key,
        bucket.limitName || bucket.limitId || key,
        bucket,
      ));
  } else if (payload.rateLimits) {
    const id = payload.rateLimits.limitId ?? 'codex';
    metrics = bucketMetrics(id, payload.rateLimits.limitName || id, payload.rateLimits);
  } else {
    metrics = [];
  }

  return validateProviderSnapshot({ accountId, providerId: 'codex', observedAt, metrics, serviceAvailable: null });
}

function configErrors(config: ProviderAccountConfig): string[] {
  const errors: string[] = [];
  if (config.providerId !== 'codex') errors.push('providerId must be codex');
  if (!config.id.trim()) errors.push('account id is required');
  if (!config.credentialRef.trim()) errors.push('runtime reference is required');
  const options = emptyOptions.safeParse(config.options);
  if (!options.success) errors.push('codex options are not supported');
  return errors;
}

export class CodexQuotaStrategy implements QuotaProviderStrategy {
  readonly id = 'codex';
  readonly capabilities: ProviderCapabilities = {
    metricKinds: ['quota-window'],
    authModes: ['managed-login'],
  };

  constructor(
    private readonly rpcForAccount: (accountId: string) => Pick<CodexUsageApi, 'readRateLimits'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  validateConfig(config: ProviderAccountConfig): readonly string[] { return configErrors(config); }

  async fetchSnapshot(config: ProviderAccountConfig, context: ProviderContext): Promise<ProviderFetchResult> {
    const errors = this.validateConfig(config);
    if (errors.length) return { ok: false, error: { code: 'UNSUPPORTED' } };
    try {
      const raw = await this.rpcForAccount(config.id).readRateLimits(context.signal);
      return { ok: true, snapshot: normalizeCodex(raw, config.id, this.now().toISOString()) };
    } catch (error) {
      return { ok: false, error: error instanceof ProviderTransportError
        ? { code: error.code, ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) }
        : { code: 'UNAVAILABLE' } };
    }
  }
}
