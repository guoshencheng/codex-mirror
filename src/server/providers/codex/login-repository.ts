import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ProviderSnapshot } from '../../../contracts/quota';

export type CodexLoginStatus = 'queued' | 'starting' | 'awaiting' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
export interface CodexLoginRequest {
  id: string;
  accountId: string;
  label: string;
  sessionId: string;
  status: CodexLoginStatus;
  verificationUrl: string | null;
  userCode: string | null;
  loginId: string | null;
  error: string | null;
  expiresAt: string;
}

function mapped(row: Record<string, unknown>): CodexLoginRequest {
  return {
    id: String(row.id), accountId: String(row.account_id), label: String(row.label),
    sessionId: String(row.session_id), status: row.status as CodexLoginStatus,
    verificationUrl: row.verification_url == null ? null : String(row.verification_url),
    userCode: row.user_code == null ? null : String(row.user_code),
    loginId: row.login_id == null ? null : String(row.login_id),
    error: row.error_code == null ? null : String(row.error_code),
    expiresAt: new Date(row.expires_at as string).toISOString(),
  };
}

export function publicCodexLogin(request: CodexLoginRequest) {
  return {
    id: request.id, accountId: request.status === 'succeeded' ? request.accountId : null,
    status: request.status, verificationUrl: request.status === 'awaiting' ? request.verificationUrl : null,
    userCode: request.status === 'awaiting' ? request.userCode : null, error: request.error,
  };
}

export class CodexLoginRepository {
  constructor(readonly pool: Pool) {}

  async create(sessionId: string, label: string): Promise<CodexLoginRequest> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('codex-login-create', 0))");
      const existing = await client.query("SELECT 1 FROM codex_login_requests WHERE session_id = $1 AND status IN ('queued','starting','awaiting')", [sessionId]);
      if (existing.rowCount) throw new Error('LOGIN_IN_PROGRESS');
      const count = await client.query("SELECT count(*)::int AS n FROM codex_login_requests WHERE status IN ('queued','starting','awaiting')");
      if (Number(count.rows[0].n) >= 5) throw new Error('LOGIN_CAP_REACHED');
      const id = randomUUID();
      const accountId = `codex_${id.replaceAll('-', '')}`;
      const result = await client.query(`INSERT INTO codex_login_requests(id, account_id, session_id, label, status, expires_at)
        VALUES ($1, $2, $3, $4, 'queued', now() + interval '10 minutes') RETURNING *`, [id, accountId, sessionId, label]);
      await client.query('COMMIT');
      return mapped(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async read(id: string, sessionId: string): Promise<CodexLoginRequest | null> {
    const result = await this.pool.query('SELECT * FROM codex_login_requests WHERE id = $1 AND session_id = $2', [id, sessionId]);
    return result.rows[0] ? mapped(result.rows[0]) : null;
  }

  async cancel(id: string, sessionId: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE codex_login_requests SET status = 'cancelled', updated_at = now(),
      verification_url = NULL, user_code = NULL WHERE id = $1 AND session_id = $2
      AND status IN ('queued','starting','awaiting') RETURNING id`, [id, sessionId]);
    return Boolean(result.rowCount);
  }

  async claimNext(): Promise<CodexLoginRequest | null> {
    const result = await this.pool.query(`UPDATE codex_login_requests SET status = 'starting', updated_at = now()
      WHERE id = (SELECT id FROM codex_login_requests WHERE status = 'queued' AND expires_at > now()
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    return result.rows[0] ? mapped(result.rows[0]) : null;
  }

  async markAwaiting(id: string, verificationUrl: string, userCode: string, loginId: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE codex_login_requests SET status = 'awaiting', verification_url = $2,
      user_code = $3, login_id = $4, updated_at = now() WHERE id = $1 AND status = 'starting'
      AND expires_at > now() RETURNING id`, [id, verificationUrl, userCode, loginId]);
    return Boolean(result.rowCount);
  }

  async status(id: string): Promise<CodexLoginStatus | null> {
    const result = await this.pool.query('SELECT status FROM codex_login_requests WHERE id = $1', [id]);
    return result.rows[0]?.status ?? null;
  }

  async complete(id: string, snapshot: ProviderSnapshot): Promise<boolean> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const request = await client.query("SELECT * FROM codex_login_requests WHERE id = $1 AND status = 'awaiting' AND expires_at > now() FOR UPDATE", [id]);
      if (!request.rows[0]) { await client.query('ROLLBACK'); return false; }
      const row = mapped(request.rows[0]);
      const now = new Date();
      await client.query(`INSERT INTO provider_accounts(id, provider_id, label, credential_ref)
        VALUES ($1, 'codex', $2, 'managed-codex-login')`, [row.accountId, row.label]);
      await client.query(`INSERT INTO quota_refresh_status(account_id, last_attempt_at, last_success_at, next_attempt_at)
        VALUES ($1, $2, $2, $3)`, [row.accountId, now, new Date(now.getTime() + 300_000)]);
      await client.query('INSERT INTO quota_latest(account_id, snapshot) VALUES ($1, $2::jsonb)', [row.accountId, JSON.stringify(snapshot)]);
      await client.query('INSERT INTO quota_snapshots(account_id, observed_at, snapshot) VALUES ($1, $2, $3::jsonb)', [row.accountId, snapshot.observedAt, JSON.stringify(snapshot)]);
      await client.query("UPDATE codex_login_requests SET status = 'succeeded', verification_url = NULL, user_code = NULL, updated_at = now() WHERE id = $1", [id]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async fail(id: string, code: string): Promise<void> {
    await this.pool.query(`UPDATE codex_login_requests SET status = 'failed', error_code = $2,
      verification_url = NULL, user_code = NULL, updated_at = now()
      WHERE id = $1 AND status IN ('queued','starting','awaiting')`, [id, code]);
  }

  async recoverStale(): Promise<void> {
    await this.pool.query(`UPDATE codex_login_requests SET status = 'expired', error_code = 'LOGIN_EXPIRED',
      verification_url = NULL, user_code = NULL, updated_at = now()
      WHERE status IN ('queued','starting','awaiting') AND expires_at <= now()`);
    await this.pool.query(`UPDATE codex_login_requests SET status = 'failed', error_code = 'WORKER_RESTARTED',
      verification_url = NULL, user_code = NULL, updated_at = now()
      WHERE status IN ('starting','awaiting') AND updated_at < now() - interval '2 minutes'`);
  }
}
