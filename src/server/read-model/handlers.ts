import type { Pool } from 'pg';
import { requireAdmin, verifyCsrf } from '../auth/session';
import { requestRefresh } from '../quota/requests';
import { managedStrategy } from '../providers/managed';
import { readManagedCredential } from '../providers/managed-credentials';
import { getAccounts, getDashboard, getDevices, getSessions } from './dashboard';

const PRIVATE_NO_STORE = { 'Cache-Control': 'private, no-store' };
type RefreshContext = { params: Promise<{ id: string }> };

function jsonError(error: string, status: number, headers: HeadersInit = PRIVATE_NO_STORE): Response {
  return Response.json({ error }, { status, headers });
}

export function createDashboardHandlers(pool: Pool) {
  async function authorize(request: Request) {
    try {
      const admin = await requireAdmin(request, pool);
      return admin ? { status: 'ok' as const, admin } : { status: 'unauthorized' as const };
    } catch { return { status: 'unavailable' as const }; }
  }

  return {
    async dashboard(request: Request): Promise<Response> {
      const auth = await authorize(request);
      if (auth.status === 'unauthorized') return jsonError('UNAUTHORIZED', 401);
      if (auth.status === 'unavailable') return jsonError('AUTH_UNAVAILABLE', 503);
      try { return Response.json(await getDashboard(new Date(), pool), { headers: PRIVATE_NO_STORE }); }
      catch { return jsonError('DASHBOARD_UNAVAILABLE', 503); }
    },
    async devices(request: Request): Promise<Response> {
      const auth = await authorize(request);
      if (auth.status === 'unauthorized') return jsonError('UNAUTHORIZED', 401);
      if (auth.status === 'unavailable') return jsonError('AUTH_UNAVAILABLE', 503);
      try { return Response.json(await getDevices(new Date(), pool), { headers: PRIVATE_NO_STORE }); }
      catch { return jsonError('DASHBOARD_UNAVAILABLE', 503); }
    },
    async sessions(request: Request): Promise<Response> {
      const auth = await authorize(request);
      if (auth.status === 'unauthorized') return jsonError('UNAUTHORIZED', 401);
      if (auth.status === 'unavailable') return jsonError('AUTH_UNAVAILABLE', 503);
      try { return Response.json(await getSessions(new Date(), pool), { headers: PRIVATE_NO_STORE }); }
      catch { return jsonError('DASHBOARD_UNAVAILABLE', 503); }
    },
    async accounts(request: Request): Promise<Response> {
      const auth = await authorize(request);
      if (auth.status === 'unauthorized') return jsonError('UNAUTHORIZED', 401);
      if (auth.status === 'unavailable') return jsonError('AUTH_UNAVAILABLE', 503);
      try { return Response.json(await getAccounts(new Date(), pool), { headers: PRIVATE_NO_STORE }); }
      catch { return jsonError('DASHBOARD_UNAVAILABLE', 503); }
    },
    async refresh(request: Request, context: RefreshContext): Promise<Response> {
      const auth = await authorize(request);
      if (auth.status === 'unauthorized') return jsonError('UNAUTHORIZED', 401);
      if (auth.status === 'unavailable') return jsonError('AUTH_UNAVAILABLE', 503);
      const admin = auth.admin;
      if (!await verifyCsrf(request, admin.sessionId, pool)) return jsonError('FORBIDDEN', 403);
      let id: string;
      try { id = (await context.params).id; }
      catch { return jsonError('NOT_FOUND', 404); }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return jsonError('NOT_FOUND', 404);
      try {
        const managed = await pool.query('SELECT provider_id, credential_ref FROM provider_accounts WHERE id = $1 AND enabled = true', [id]);
        const managedAccount = managed.rows[0] as { provider_id: string; credential_ref: string } | undefined;
        const status = await requestRefresh(id, new Date(), pool);
        if (status === 'cooldown') return Response.json({ status }, { status: 429, headers: { ...PRIVATE_NO_STORE, 'Retry-After': '30' } });
        const strategy = managedAccount?.credential_ref === `db:${id}` ? managedStrategy(managedAccount.provider_id) : null;
        if (strategy && status === 'queued') {
          const outcome = await strategy.fetchSnapshot({ id, providerId: managedAccount!.provider_id, label: '', credentialRef: managedAccount!.credential_ref, options: {} }, {
            signal: new AbortController().signal, readSecret: () => readManagedCredential(id, pool),
          });
          const now = new Date();
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            if (outcome.ok) {
              const snapshot = JSON.stringify(outcome.snapshot);
              await client.query('INSERT INTO quota_latest (account_id, snapshot) VALUES ($1, $2::jsonb) ON CONFLICT (account_id) DO UPDATE SET snapshot = EXCLUDED.snapshot', [id, snapshot]);
              await client.query('INSERT INTO quota_snapshots (account_id, observed_at, snapshot) VALUES ($1, $2, $3::jsonb)', [id, outcome.snapshot.observedAt, snapshot]);
              await client.query('UPDATE quota_refresh_status SET last_attempt_at = $2, last_success_at = $2, error_code = NULL, manual_requested_at = NULL, next_attempt_at = $3 WHERE account_id = $1', [id, now, new Date(now.getTime() + 300_000)]);
            } else {
              await client.query('UPDATE quota_refresh_status SET last_attempt_at = $2, error_code = $3, manual_requested_at = NULL, next_attempt_at = $4 WHERE account_id = $1', [id, now, outcome.error.code, new Date(now.getTime() + 60_000)]);
            }
            await client.query('COMMIT');
          } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
          finally { client.release(); }
          return Response.json({ status: outcome.ok ? 'success' : 'failed' }, { status: outcome.ok ? 200 : 502, headers: PRIVATE_NO_STORE });
        }
        return Response.json({ status }, { status: 202, headers: PRIVATE_NO_STORE });
      } catch (error) {
        if (error instanceof Error && error.message === 'ACCOUNT_NOT_FOUND') return jsonError('NOT_FOUND', 404);
        return jsonError('REFRESH_UNAVAILABLE', 503);
      }
    },
  };
}
