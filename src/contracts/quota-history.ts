export const QUOTA_HISTORY_RANGES = ['24h', '7d', '30d', '90d'] as const;
export type QuotaHistoryRange = typeof QUOTA_HISTORY_RANGES[number];

export interface QuotaHistoryPoint {
  observedAt: string;
  value: number | string;
  resetsAt: string | null;
  breakBefore: boolean;
}

export interface QuotaHistorySeries {
  id: string;
  key: string;
  label: string;
  kind: 'quota-window' | 'balance';
  unit: string;
  windowDurationSeconds: number | null;
  points: readonly QuotaHistoryPoint[];
}

export interface QuotaHistoryDto {
  accountId: string;
  range: QuotaHistoryRange;
  from: string;
  to: string;
  generatedAt: string;
  retentionDays: 90;
  bucketSeconds: number;
  series: readonly QuotaHistorySeries[];
}

export type QuotaHistoryLoader = (
  accountId: string,
  range: QuotaHistoryRange,
  signal: AbortSignal,
) => Promise<QuotaHistoryDto>;
