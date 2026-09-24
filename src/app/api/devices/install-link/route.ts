import { eventDatabasePool } from '../../../../server/events/database';
import { isJsonRequest } from '../../../../server/auth/csrf';
import { requireAdmin, verifyCsrf } from '../../../../server/auth/session';
import { readBoundedJson } from '../../../../server/auth/request';
import { createDeviceInstallGrant } from '../../../../server/events/devices';
import { collectorPublicOrigin } from '../../../../server/events/install-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' };

export async function POST(request: Request): Promise<Response> {
  if (!isJsonRequest(request)) return Response.json({ error: 'JSON_REQUIRED' }, { status: 415, headers: NO_STORE });
  const admin = await requireAdmin(request);
  if (!admin) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: NO_STORE });
  if (!(await verifyCsrf(request, admin.sessionId))) return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers: NO_STORE });

  const parsed = await readBoundedJson(request, 1_024);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value) || Object.keys(parsed.value).length !== 0) {
    const status = parsed.ok ? 400 : parsed.reason === 'too_large' ? 413 : 400;
    return Response.json({ error: 'INVALID_REQUEST' }, { status, headers: NO_STORE });
  }

  try {
    const grant = await createDeviceInstallGrant(eventDatabasePool());
    const collectorOrigin = collectorPublicOrigin();
    const installUrl = new URL('/api/collector/install', collectorOrigin);
    installUrl.searchParams.set('grant', grant.token);
    return Response.json({ installUrl: installUrl.toString(), collectorOrigin, expiresAt: grant.expiresAt }, { status: 201, headers: NO_STORE });
  } catch {
    return Response.json({ error: 'INSTALL_LINK_UNAVAILABLE' }, { status: 503, headers: NO_STORE });
  }
}
