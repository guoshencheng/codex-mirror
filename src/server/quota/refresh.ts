import type { Pool, PoolClient } from 'pg';
import type { ProviderAccountConfig, ProviderFailure, ProviderFailureCode, ProviderFetchResult, ProviderSnapshot, QuotaProviderStrategy } from '../../contracts/quota';
import { validateProviderSnapshot } from '../providers/metric-schema';
import { QuotaRepository } from './repository';

export type RefreshOutcome = 'success' | 'failed' | 'locked' | 'not-due';
export interface AccountRefreshDependencies {
  pool: Pool;
  repository: QuotaRepository;
  strategy: QuotaProviderStrategy;
  now?: () => Date;
  jitter?: () => number;
  context?: (account: ProviderAccountConfig, signal: AbortSignal) => { signal: AbortSignal; readSecret(ref: string): Promise<string> };
  signal?: AbortSignal;
}

const authFailures = new Set<ProviderFailureCode>(['AUTH_REQUIRED', 'AUTH_EXPIRED', 'FORBIDDEN']);
const defaultContext: NonNullable<AccountRefreshDependencies['context']> = (_account, signal) => ({
  signal,
  readSecret: async () => { throw new Error('SECRET_NOT_FOUND'); },
});

function isSnapshotForAccount(value: ProviderSnapshot, account: ProviderAccountConfig): ProviderSnapshot {
  if (value.accountId !== account.id || value.providerId !== account.providerId) throw new Error('SNAPSHOT_ACCOUNT_MISMATCH');
  return validateProviderSnapshot(value);
}

function asFailure(error: unknown): ProviderFailure {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const candidate = error as ProviderFailure;
    const allowed: readonly string[] = ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'FORBIDDEN', 'RATE_LIMITED', 'TIMEOUT', 'UNAVAILABLE', 'SCHEMA_CHANGED', 'UNSUPPORTED'];
    if (allowed.includes(candidate.code)) return {
      code: candidate.code as ProviderFailureCode,
      ...(Number.isFinite(candidate.retryAfterSeconds) && candidate.retryAfterSeconds! >= 0
        ? { retryAfterSeconds: candidate.retryAfterSeconds } : {}),
    };
  }
  return { code: 'UNAVAILABLE' };
}

async function persistSuccess(client: PoolClient, accountId: string, snapshot: ProviderSnapshot, now: Date, nextAt: Date, manualAt: Date | null): Promise<void> {
  await client.query('BEGIN');
  try {
    const json = JSON.stringify(snapshot);
    await client.query(`
      INSERT INTO quota_latest (account_id, snapshot) VALUES ($1, $2::jsonb)
      ON CONFLICT (account_id) DO UPDATE SET snapshot = EXCLUDED.snapshot
    `, [accountId, json]);
    await client.query('INSERT INTO quota_snapshots (account_id, observed_at, snapshot) VALUES ($1, $2, $3::jsonb)', [accountId, snapshot.observedAt, json]);
    await client.query(`
      UPDATE quota_refresh_status SET last_success_at = $2, error_code = NULL, next_attempt_at = $3,
        failure_count = 0, auth_blocked = false,
        manual_requested_at = CASE WHEN $4::timestamptz IS NOT NULL AND manual_requested_at <= $4 THEN NULL ELSE manual_requested_at END
      WHERE account_id = $1
    `, [accountId, now, nextAt, manualAt]);
    await client.query("SELECT pg_notify('dashboard_changed', 'quota')");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function persistFailure(client: PoolClient, accountId: string, failure: ProviderFailure, count: number, now: Date, manualAt: Date | null): Promise<void> {
  const blocked = authFailures.has(failure.code);
  const seconds = blocked ? 1_800 : Math.max(
    Math.min(30 * 2 ** Math.min(Math.max(0, count - 1), 6), 1_800),
    failure.retryAfterSeconds ?? 0,
  );
  const nextAt = new Date(now.getTime() + seconds * 1000);
  await client.query('BEGIN');
  try {
    await client.query(`
      UPDATE quota_refresh_status SET error_code = $2, failure_count = $3, auth_blocked = $4, next_attempt_at = $5,
        manual_requested_at = CASE WHEN $6::timestamptz IS NOT NULL AND manual_requested_at <= $6 THEN NULL ELSE manual_requested_at END
      WHERE account_id = $1
    `, [accountId, failure.code, count, blocked, nextAt, manualAt]);
    await client.query("SELECT pg_notify('dashboard_changed', 'quota')");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function runAccountRefresh(accountId: string, deps: AccountRefreshDependencies): Promise<RefreshOutcome> {
  const now = deps.now ?? (() => new Date());
  const jitter = deps.jitter ?? (() => Math.random());
  const client = await deps.pool.connect();
  let ownsLock = false;
  let discardClient = false;
  try {
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [accountId]);
    ownsLock = Boolean(lock.rows[0]?.locked);
    if (!ownsLock) return 'locked';

    const stateResult = await client.query(`
      SELECT s.last_attempt_at, s.last_success_at, s.next_attempt_at, s.failure_count,
        s.manual_requested_at, s.auth_blocked
      FROM quota_refresh_status s JOIN provider_accounts a ON a.id = s.account_id
      WHERE a.id = $1 AND a.enabled = true
    `, [accountId]);
    const state = stateResult.rows[0] as {
      last_attempt_at: Date | null; last_success_at: Date | null; next_attempt_at: Date | null;
      failure_count: number; manual_requested_at: Date | null; auth_blocked: boolean;
    } | undefined;
    const account = await deps.repository.loadAccount(client, accountId);
    if (!state || !account) return 'not-due';
    const current = now();
    const manualAt = state.manual_requested_at ? new Date(state.manual_requested_at) : null;
    const manuallyRequested = manualAt !== null;
    if (state.auth_blocked && !manuallyRequested) return 'not-due';
    if (!manuallyRequested && state.next_attempt_at && new Date(state.next_attempt_at).getTime() > current.getTime()) return 'not-due';

    await client.query('UPDATE quota_refresh_status SET last_attempt_at = $2 WHERE account_id = $1', [accountId, current]);
    let result: ProviderFetchResult;
    try {
      const configErrors = deps.strategy.validateConfig(account);
      if (configErrors.length || deps.strategy.id !== account.providerId) {
        result = { ok: false, error: { code: 'UNSUPPORTED' } };
      } else {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        deps.signal?.addEventListener('abort', onAbort, { once: true });
        if (deps.signal?.aborted) controller.abort();
        try {
          result = await deps.strategy.fetchSnapshot(account, (deps.context ?? defaultContext)(account, controller.signal));
        } finally {
          deps.signal?.removeEventListener('abort', onAbort);
        }
        if (result.ok) {
          try { result = { ok: true, snapshot: isSnapshotForAccount(result.snapshot, account) }; }
          catch { result = { ok: false, error: { code: 'SCHEMA_CHANGED' } }; }
        }
      }
    } catch {
      result = { ok: false, error: { code: 'UNAVAILABLE' } };
    }

    if (result.ok) {
      const sample = jitter();
      const boundedJitter = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
      await persistSuccess(client, accountId, result.snapshot, current, new Date(current.getTime() + 300_000 + boundedJitter * 30_000), manualAt);
      return 'success';
    }
    await persistFailure(client, accountId, asFailure(result.error), Number(state.failure_count) + 1, current, manualAt);
    return 'failed';
  } catch (error) {
    discardClient = true;
    throw error;
  } finally {
    if (ownsLock && !discardClient) {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [accountId]); }
      catch { discardClient = true; }
    }
    client.release(discardClient);
  }
}
