import type { Pool, PoolClient } from 'pg';
import type { DashboardAccount, DashboardDto, RefreshStatus } from '../../contracts/dashboard';
import type { ProviderFailureCode, ProviderSnapshot } from '../../contracts/quota';
import { validateProviderSnapshot } from '../providers/metric-schema';
import { applicationDatabasePool } from '../db/application-pool';

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function refreshState(row: {
  manual_requested_at: Date | string | null;
  last_attempt_at: Date | string | null;
  last_success_at: Date | string | null;
  error_code: string | null;
}, now: Date): RefreshStatus {
  const manual = row.manual_requested_at ? new Date(row.manual_requested_at).getTime() : null;
  const attempt = row.last_attempt_at ? new Date(row.last_attempt_at).getTime() : null;
  const success = row.last_success_at ? new Date(row.last_success_at).getTime() : null;
  if (attempt !== null && (success === null || attempt > success) && now.getTime() - attempt < 120_000) return 'running';
  if (manual !== null && (attempt === null || attempt < manual)) return now.getTime() - manual < 120_000 ? 'queued' : 'error';
  if (row.error_code) return 'error';
  return 'idle';
}

function accountFailure(value: string | null): ProviderFailureCode | null {
  const values: readonly string[] = ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'FORBIDDEN', 'RATE_LIMITED', 'TIMEOUT', 'UNAVAILABLE', 'SCHEMA_CHANGED', 'UNSUPPORTED'];
  return value && values.includes(value) ? value as ProviderFailureCode : null;
}

async function readAccounts(client: PoolClient, now: Date): Promise<DashboardAccount[]> {
  const result = await client.query(`SELECT a.id, a.provider_id, a.label, q.snapshot,
      s.last_attempt_at, s.last_success_at, s.error_code, s.manual_requested_at
    FROM provider_accounts a
    LEFT JOIN quota_latest q ON q.account_id = a.id
    LEFT JOIN quota_refresh_status s ON s.account_id = a.id
    WHERE a.enabled = true ORDER BY lower(a.label), a.id`);
  return result.rows.map(raw => {
    const row = raw as {
      id: string; provider_id: string; label: string; snapshot: unknown;
      last_attempt_at: Date | string | null; last_success_at: Date | string | null;
      error_code: string | null; manual_requested_at: Date | string | null;
    };
    let snapshot: ProviderSnapshot | null = null;
    if (row.snapshot) {
      try { snapshot = validateProviderSnapshot(row.snapshot); }
      catch { snapshot = null; }
    }
    return {
      id: row.id,
      providerId: row.provider_id,
      label: row.label,
      snapshot,
      lastAttemptAt: toIso(row.last_attempt_at),
      lastSuccessAt: toIso(row.last_success_at),
      errorCode: accountFailure(row.error_code),
      refreshStatus: refreshState(row, now),
    };
  });
}

export async function getDashboard(now = new Date(), pool: Pool = applicationDatabasePool()): Promise<DashboardDto> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const accounts = await readAccounts(client, now);
    await client.query('COMMIT');
    return { generatedAt: now.toISOString(), accounts };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function getAccounts(now = new Date(), pool: Pool = applicationDatabasePool()): Promise<DashboardAccount[]> {
  return (await getDashboard(now, pool)).accounts;
}
