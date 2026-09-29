import type { BalanceMetric, ProviderSnapshot, QuotaMetric, QuotaWindowMetric } from '../../contracts/quota';
import {
  QUOTA_HISTORY_RANGES,
  type QuotaHistoryDto,
  type QuotaHistoryRange,
  type QuotaHistoryPoint,
  type QuotaHistorySeries,
} from '../../contracts/quota-history';
import type { QuotaHistoryRow, QuotaRepository } from './repository';

const RETENTION_SECONDS = 90 * 24 * 60 * 60;
const GAP_SECONDS = 15 * 60;
const RANGE_SECONDS: Record<QuotaHistoryRange, number> = {
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
  '90d': RETENTION_SECONDS,
};
const BUCKET_SECONDS: Record<QuotaHistoryRange, number> = {
  '24h': 30 * 60,
  '7d': 2 * 60 * 60,
  '30d': 2 * 60 * 60,
  '90d': 6 * 60 * 60,
};

export function isQuotaHistoryRange(value: unknown): value is QuotaHistoryRange {
  return typeof value === 'string' && (QUOTA_HISTORY_RANGES as readonly string[]).includes(value);
}

export function rangeStart(range: QuotaHistoryRange, now: Date): Date {
  return new Date(now.getTime() - RANGE_SECONDS[range] * 1000);
}

interface RawPoint {
  observedAt: string;
  observedAtMs: number;
  value: number | string;
  resetsAt: string | null;
  segment: number;
}

interface SeriesState {
  id: string;
  key: string;
  label: string;
  kind: 'quota-window' | 'balance';
  unit: string;
  windowDurationSeconds: number | null;
  points: RawPoint[];
  lastValidAtMs: number | null;
  pendingBreak: boolean;
  segment: number;
}

function seriesId(metric: QuotaMetric): string {
  return metric.kind === 'quota-window'
    ? JSON.stringify([metric.kind, metric.key, metric.windowDurationSeconds])
    : JSON.stringify([metric.kind, metric.key, metric.currency]);
}

function decimalParts(value: string): { negative: boolean; integer: string; fraction: string } {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  return {
    negative,
    integer: integer.replace(/^0+(?=\d)/, '') || '0',
    fraction: fraction.replace(/0+$/, ''),
  };
}

function compareDecimal(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const sign = a.negative ? -1 : 1;
  if (a.integer.length !== b.integer.length) return (a.integer.length - b.integer.length) * sign;
  if (a.integer !== b.integer) return (a.integer < b.integer ? -1 : 1) * sign;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const af = a.fraction.padEnd(width, '0');
  const bf = b.fraction.padEnd(width, '0');
  if (af === bf) return 0;
  return (af < bf ? -1 : 1) * sign;
}

function compareValues(left: number | string, right: number | string, kind: 'quota-window' | 'balance'): number {
  if (kind === 'balance') return compareDecimal(String(left), String(right));
  return Number(left) - Number(right);
}

