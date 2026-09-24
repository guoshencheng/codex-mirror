// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import DeviceList from '../../src/components/device-list';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('lets an admin rename a device and shows the saved display name', async () => {
  const requests: Array<{ url: string; body?: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body?.toString() });
    if (url === '/api/auth/session') return Response.json({ csrfToken: 'c'.repeat(43) });
    return Response.json({ id: 'device-1', name: '工作电脑' });
  }));
  render(<DeviceList devices={[{ id: 'device-1', name: 'host.local', heartbeatAt: null, connection: 'offline', streamIncomplete: false }]} />);
  fireEvent.click(screen.getByRole('button', { name: '修改 host.local 的显示名' }));
  fireEvent.change(screen.getByLabelText('设备显示名'), { target: { value: '工作电脑' } });
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: '工作电脑' })).toBeInTheDocument());
  expect(requests.at(-1)).toEqual({ url: '/api/devices/rename', body: JSON.stringify({ id: 'device-1', name: '工作电脑' }) });
});
