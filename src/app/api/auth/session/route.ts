import { rotateCsrfToken } from '../../../../server/auth/csrf';
import { requireAdmin } from '../../../../server/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' };

export async function GET(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);
  if (!admin) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: NO_STORE });
  const csrfToken = await rotateCsrfToken(admin.sessionId);
  if (!csrfToken) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: NO_STORE });
  return Response.json({ admin: { id: admin.id }, csrfToken }, { status: 200, headers: NO_STORE });
}
