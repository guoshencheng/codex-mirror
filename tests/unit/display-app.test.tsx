// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../../display/src/App';

afterEach(() => {
  cleanup();
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

it('passes the display API history loader into the shared read-only quota detail', async () => {
  const token = 'cdu_' + 'a'.repeat(43);
  window.history.replaceState(null, '', '/display/#token=' + token);
  const time = new Date().toISOString();
  const dashboard = {
    generatedAt: time,
    devices: [],
    sessions: [],
    accounts: [{
      id: 'account-a', providerId: 'codex', label: 'Codex', deviceIds: [], lastAttemptAt: time, lastSuccessAt: time,
      errorCode: null, refreshStatus: 'idle', snapshot: { accountId: 'account-a', providerId: 'codex', observedAt: time, serviceAvailable: true,
        metrics: [{ kind: 'quota-window', key: 'primary', label: '5H', usedPercent: 28, windowDurationSeconds: 18000, resetsAt: null }] },
    }],
  };
  const history = {
    accountId: 'account-a', range: '24h', from: time, to: time, generatedAt: time, retentionDays: 90, bucketSeconds: 1800,
    series: [{ id: 'quota', key: 'primary', label: '5H', kind: 'quota-window', unit: '%', windowDurationSeconds: 18000,
      points: [{ observedAt: time, value: 72, resetsAt: null, breakBefore: true }] }],
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/history') ? Response.json(history) : Response.json(dashboard));
  vi.stubGlobal('fetch', fetcher);
  render(<App />);
  await waitFor(() => expect(screen.getByTestId('pixel-dashboard')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: '查看 Codex 额度详情与历史' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
    'https://codex-status.icerock.top/api/display/provider-accounts/account-a/history?range=24h',
    expect.objectContaining({ headers: { Authorization: 'Bearer ' + token } }),
  ));
  expect(screen.queryByRole('button', { name: '刷新额度' })).toBeNull();
});