function compareIds(left: string, right: string): number {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

function sortedRows(rows: readonly QuotaHistoryRow[]): QuotaHistoryRow[] {
  return [...rows].sort((left, right) => {
    const time = Date.parse(left.observedAt) - Date.parse(right.observedAt);
    return time || compareIds(left.id, right.id);
  });
}

function createState(metric: QuotaMetric, id: string): SeriesState {
  return {
    id,
    key: metric.key,
    label: metric.label,
    kind: metric.kind,
    unit: metric.kind === 'quota-window' ? '%' : metric.currency,
    windowDurationSeconds: metric.kind === 'quota-window' ? metric.windowDurationSeconds : null,
    points: [],
    lastValidAtMs: null,
    pendingBreak: false,
    segment: 0,
  };
}

function balanceValue(metric: BalanceMetric): string {
  return metric.total;
}

function quotaValue(metric: QuotaWindowMetric): number | null {
  return metric.usedPercent === null ? null : 100 - metric.usedPercent;
}

function appendMetric(state: SeriesState, metric: QuotaMetric, snapshot: ProviderSnapshot, atMs: number): void {
  state.label = metric.label;
  const value = metric.kind === 'quota-window' ? quotaValue(metric) : balanceValue(metric);
  const valid = snapshot.serviceAvailable !== false && value !== null;
  if (!valid) {
    state.pendingBreak = true;
    return;
  }
  const gap = state.lastValidAtMs !== null && atMs - state.lastValidAtMs > GAP_SECONDS * 1000;
  const breakBefore = state.points.length === 0 || state.pendingBreak || gap;
  if (breakBefore) state.segment += 1;
  state.points.push({
    observedAt: new Date(atMs).toISOString(),
    observedAtMs: atMs,
    value,
    resetsAt: metric.kind === 'quota-window' ? metric.resetsAt : null,
    segment: state.segment,
  });
  state.lastValidAtMs = atMs;
  state.pendingBreak = false;
}

function sampleSeries(state: SeriesState, bucketSeconds: number): QuotaHistoryPoint[] {
  const buckets = new Map<number, RawPoint[]>();
  for (const point of state.points) {
    const bucket = Math.floor(point.observedAtMs / (bucketSeconds * 1000));
    const values = buckets.get(bucket) ?? [];
    values.push(point);
    buckets.set(bucket, values);
  }
  const selected: RawPoint[] = [];
  for (const values of buckets.values()) {
    values.sort((left, right) => left.observedAtMs - right.observedAtMs);
    const first = values[0]!;
    const last = values[values.length - 1]!;
    let minimum = first;
    let maximum = first;
    for (const value of values.slice(1)) {
      if (compareValues(value.value, minimum.value, state.kind) < 0) minimum = value;
      if (compareValues(value.value, maximum.value, state.kind) > 0) maximum = value;
    }
    const unique = new Map<number, RawPoint>();
    for (const value of [first, last, minimum, maximum]) unique.set(value.observedAtMs, value);
    selected.push(...[...unique.values()].sort((left, right) => left.observedAtMs - right.observedAtMs));
  }
  selected.sort((left, right) => left.observedAtMs - right.observedAtMs);
  let previousSegment: number | null = null;
  return selected.map((point, index) => {
    const breakBefore = index === 0 || point.segment !== previousSegment;
    previousSegment = point.segment;
    return {
      observedAt: point.observedAt,
      value: point.value,
      resetsAt: point.resetsAt,
      breakBefore,
    };
  });
}

export function buildQuotaHistory(
  accountId: string,
  range: QuotaHistoryRange,
  rows: readonly QuotaHistoryRow[],
  now: Date,
): QuotaHistoryDto {
  const toMs = now.getTime();
  const fromMs = Math.max(toMs - RANGE_SECONDS[range] * 1000, toMs - RETENTION_SECONDS * 1000);
  const states = new Map<string, SeriesState>();
  for (const row of sortedRows(rows)) {
    const atMs = Date.parse(row.observedAt);
    if (!Number.isFinite(atMs) || atMs < fromMs || atMs > toMs) continue;
    const active = new Set<string>();
    for (const metric of row.snapshot.metrics) {
      const id = seriesId(metric);
      active.add(id);
      const state = states.get(id) ?? createState(metric, id);
      states.set(id, state);
      appendMetric(state, metric, row.snapshot, atMs);
    }
    for (const [id, state] of states) {
      if (!active.has(id)) state.pendingBreak = true;
    }
  }
  const result: QuotaHistorySeries[] = [...states.values()]
    .filter(state => state.points.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(state => ({
      id: state.id,
      key: state.key,
      label: state.label,
      kind: state.kind,
      unit: state.unit,
      windowDurationSeconds: state.windowDurationSeconds,
      points: sampleSeries(state, BUCKET_SECONDS[range]),
    }));
  return {
    accountId,
    range,
    from: new Date(fromMs).toISOString(),
    to: now.toISOString(),
    generatedAt: now.toISOString(),
    retentionDays: 90,
    bucketSeconds: BUCKET_SECONDS[range],
    series: result,
  };
}

export async function readQuotaHistory(
  repository: QuotaRepository,
  accountId: string,
  range: QuotaHistoryRange,
  now: Date,
): Promise<QuotaHistoryDto | null> {
  const from = rangeStart(range, now);
  const rows = await repository.readHistory(accountId, from, now);
  return rows === null ? null : buildQuotaHistory(accountId, range, rows, now);
}
