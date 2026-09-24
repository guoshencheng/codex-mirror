// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../../display/src/App';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

it('uses a display link to show the shared read-only pixel dashboard', async () => {
  const token = 'cdu_' + 'a'.repeat(43);
  window.history.replaceState(null, '', '/display/#token=' + token);
  const fetcher = vi.fn(async () => Response.json({
    generatedAt: new Date().toISOString(),
    devices: [{ id: 'device-a', name: 'Desk', heartbeatAt: new Date().toISOString(), connection: 'online', streamIncomplete: false }],
    sessions: [], accounts: [],
  }));
  vi.stubGlobal('fetch', fetcher);
  render(<App />);
  await waitFor(() => expect(screen.getByTestId('pixel-dashboard')).toBeTruthy());
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
    'https://codex-status.icerock.top/api/display/dashboard',
    expect.objectContaining({ headers: { Authorization: 'Bearer ' + token } }),
  ));
  fireEvent.click(screen.getByRole('button', { name: '查看设备状态' }));
  expect(screen.getByText(/Desk/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '打开设置' })).toBeNull();
  expect(screen.queryByLabelText('API 地址')).toBeNull();
  expect(window.location.hash).toBe('');
});

it('asks for a display link when no token is configured', () => {
  render(<App />);
  expect(screen.getByText('请使用带 Token 的展示链接打开此页面。')).toBeTruthy();
  expect(screen.queryByLabelText('用户 Token')).toBeNull();
});
