import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticateAdminToken: vi.fn(),
  registerDevice: vi.fn(),
  registerDeviceWithInstallGrant: vi.fn(),
  adoptDeviceWithInstallGrant: vi.fn(),
  pool: {},
}));

vi.mock('../../src/server/events/database', () => ({ eventDatabasePool: () => mocks.pool }));
vi.mock('../../src/server/auth/login', () => ({ authenticateAdminToken: mocks.authenticateAdminToken }));
vi.mock('../../src/server/events/devices', () => ({
  registerDevice: mocks.registerDevice,
  registerDeviceWithInstallGrant: mocks.registerDeviceWithInstallGrant,
  adoptDeviceWithInstallGrant: mocks.adoptDeviceWithInstallGrant,
}));

import { POST } from '../../src/app/api/agent/register/route';

describe('device registration with an install grant', () => {
  beforeEach(() => {
    process.env.APP_ORIGIN = 'https://dashboard.example';
    process.env.DEVICE_REGISTRATION_SECRET = 'registration-secret-with-at-least-32-characters';
    mocks.authenticateAdminToken.mockResolvedValue({ status: 'invalid' });
    mocks.registerDeviceWithInstallGrant.mockResolvedValue({
      status: 'ok',
      device: { id: 'device-1', name: 'Mac mini', token: 'd'.repeat(43) },
    });
  });

  afterEach(() => vi.clearAllMocks());

  it('registers a device from an install grant without sending a Dashboard Token', async () => {
    const request = new Request('https://dashboard.example/api/agent/register', {
      method: 'POST',
      headers: { origin: 'https://dashboard.example', 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentGrant: 'g'.repeat(43), deviceName: 'Mac mini', idempotencyKey: 'i'.repeat(43) }),
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ deviceId: 'device-1', deviceToken: 'd'.repeat(43) });
    expect(mocks.authenticateAdminToken).not.toHaveBeenCalled();
    expect(mocks.registerDeviceWithInstallGrant).toHaveBeenCalledWith(
      'Mac mini', 'g'.repeat(43), 'i'.repeat(43), 'registration-secret-with-at-least-32-characters', request, mocks.pool,
    );
  });

  it('keeps Dashboard Token registration working for the existing installer', async () => {
    mocks.authenticateAdminToken.mockResolvedValue({ status: 'ok', adminId: 'owner' });
    mocks.registerDevice.mockResolvedValue({ id: 'device-2', name: 'Linux', token: 'e'.repeat(43) });
    const request = new Request('https://dashboard.example/api/agent/register', {
      method: 'POST',
      headers: { origin: 'https://dashboard.example', 'content-type': 'application/json' },
      body: JSON.stringify({ userToken: 'cdu_' + 'u'.repeat(43), deviceName: 'Linux', idempotencyKey: 'j'.repeat(43) }),
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(mocks.authenticateAdminToken).toHaveBeenCalledOnce();
    expect(mocks.registerDevice).toHaveBeenCalledOnce();
    expect(mocks.registerDeviceWithInstallGrant).not.toHaveBeenCalled();
  });

  it('adopts the old device ID and token only with an install grant', async () => {
    const deviceToken = 'd'.repeat(43);
    mocks.adoptDeviceWithInstallGrant.mockResolvedValue({
      status: 'ok', device: { id: 'old-device', name: 'MacBook', token: deviceToken },
    });
    const body = { enrollmentGrant: 'g'.repeat(43), deviceName: 'MacBook',
      existingDeviceId: 'old-device', existingDeviceToken: deviceToken };
    const request = new Request('https://dashboard.example/api/agent/register', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ deviceId: 'old-device', deviceToken });
    expect(mocks.adoptDeviceWithInstallGrant).toHaveBeenCalledWith('MacBook', body.enrollmentGrant,
      'old-device', deviceToken, request, mocks.pool);

    const forbidden = new Request('https://dashboard.example/api/agent/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, enrollmentGrant: undefined, userToken: 'u'.repeat(43) }),
    });
    expect((await POST(forbidden)).status).toBe(400);
  });
});
