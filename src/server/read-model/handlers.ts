import type { Pool } from 'pg';
import { requireAdmin, verifyCsrf } from '../auth/session';
import { requestRefresh } from '../quota/requests';
import { getAccounts, getDashboard, getDevices, getSessions } from './dashboard';
import { createAdminStream, type AdminStreamOptions } from '../stream/sse';

const PRIVATE_NO_STORE = { 'Cache-Control': 'private, no-store' };
type RefreshContext = { params: Promise<{ id: string }> };
type DashboardHandlerOptions = { stream?: Partial<AdminStreamOptions> };

function jsonError(error: string, status: number, headers: HeadersInit = PRIVATE_NO_STORE): Response {
  return Response.json({ error }, { status, headers });
}

export function createDashboardHandlers(pool: Pool, options: DashboardHandlerOptions = {}) {
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
        const status = await requestRefresh(id, new Date(), pool);
        if (status === 'cooldown') return Response.json({ status }, { status: 429, headers: { ...PRIVATE_NO_STORE, 'Retry-After': '30' } });
        return Response.json({ status }, { status: 202, headers: PRIVATE_NO_STORE });
      } catch (error) {
        if (error instanceof Error && error.message === 'ACCOUNT_NOT_FOUND') return jsonError('NOT_FOUND', 404);
        return jsonError('REFRESH_UNAVAILABLE', 503);
      }
    },
    async stream(request: Request): Promise<Response> {
      const auth = await authorize(request);
      if (auth.status === 'unauthorized') return jsonError('UNAUTHORIZED', 401);
      if (auth.status === 'unavailable') return jsonError('AUTH_UNAVAILABLE', 503);
      const admin = auth.admin;
      try { return await createAdminStream(request, admin.sessionId, options.stream); }
      catch (error) {
        if (error instanceof Error && error.message === 'STREAM_AUTH_EXPIRED') return jsonError('UNAUTHORIZED', 401);
        if (error instanceof Error && error.message === 'STREAM_LIMIT') {
          return jsonError('STREAM_LIMIT', 429, { ...PRIVATE_NO_STORE, 'Retry-After': '5' });
        }
        return jsonError('STREAM_UNAVAILABLE', 503);
      }
    },
  };
}
