// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SettingsPanel from '../../src/components/settings-panel';
import type { DashboardDto } from '../../src/contracts/dashboard';

vi.mock('../../src/components/use-dashboard-polling', () => ({
  useDashboardPolling: (data: DashboardDto) => ({
    data, syncHealthy: true, refresh: vi.fn(async () => {}),
    refreshQuota: vi.fn(async () => {}), logout: vi.fn(async () => {}),
  }),
}));

const initial: DashboardDto = { generatedAt: new Date().toISOString(), devices: [], sessions: [], accounts: [] };

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  window.matchMedia = vi.fn().mockImplementation(query => ({
    matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

it('saves the standalone display connection from the Ant Design settings page', async () => {
  render(<SettingsPanel initial={initial} initialTab="display" />);
  fireEvent.change(screen.getByRole('textbox', { name: 'API 地址' }), { target: { value: 'https://api.example/' } });
  fireEvent.change(screen.getByLabelText('用户 Token'), { target: { value: 'cdu_' + 'a'.repeat(43) } });
  fireEvent.click(screen.getByRole('button', { name: '保存连接' }));
  await waitFor(() => expect(localStorage.getItem('display-api-origin')).toBe('https://api.example'));
  expect(sessionStorage.getItem('display-user-token')).toBe('cdu_' + 'a'.repeat(43));
});
