import type { Pool } from 'pg';

export type RefreshRequestResult = 'queued' | 'cooldown' | 'running';

export async function requestRefresh(accountId: string, now: Date, pool: Pool): Promise<RefreshRequestResult> {
  const client = await pool.connect();
  let ownsProbeLock = false;
  try {
    await client.query('BEGIN');
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked', [accountId]);
    ownsProbeLock = Boolean(lock.rows[0]?.locked);
    if (!ownsProbeLock) {
      await client.query('COMMIT');
      return 'running';
    }
    const result = await client.query(`
      SELECT a.enabled, s.last_manual_at
      FROM provider_accounts a JOIN quota_refresh_status s ON s.account_id = a.id
      WHERE a.id = $1 FOR UPDATE OF a, s
    `, [accountId]);
    const row = result.rows[0] as { enabled: boolean; last_manual_at: Date | null } | undefined;
    if (!row || !row.enabled) {
      await client.query('ROLLBACK');
      throw new Error('ACCOUNT_NOT_FOUND');
    }
    if (row.last_manual_at && now.getTime() - new Date(row.last_manual_at).getTime() < 30_000) {
      await client.query('COMMIT');
      return 'cooldown';
    }
    await client.query(`
      UPDATE quota_refresh_status SET manual_requested_at = $2, last_manual_at = $2,
        auth_blocked = false, next_attempt_at = LEAST(next_attempt_at, $2)
      WHERE account_id = $1
    `, [accountId, now]);
    await client.query("SELECT pg_notify('dashboard_changed', 'quota')");
    await client.query('COMMIT');
    return 'queued';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
