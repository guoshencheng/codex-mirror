import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(), verifyCsrf: vi.fn(), query: vi.fn(),
}));
vi.mock('../../src/server/auth/session', () => ({ requireAdmin: mocks.requireAdmin, verifyCsrf: mocks.verifyCsrf }));
vi.mock('../../src/server/events/database', () => ({ eventDatabasePool: () => ({ query: mocks.query }) }));

import { POST } from '../../src/app/api/devices/rename/route';

function request(body: object): Request {
  return new Request('https://dashboard.example/api/devices/rename', {
    method: 'POST', headers: { origin: 'https://dashboard.example', 'content-type': 'application/json', 'x-csrf-token': 'c'.repeat(43) },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ id: 'admin', sessionId: 'session' });
  mocks.verifyCsrf.mockResolvedValue(true);
  mocks.query.mockResolvedValue({ rowCount: 1, rows: [{ id: 'device-1', name: '工作电脑' }] });
});

it('saves a device display name for a CSRF-protected admin', async () => {
  const response = await POST(request({ id: 'device-1', name: ' 工作电脑 ' }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: 'device-1', name: '工作电脑' });
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE devices SET name'), ['device-1', '工作电脑']);
});

it('rejects unauthenticated, unprotected, and invalid rename requests', async () => {
  mocks.requireAdmin.mockResolvedValueOnce(null);
  expect((await POST(request({ id: 'device-1', name: '工作电脑' }))).status).toBe(401);
  mocks.verifyCsrf.mockResolvedValueOnce(false);
  expect((await POST(request({ id: 'device-1', name: '工作电脑' }))).status).toBe(403);
  expect((await POST(request({ id: 'device-1', name: ' ' }))).status).toBe(400);
  expect(mocks.query).not.toHaveBeenCalled();
});
