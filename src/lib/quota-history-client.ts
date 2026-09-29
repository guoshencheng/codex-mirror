import { normalizeApiOrigin } from './display-connection';
import {
  QUOTA_HISTORY_RANGES,
  type QuotaHistoryDto,
  type QuotaHistoryLoader,
  type QuotaHistoryRange,
} from '../contracts/quota-history';

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function invalid(): never {
  throw new Error('INVALID_QUOTA_HISTORY');
}

export function parseQuotaHistory(value: unknown): QuotaHistoryDto {
  if (!value || typeof value !== 'object') return invalid();
  const body = value as Record<string, unknown>;
  if (typeof body.accountId !== 'string' || typeof body.range !== 'string' ||
      !(QUOTA_HISTORY_RANGES as readonly string[]).includes(body.range) ||
      !validDate(body.from) || !validDate(body.to) || !validDate(body.generatedAt) ||
      body.retentionDays !== 90 || typeof body.bucketSeconds !== 'number' ||
      !Number.isInteger(body.bucketSeconds) || body.bucketSeconds <= 0 || !Array.isArray(body.series)) return invalid();
  for (const rawSeries of body.series) {
    if (!rawSeries || typeof rawSeries !== 'object') return invalid();
    const item = rawSeries as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.key !== 'string' || typeof item.label !== 'string' ||
        typeof item.unit !== 'string' || (item.kind !== 'quota-window' && item.kind !== 'balance') ||
        (item.windowDurationSeconds !== null && (typeof item.windowDurationSeconds !== 'number' ||
          !Number.isInteger(item.windowDurationSeconds) || item.windowDurationSeconds <= 0)) || !Array.isArray(item.points)) return invalid();
    for (const rawPoint of item.points) {
      if (!rawPoint || typeof rawPoint !== 'object') return invalid();
      const point = rawPoint as Record<string, unknown>;
      if (!validDate(point.observedAt) || (point.resetsAt !== null && !validDate(point.resetsAt)) || typeof point.breakBefore !== 'boolean') return invalid();
      if (item.kind === 'quota-window') {
        if (typeof point.value !== 'number' || !Number.isFinite(point.value) || point.value < 0 || point.value > 100) return invalid();
      } else if (typeof point.value !== 'string' || !decimalPattern.test(point.value)) return invalid();
    }
  }
  return value as QuotaHistoryDto;
}

export function createQuotaHistoryLoader(options: { apiOrigin?: string; token?: string } = {}): QuotaHistoryLoader {
  const origin = options.apiOrigin ? normalizeApiOrigin(options.apiOrigin) : '';
  return async (accountId: string, range: QuotaHistoryRange, signal: AbortSignal): Promise<QuotaHistoryDto> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    try {
      const path = options.apiOrigin
        ? `/api/display/provider-accounts/${encodeURIComponent(accountId)}/history?range=${encodeURIComponent(range)}`
        : `/api/provider-accounts/${encodeURIComponent(accountId)}/history?range=${encodeURIComponent(range)}`;
      const response = await fetch(`${origin}${path}`, {
        headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`QUOTA_HISTORY_${response.status}`);
      const parsed = parseQuotaHistory(await response.json());
      if (parsed.accountId !== accountId || parsed.range !== range) return invalid();
      return parsed;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  };
}
