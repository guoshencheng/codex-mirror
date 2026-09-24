import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  verifyCsrf: vi.fn(),
  createDeviceInstallGrant: vi.fn(),
  hasUsableDeviceInstallGrant: vi.fn(),
  expectedAppOrigin: vi.fn(),
  pool: {},
}));

vi.mock('../../src/server/auth/session', () => ({ requireAdmin: mocks.requireAdmin, verifyCsrf: mocks.verifyCsrf }));
vi.mock('../../src/server/auth/csrf', () => ({
  expectedAppOrigin: mocks.expectedAppOrigin,
  isJsonRequest: (request: Request) => request.headers.get('content-type')?.split(';', 1)[0] === 'application/json',
}));
vi.mock('../../src/server/events/database', () => ({ eventDatabasePool: () => mocks.pool }));
vi.mock('../../src/server/events/devices', () => ({
  createDeviceInstallGrant: mocks.createDeviceInstallGrant,
  hasUsableDeviceInstallGrant: mocks.hasUsableDeviceInstallGrant,
}));

import { POST } from '../../src/app/api/devices/install-link/route';
import { GET } from '../../src/app/api/collector/install/route';

describe('cloud-generated device installer links', () => {
  beforeEach(() => {
    mocks.requireAdmin.mockResolvedValue({ id: 'owner', sessionId: 'session-1' });
    mocks.verifyCsrf.mockResolvedValue(true);
    mocks.expectedAppOrigin.mockReturnValue('https://dashboard.example');
    mocks.createDeviceInstallGrant.mockResolvedValue({ token: 'g'.repeat(43), expiresAt: '2026-09-22T12:15:00.000Z' });
    mocks.hasUsableDeviceInstallGrant.mockResolvedValue(true);
  });

  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

  it('issues a short-lived enrollment URL only for a CSRF-protected admin session', async () => {
    const request = new Request('https://dashboard.example/api/devices/install-link', {
      method: 'POST',
      headers: {
        origin: 'https://dashboard.example',
        'content-type': 'application/json',
        'x-csrf-token': 'c'.repeat(43),
      },
      body: '{}',
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      installUrl: 'https://dashboard.example/api/collector/install?grant=' + 'g'.repeat(43),
      collectorOrigin: 'https://dashboard.example',
      expiresAt: '2026-09-22T12:15:00.000Z',
    });
    expect(mocks.verifyCsrf).toHaveBeenCalledWith(request, 'session-1');
    expect(mocks.createDeviceInstallGrant).toHaveBeenCalledWith(mocks.pool);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('serves a no-store shell installer containing only the scoped grant', async () => {
    const response = await GET(new Request('https://dashboard.example/api/collector/install?grant=' + 'g'.repeat(43)));
    const script = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/x-shellscript');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(script).toContain("COLLECTOR_ENROLLMENT_GRANT='" + 'g'.repeat(43) + "'");
    expect(script).toContain('https://dashboard.example/install.sh');
    expect(script).not.toContain('cdu_');
  });

  it('uses a reachable collector domain independently of the Dashboard login origin', async () => {
    vi.stubEnv('COLLECTOR_PUBLIC_ORIGIN', 'https://collector.example');
    const request = new Request('https://dashboard.example/api/devices/install-link', {
      method: 'POST',
      headers: { origin: 'https://dashboard.example', 'content-type': 'application/json', 'x-csrf-token': 'c'.repeat(43) },
      body: '{}',
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      installUrl: 'https://collector.example/api/collector/install?grant=' + 'g'.repeat(43),
      collectorOrigin: 'https://collector.example',
    });
    const installer = await GET(new Request('https://collector.example/api/collector/install?grant=' + 'g'.repeat(43)));
    const script = await installer.text();
    expect(installer.status).toBe(200);
    expect(script).toContain('https://collector.example/install.sh');
    expect(script).toContain("COLLECTOR_SERVER_URL='https://collector.example'");
  });

  it('does not serve a script for an invalid or already-used grant', async () => {
    mocks.hasUsableDeviceInstallGrant.mockResolvedValue(false);
    const response = await GET(new Request('https://dashboard.example/api/collector/install?grant=' + 'g'.repeat(43)));
    expect(response.status).toBe(410);
    expect(mocks.hasUsableDeviceInstallGrant).toHaveBeenCalledWith('g'.repeat(43), mocks.pool);
  });

  it('does not issue a link when the admin session is missing', async () => {
    mocks.requireAdmin.mockResolvedValue(null);
    const response = await POST(new Request('https://dashboard.example/api/devices/install-link', {
      method: 'POST',
      headers: { origin: 'https://dashboard.example', 'content-type': 'application/json', 'x-csrf-token': 'c'.repeat(43) },
      body: '{}',
    }));
    expect(response.status).toBe(401);
    expect(mocks.createDeviceInstallGrant).not.toHaveBeenCalled();
  });
});
