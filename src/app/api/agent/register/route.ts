import { eventDatabasePool } from '../../../../server/events/database';
import { authenticateAdminToken } from '../../../../server/auth/login';
import { hasValidOrigin } from '../../../../server/auth/csrf';
import { readBoundedJson } from '../../../../server/auth/request';
import { adoptDeviceWithInstallGrant, registerDevice, registerDeviceWithInstallGrant } from '../../../../server/events/devices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' };

export async function POST(request: Request): Promise<Response> {
  if (request.headers.has('origin') && !hasValidOrigin(request)) {
    return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers: NO_STORE });
  }
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return Response.json({ error: 'JSON_REQUIRED' }, { status: 415, headers: NO_STORE });
  }
  const parsed = await readBoundedJson(request, 4_096);
  if (!parsed.ok) {
    const status = parsed.reason === 'too_large' ? 413 : 400;
    return Response.json({ error: 'INVALID_REQUEST' }, { status, headers: NO_STORE });
  }
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return Response.json({ error: 'INVALID_REQUEST' }, { status: 400, headers: NO_STORE });
  }
  const body = parsed.value as Record<string, unknown>;
  const hasUserToken = typeof body.userToken === 'string';
  const hasInstallGrant = typeof body.enrollmentGrant === 'string';
  const adopting = body.existingDeviceId !== undefined || body.existingDeviceToken !== undefined;
  if (Object.keys(body).some(key => !['userToken', 'enrollmentGrant', 'deviceName', 'idempotencyKey', 'existingDeviceId', 'existingDeviceToken'].includes(key)) ||
      hasUserToken === hasInstallGrant ||
      (adopting && (!hasInstallGrant || !/^[A-Za-z0-9_-]{1,128}$/.test(String(body.existingDeviceId ?? '')) ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(String(body.existingDeviceToken ?? '')))) ||
      (hasUserToken && (body.userToken as string).length > 256) ||
      (hasInstallGrant && !/^[A-Za-z0-9_-]{43}$/.test(body.enrollmentGrant as string)) ||
      typeof body.deviceName !== 'string' || body.deviceName.trim().length < 1 || body.deviceName.length > 120 ||
      (!adopting && (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.idempotencyKey))) ||
      (adopting && body.idempotencyKey !== undefined)) {
    return Response.json({ error: 'INVALID_REQUEST' }, { status: 400, headers: NO_STORE });
  }

  const pool = eventDatabasePool();
  try {
    let device;
    if (hasInstallGrant) {
      const outcome = adopting ? await adoptDeviceWithInstallGrant(
        body.deviceName as string, body.enrollmentGrant as string,
        body.existingDeviceId as string, body.existingDeviceToken as string, request, pool,
      ) : await registerDeviceWithInstallGrant(
        body.deviceName as string,
        body.enrollmentGrant as string,
        body.idempotencyKey as string,
        process.env.DEVICE_REGISTRATION_SECRET ?? '',
        request,
        pool,
      );
      if (outcome.status === 'invalid-grant') {
        return Response.json({ error: 'INVALID_OR_EXPIRED_INSTALL_LINK' }, { status: 401, headers: NO_STORE });
      }
      if (outcome.status === 'limited') {
        return Response.json({ error: 'REGISTRATION_RATE_LIMITED' }, {
          status: 429,
          headers: { ...NO_STORE, 'Retry-After': '900' },
        });
      }
      if (outcome.status === 'conflict') {
        return Response.json({ error: 'DEVICE_IDENTITY_CONFLICT' }, { status: 409, headers: NO_STORE });
      }
      device = outcome.device;
    } else {
      const auth = await authenticateAdminToken(request, body.userToken as string, pool);
      if (auth.status === 'limited') {
        return Response.json({ error: 'RATE_LIMITED' }, {
          status: 429,
          headers: { ...NO_STORE, 'Retry-After': String(auth.retryAfterSeconds ?? 60) },
        });
      }
      if (auth.status !== 'ok') {
        return Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: NO_STORE });
      }
      const registered = await registerDevice(
        body.deviceName as string,
        body.idempotencyKey as string,
        process.env.DEVICE_REGISTRATION_SECRET ?? '',
        request,
        pool,
      );
      if (!registered) {
        return Response.json({ error: 'REGISTRATION_RATE_LIMITED' }, {
          status: 429,
          headers: { ...NO_STORE, 'Retry-After': '900' },
        });
      }
      device = registered;
    }
    return Response.json({ deviceId: device.id, deviceToken: device.token }, { status: 201, headers: NO_STORE });
  } catch {
    return Response.json({ error: 'REGISTRATION_UNAVAILABLE' }, { status: 503, headers: NO_STORE });
  }
}
