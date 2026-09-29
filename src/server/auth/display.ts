import { matchesConfiguredUserToken } from './configured-token';

export const DISPLAY_NO_STORE = { 'Cache-Control': 'private, no-store', Vary: 'Origin' } as const;

function errorResponse(error: string, status: number, headers: HeadersInit = DISPLAY_NO_STORE): Response {
  return Response.json({ error }, { status, headers });
}

export function allowedDisplayOrigin(request: Request): string | null | false {
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

export function displayResponseHeaders(origin: string | null): HeadersInit {
  return origin ? { ...DISPLAY_NO_STORE, 'Access-Control-Allow-Origin': origin } : DISPLAY_NO_STORE;
}

export type DisplayAuthorization =
  | { token: string; origin: string | null; headers: HeadersInit }
  | { response: Response };

export function authorizeDisplayRequest(request: Request): DisplayAuthorization {
  const origin = allowedDisplayOrigin(request);
  if (origin === false) return { response: errorResponse('FORBIDDEN', 403) };
  const match = /^Bearer ([23456789abcdefghjkmnpqrstvwxyz]{8}|cdu_[A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '');
  if (!match) return { response: errorResponse('UNAUTHORIZED', 401, displayResponseHeaders(origin)) };
  try {
    if (!matchesConfiguredUserToken(match[1]!)) return { response: errorResponse('UNAUTHORIZED', 401, displayResponseHeaders(origin)) };
  } catch {
    return { response: errorResponse('AUTH_UNAVAILABLE', 503, displayResponseHeaders(origin)) };
  }
  return { token: match[1]!, origin, headers: displayResponseHeaders(origin) };
}

export function displayPreflight(request: Request): Response {
  const origin = allowedDisplayOrigin(request);
  if (origin === false || !origin || request.headers.get('access-control-request-method') !== 'GET') {
    return new Response(null, { status: 403, headers: DISPLAY_NO_STORE });
  }
  return new Response(null, {
    status: 204,
    headers: { ...displayResponseHeaders(origin), 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization' },
  });
}
