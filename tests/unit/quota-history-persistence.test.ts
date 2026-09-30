import { describe, expect, it } from 'vitest';
import type { ProviderSnapshot } from '../../src/contracts/quota';
import { snapshotForQuotaHistory } from '../../src/server/quota/history-persistence';

const snapshot: ProviderSnapshot = {
  accountId: 'account-a', providerId: 'fake', observedAt: '2026-09-29T00:00:00.000Z', serviceAvailable: true,
  metrics: [
    { kind: 'quota-window', key: 'five-hour', label: '5H', usedPercent: 10, windowDurationSeconds: 18_000, resetsAt: null },
    { kind: 'quota-window', key: 'weekly', label: '周', usedPercent: 20, windowDurationSeconds: 604_800, resetsAt: null },
  ],
};

describe('quota history persistence policy', () => {
  it('removes five-hour windows while preserving other metrics', () => {
    expect(snapshotForQuotaHistory(snapshot)?.metrics).toEqual([snapshot.metrics[1]]);
    expect(snapshot.metrics).toHaveLength(2);
  });

  it('does not persist a snapshot that only contains five-hour windows', () => {
    expect(snapshotForQuotaHistory({ ...snapshot, metrics: [snapshot.metrics[0]!] })).toBeNull();
  });
});
