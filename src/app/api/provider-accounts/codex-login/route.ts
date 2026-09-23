import { z } from 'zod';
import { eventDatabasePool } from '../../../../server/events/database';
import { requireAdmin, verifyCsrf } from '../../../../server/auth/session';
import { readBoundedJson } from '../../../../server/auth/request';
import { CodexLoginRepository, publicCodexLogin } from '../../../../server/providers/codex/login-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'private, no-store' };
const input = z.object({ label: z.string().trim().min(1).max(120) }).strict();

export async function POST(request: Request): Promise<Response> {
  const pool = eventDatabasePool();
  let admin;
  try { admin = await requireAdmin(request, pool); }
  catch { return Response.json({ error: 'AUTH_UNAVAILABLE' }, { status: 503, headers: NO_STORE }); }
  if (!admin) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: NO_STORE });
  if (!await verifyCsrf(request, admin.sessionId, pool)) return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers: NO_STORE });
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
    return Response.json({ error: 'INVALID_INPUT' }, { status: 400, headers: NO_STORE });
  const body = await readBoundedJson(request, 2048);
  if (!body.ok) return Response.json({ error: 'INVALID_INPUT' }, { status: 400, headers: NO_STORE });
  const parsed = input.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: 'INVALID_INPUT' }, { status: 400, headers: NO_STORE });
  try {
    const created = await new CodexLoginRepository(pool).create(admin.sessionId, parsed.data.label);
    return Response.json(publicCodexLogin(created), { status: 202, headers: NO_STORE });
  } catch (error) {
    if (error instanceof Error && error.message === 'LOGIN_IN_PROGRESS')
      return Response.json({ error: 'LOGIN_IN_PROGRESS' }, { status: 409, headers: NO_STORE });
    if (error instanceof Error && error.message === 'LOGIN_CAP_REACHED')
      return Response.json({ error: 'LOGIN_CAP_REACHED' }, { status: 429, headers: NO_STORE });
    return Response.json({ error: 'LOGIN_UNAVAILABLE' }, { status: 503, headers: NO_STORE });
  }
}
