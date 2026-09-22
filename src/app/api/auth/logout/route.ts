import { clearSessionCookie } from '../../../../server/auth/cookie';
import { deleteAdminSession, requireAdmin, verifyCsrf } from '../../../../server/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' };

export async function POST(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);
  if (!admin) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: NO_STORE });
  if (!await verifyCsrf(request, admin.sessionId)) return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers: NO_STORE });
  await deleteAdminSession(admin.sessionId);
  return new Response(null, { status: 204, headers: { ...NO_STORE, 'Set-Cookie': clearSessionCookie() } });
}
