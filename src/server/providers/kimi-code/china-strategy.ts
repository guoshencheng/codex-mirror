import { z } from 'zod';
import type { ProviderAccountConfig, ProviderContext, ProviderFetchResult, ProviderSnapshot, QuotaMetric, QuotaProviderStrategy } from '../../../contracts/quota';
import { ProviderTransportError, requestJson } from '../http';
import { validateProviderSnapshot } from '../metric-schema';

const amount = z.union([z.number().finite().nonnegative(), z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)]);
const detail = z.object({ limit: amount, remaining: amount, resetTime: z.string().optional() }).passthrough();
const responseSchema = z.object({
  usage: detail.optional(),
  limits: z.array(z.object({
    window: z.object({ duration: z.number().int().positive(), timeUnit: z.string() }).passthrough(),
    detail,
  }).passthrough()).optional(),
}).passthrough();

function resetAt(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function usedPercent(value: z.infer<typeof detail>): number | null {
  const limit = Number(value.limit);
  const remaining = Number(value.remaining);
  return limit > 0 ? Math.max(0, Math.min(100, (1 - remaining / limit) * 100)) : null;
}

function windowSeconds(duration: number, unit: string): number | null {
  const units: Record<string, number> = { TIME_UNIT_MINUTE: 60, TIME_UNIT_HOUR: 3600, TIME_UNIT_DAY: 86400 };
  const multiplier = units[unit];
  const seconds = multiplier ? duration * multiplier : NaN;
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

export function normalizeKimiCodeChina(raw: unknown, accountId: string, observedAt: string): ProviderSnapshot {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderTransportError('SCHEMA_CHANGED');
  const metrics: QuotaMetric[] = [];
  for (const item of parsed.data.limits ?? []) {
    const seconds = windowSeconds(item.window.duration, item.window.timeUnit);
    if (seconds === null) continue;
    metrics.push({
      kind: 'quota-window', key: `window:${seconds}`, label: seconds === 18_000 ? '5 小时额度' : `${item.window.duration} ${item.window.timeUnit === 'TIME_UNIT_DAY' ? '天' : item.window.timeUnit === 'TIME_UNIT_HOUR' ? '小时' : '分钟'}额度`,
      usedPercent: usedPercent(item.detail), windowDurationSeconds: seconds, resetsAt: resetAt(item.detail.resetTime),
    });
  }
  if (parsed.data.usage) metrics.push({
    kind: 'quota-window', key: 'plan', label: '套餐额度', usedPercent: usedPercent(parsed.data.usage),
    windowDurationSeconds: null, resetsAt: resetAt(parsed.data.usage.resetTime),
  });
  if (!metrics.length) throw new ProviderTransportError('SCHEMA_CHANGED');
  return validateProviderSnapshot({ accountId, providerId: 'kimi-code-cn', observedAt, metrics, serviceAvailable: null });
}

export class KimiCodeChinaStrategy implements QuotaProviderStrategy {
  readonly id = 'kimi-code-cn';
  readonly capabilities = { metricKinds: ['quota-window'] as const, authModes: ['api-key'] as const };

  constructor(private readonly apiUrl = 'https://api.kimi.com/coding/v1/usages', private readonly now: () => Date = () => new Date()) {}

  validateConfig(config: ProviderAccountConfig): readonly string[] {
    return config.providerId === this.id && config.id.trim() && config.credentialRef.trim() && Object.keys(config.options).length === 0
      ? [] : ['INVALID_CONFIG'];
  }

  async fetchSnapshot(config: ProviderAccountConfig, context: ProviderContext): Promise<ProviderFetchResult> {
    if (this.validateConfig(config).length) return { ok: false, error: { code: 'UNSUPPORTED' } };
    try {
      const apiKey = await context.readSecret(config.credentialRef);
      const raw = await requestJson(this.apiUrl, { signal: context.signal, timeoutMs: 15_000,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
      return { ok: true, snapshot: normalizeKimiCodeChina(raw, config.id, this.now().toISOString()) };
    } catch (error) {
      return { ok: false, error: error instanceof ProviderTransportError
        ? { code: error.code, ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) }
        : error instanceof Error && error.message === 'SECRET_NOT_FOUND' ? { code: 'AUTH_REQUIRED' } : { code: 'UNAVAILABLE' } };
    }
  }
}
