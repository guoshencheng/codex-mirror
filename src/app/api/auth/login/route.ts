import { authenticateAdmin } from '../../../../server/auth/login';
import { SESSION_LIFETIME_SECONDS, serializeSessionCookie } from '../../../../server/auth/cookie';
import { hasValidOrigin, isJsonRequest } from '../../../../server/auth/csrf';
import { readBoundedJson } from '../../../../server/auth/request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' };

export async function POST(request: Request): Promise<Response> {
  if (!hasValidOrigin(request)) return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers: NO_STORE });
  if (!isJsonRequest(request)) return Response.json({ error: 'JSON_REQUIRED' }, { status: 415, headers: NO_STORE });
  const parsed = await readBoundedJson(request, 4_096);
  if (!parsed.ok) return Response.json({ error: parsed.reason === 'too_large' ? 'REQUEST_TOO_LARGE' : 'INVALID_REQUEST' }, { status: parsed.reason === 'too_large' ? 413 : 400, headers: NO_STORE });
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'INVALID_REQUEST' }, { status: 400, headers: NO_STORE });
  const values = body as Record<string, unknown>;
  if (typeof values.username !== 'string' || typeof values.password !== 'string' || values.username.length > 120 || Buffer.byteLength(values.password, 'utf8') > 1_024) {
    return Response.json({ error: 'INVALID_REQUEST' }, { status: 400, headers: NO_STORE });
  }

  const result = await authenticateAdmin(request, values.username, values.password);
  if (result.status === 'limited') {
    return Response.json({ error: 'RATE_LIMITED' }, {
      status: 429,
      headers: { ...NO_STORE, 'Retry-After': String(result.retryAfterSeconds) },
    });
  }
  if (result.status !== 'ok' || !result.token || !result.csrfToken || !result.expiresAt) {
    return Response.json({ error: 'INVALID_CREDENTIALS' }, { status: 401, headers: NO_STORE });
  }
  return Response.json({ csrfToken: result.csrfToken, expiresAt: result.expiresAt, expiresIn: SESSION_LIFETIME_SECONDS }, {
    status: 200,
    headers: { ...NO_STORE, 'Set-Cookie': serializeSessionCookie(result.token) },
  });
}
