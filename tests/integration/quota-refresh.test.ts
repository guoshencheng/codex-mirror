import { describe, expect, it } from 'vitest';
import { QuotaRepository } from '../../src/server/quota/repository';
import { runAccountRefresh } from '../../src/server/quota/refresh';
import { requestRefresh } from '../../src/server/quota/requests';
import type { ProviderAccountConfig, ProviderFetchResult, ProviderSnapshot, QuotaProviderStrategy } from '../../src/contracts/quota';
import { withTestDb } from '../support/database';

const config: ProviderAccountConfig = {
  id: 'account-a', providerId: 'fake', label: 'Fake account', credentialRef: 'unused', options: {},
};

function snapshot(): ProviderSnapshot {
  return { accountId: config.id, providerId: config.providerId, observedAt: '2026-09-22T00:00:00.000Z', serviceAvailable: true, metrics: [] };
}

function strategy(fetch: () => Promise<ProviderFetchResult>): QuotaProviderStrategy {
  return {
    id: 'fake', capabilities: { metricKinds: ['balance'], authModes: ['api-key'] },
    validateConfig: () => [], fetchSnapshot: fetch,
  };
}

describe('PostgreSQL-backed quota refresh', () => {
  it('serializes by account and preserves the last good snapshot after a failure', async () => {
    await withTestDb(async db => {
      const repository = new QuotaRepository(db.pool);
      await repository.upsertConfiguredAccounts([config]);
      await db.pool.query("UPDATE quota_refresh_status SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE account_id = $1", [config.id]);
      let releaseFetch!: () => void;
      let started!: () => void;
      const startedPromise = new Promise<void>(resolve => { started = resolve; });
      const held = new Promise<void>(resolve => { releaseFetch = resolve; });
      let calls = 0;
      const deps = { pool: db.pool, repository, strategy: strategy(async () => {
        calls++;
        started();
        await held;
        return { ok: true, snapshot: snapshot() };
      }), now: () => new Date('2026-09-22T00:00:00.000Z'), jitter: () => 0 };

      const first = runAccountRefresh(config.id, deps);
      await startedPromise;
      expect(await runAccountRefresh(config.id, deps)).toBe('locked');
      expect(await requestRefresh(config.id, new Date('2026-09-22T00:00:01.000Z'), db.pool)).toBe('running');
      releaseFetch();
      expect(await first).toBe('success');
      expect(calls).toBe(1);
      await db.pool.query("INSERT INTO quota_snapshots(account_id, observed_at, snapshot) VALUES ($1, '2000-01-01T00:00:00Z', $2::jsonb)", [config.id, JSON.stringify(snapshot())]);
      expect(await repository.cleanupHistory(new Date('2020-01-01T00:00:00Z'))).toBe(1);
      expect((await repository.readLatest(config.id)).snapshot).toEqual(snapshot());

      await db.pool.query("UPDATE quota_refresh_status SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE account_id = $1", [config.id]);
      const failed = await runAccountRefresh(config.id, {
        ...deps,
        strategy: strategy(async () => ({ ok: false, error: { code: 'TIMEOUT' } })),
      });
      expect(failed).toBe('failed');
      const latest = await repository.readLatest(config.id);
      expect(latest.snapshot).toEqual(snapshot());
      expect(latest.errorCode).toBe('TIMEOUT');
    });
  });

  it('queues manual refresh with a 30-second cooldown and pauses auth failures', async () => {
    await withTestDb(async db => {
      const repository = new QuotaRepository(db.pool);
      await repository.upsertConfiguredAccounts([config]);
      expect(await requestRefresh(config.id, new Date('2026-09-22T00:00:00Z'), db.pool)).toBe('queued');
      expect(await requestRefresh(config.id, new Date('2026-09-22T00:00:20Z'), db.pool)).toBe('cooldown');
      const deps = {
        pool: db.pool, repository,
        strategy: strategy(async () => ({ ok: false, error: { code: 'AUTH_EXPIRED' } })),
        now: () => new Date('2026-09-22T00:00:25Z'), jitter: () => 0,
      };
      expect(await runAccountRefresh(config.id, deps)).toBe('failed');
      const status = await repository.readLatest(config.id);
      expect(status.errorCode).toBe('AUTH_EXPIRED');
      expect(await requestRefresh(config.id, new Date('2026-09-22T00:01:00Z'), db.pool)).toBe('queued');
    });
  });

  it('honors Retry-After and does not retry before the persisted due time', async () => {
    await withTestDb(async db => {
      const repository = new QuotaRepository(db.pool);
      await repository.upsertConfiguredAccounts([config]);
      const at = new Date('2100-01-01T00:00:00.000Z');
      const deps = {
        pool: db.pool, repository,
        strategy: strategy(async () => ({ ok: false, error: { code: 'RATE_LIMITED', retryAfterSeconds: 120 } })),
        now: () => at, jitter: () => 0,
      };
      expect(await runAccountRefresh(config.id, deps)).toBe('failed');
      expect((await repository.readLatest(config.id)).nextAttemptAt).toBe('2100-01-01T00:02:00.000Z');
      expect(await runAccountRefresh(config.id, deps)).toBe('not-due');
    });
  });
});
