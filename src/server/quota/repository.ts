import type { Pool, PoolClient } from 'pg';
import type { ProviderAccountConfig, ProviderFailureCode, ProviderSnapshot } from '../../contracts/quota';

export interface QuotaLatestState {
  snapshot: ProviderSnapshot | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  errorCode: ProviderFailureCode | null;
  nextAttemptAt: string | null;
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : value == null ? null : new Date(String(value)).toISOString();
}

export class QuotaRepository {
  constructor(readonly pool: Pool) {}

  async upsertConfiguredAccounts(accounts: readonly ProviderAccountConfig[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ids = accounts.map(account => account.id);
      for (const account of accounts) {
        await client.query(`
          INSERT INTO provider_accounts (id, provider_id, label, credential_ref, options, enabled)
          VALUES ($1, $2, $3, $4, $5::jsonb, true)
          ON CONFLICT (id) DO UPDATE SET provider_id = EXCLUDED.provider_id, label = EXCLUDED.label,
            credential_ref = EXCLUDED.credential_ref, options = EXCLUDED.options, enabled = true, updated_at = now()
        `, [account.id, account.providerId, account.label, account.credentialRef, JSON.stringify(account.options)]);
        await client.query('INSERT INTO quota_refresh_status (account_id) VALUES ($1) ON CONFLICT DO NOTHING', [account.id]);
      }
      await client.query('UPDATE provider_accounts SET enabled = false, updated_at = now() WHERE NOT (id = ANY($1::text[]))', [ids]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async readLatest(accountId: string): Promise<QuotaLatestState> {
    const result = await this.pool.query(`
      SELECT l.snapshot, s.last_attempt_at, s.last_success_at, s.error_code, s.next_attempt_at
      FROM provider_accounts a
      LEFT JOIN quota_latest l ON l.account_id = a.id
      LEFT JOIN quota_refresh_status s ON s.account_id = a.id
      WHERE a.id = $1
    `, [accountId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return { snapshot: null, lastAttemptAt: null, lastSuccessAt: null, errorCode: null, nextAttemptAt: null };
    return {
      snapshot: row.snapshot as ProviderSnapshot | null,
      lastAttemptAt: iso(row.last_attempt_at),
      lastSuccessAt: iso(row.last_success_at),
      errorCode: row.error_code as ProviderFailureCode | null,
      nextAttemptAt: iso(row.next_attempt_at),
    };
  }

  async loadAccount(client: PoolClient, accountId: string): Promise<ProviderAccountConfig | null> {
    const result = await client.query(`
      SELECT id, provider_id, label, credential_ref, options FROM provider_accounts
      WHERE id = $1 AND enabled = true
    `, [accountId]);
    const row = result.rows[0] as { id: string; provider_id: string; label: string; credential_ref: string; options: Record<string, unknown> } | undefined;
    return row ? { id: row.id, providerId: row.provider_id, label: row.label, credentialRef: row.credential_ref, options: row.options } : null;
  }

  async listDueAccounts(now: Date, limit: number): Promise<string[]> {
    const result = await this.pool.query(`
      SELECT a.id FROM provider_accounts a JOIN quota_refresh_status s ON s.account_id = a.id
      WHERE a.enabled = true AND (s.manual_requested_at IS NOT NULL OR (s.auth_blocked = false AND s.next_attempt_at <= $1))
      ORDER BY (s.manual_requested_at IS NOT NULL) DESC, s.next_attempt_at ASC LIMIT $2
    `, [now, limit]);
    return result.rows.map(row => String((row as { id: string }).id));
  }

  async cleanupHistory(before: Date): Promise<number> {
    const result = await this.pool.query('DELETE FROM quota_snapshots WHERE observed_at < $1', [before]);
    return result.rowCount ?? 0;
  }
}
