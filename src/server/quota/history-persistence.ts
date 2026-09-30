import type { ProviderSnapshot, QuotaMetric } from '../../contracts/quota';

export const FIVE_HOUR_WINDOW_SECONDS = 18_000;

export function isQuotaHistoryMetric(metric: QuotaMetric): boolean {
  return metric.kind !== 'quota-window' || metric.windowDurationSeconds !== FIVE_HOUR_WINDOW_SECONDS;
}

export function snapshotForQuotaHistory(snapshot: ProviderSnapshot): ProviderSnapshot | null {
  const metrics = snapshot.metrics.filter(isQuotaHistoryMetric);
  return metrics.length ? { ...snapshot, metrics } : null;
}
