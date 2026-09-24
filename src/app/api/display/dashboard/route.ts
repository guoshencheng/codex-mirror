import { matchesConfiguredUserToken } from '../../../../server/auth/configured-token';
import { getDashboard } from '../../../../server/read-model/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store', Vary: 'Origin' };

function allowedOrigin(request: Request): string | null | false {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  let parsed: URL;
  try { parsed = new URL(origin); }
  catch { return false; }
  if (parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol)) return false;
  const configured = (process.env.DASHBOARD_DISPLAY_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (process.env.APP_ORIGIN) configured.push(process.env.APP_ORIGIN);
  return configured.includes(origin) ? origin : false;
}

function responseHeaders(origin: string | null): HeadersInit {
  return origin ? { ...NO_STORE, 'Access-Control-Allow-Origin': origin } : NO_STORE;
}

export async function GET(request: Request): Promise<Response> {
  const origin = allowedOrigin(request);
  if (origin === false) return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers: NO_STORE });
  const match = /^Bearer ([23456789abcdefghjkmnpqrstvwxyz]{8}|cdu_[A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '');
  if (!match) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: responseHeaders(origin) });
  try {
    if (!matchesConfiguredUserToken(match[1]!)) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: responseHeaders(origin) });
    return Response.json(await getDashboard(), { headers: responseHeaders(origin) });
  } catch {
    return Response.json({ error: 'UNAVAILABLE' }, { status: 503, headers: responseHeaders(origin) });
  }
}

export async function OPTIONS(request: Request): Promise<Response> {
  const origin = allowedOrigin(request);
  if (origin === false || !origin || request.headers.get('access-control-request-method') !== 'GET') {
    return new Response(null, { status: 403, headers: NO_STORE });
  }
  return new Response(null, {
    status: 204,
    headers: { ...responseHeaders(origin), 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization' },
  });
}
