import { eventDatabasePool } from '../../../../../server/events/database';
import { requireAdmin, verifyCsrf } from '../../../../../server/auth/session';
import { CodexLoginRepository, publicCodexLogin } from '../../../../../server/providers/codex/login-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'private, no-store' };
type Context = { params: Promise<{ id: string }> };

async function getAuthorized(request: Request, context: Context) {
  const pool = eventDatabasePool();
  const admin = await requireAdmin(request, pool);
  if (!admin) return { error: Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: NO_STORE }) };
  const { id } = await context.params;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return { error: Response.json({ error: 'NOT_FOUND' }, { status: 404, headers: NO_STORE }) };
  const repo = new CodexLoginRepository(pool);
  const login = await repo.read(id, admin.sessionId);
  if (!login) return { error: Response.json({ error: 'NOT_FOUND' }, { status: 404, headers: NO_STORE }) };
  return { pool, admin, repo, login };
}

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const result = await getAuthorized(request, context);
    return result.error ?? Response.json(publicCodexLogin(result.login!), { headers: NO_STORE });
  } catch { return Response.json({ error: 'LOGIN_UNAVAILABLE' }, { status: 503, headers: NO_STORE }); }
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  try {
    const result = await getAuthorized(request, context);
    if (result.error) return result.error;
    if (!await verifyCsrf(request, result.admin!.sessionId, result.pool!))
      return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers: NO_STORE });
    const cancelled = await result.repo!.cancel(result.login!.id, result.admin!.sessionId);
    return Response.json({ status: cancelled ? 'cancelled' : result.login!.status }, { status: cancelled ? 200 : 409, headers: NO_STORE });
  } catch { return Response.json({ error: 'LOGIN_UNAVAILABLE' }, { status: 503, headers: NO_STORE }); }
}
