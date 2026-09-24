// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardAccount, DashboardDevice, DashboardSession } from '../../src/contracts/dashboard';
import QuotaCard from '../../src/components/quota-card';
import DeviceList from '../../src/components/device-list';
import SessionList from '../../src/components/session-list';

const account: DashboardAccount = {
  id: 'account-1',
  providerId: 'new-provider',
  label: '新 Provider 余额',
  deviceIds: ['device-1'],
  snapshot: {
    accountId: 'account-1',
    providerId: 'new-provider',
    observedAt: '2026-09-22T10:00:00.000Z',
    serviceAvailable: true,
    metrics: [{
      kind: 'balance', key: 'wallet', label: '余额', currency: 'CNY', total: '0.00000001', granted: null, toppedUp: null,
    }],
  },
  lastAttemptAt: '2026-09-22T10:00:00.000Z',
  lastSuccessAt: '2026-09-22T10:00:00.000Z',
  errorCode: null,
  refreshStatus: 'idle',
};

const devices: DashboardDevice[] = [
  { id: 'device-1', name: 'Mac mini', heartbeatAt: '2026-09-22T10:00:00.000Z', connection: 'online', streamIncomplete: false },
  { id: 'device-2', name: 'Laptop <img src=x onerror=alert(1)>', heartbeatAt: null, connection: 'offline', streamIncomplete: true },
];

const sessions: DashboardSession[] = [
  {
    id: 'working', deviceId: 'device-2', projectId: null, projectName: null, harness: 'kimi', clientType: 'cli',
    title: '<img src=x onerror=alert(1)> Working task', state: 'WORKING', confidence: 'unconfirmed',
    lastEventAt: '2026-09-22T10:00:00.000Z', lastReceivedAt: '2026-09-22T10:00:01.000Z', turnStartedAt: null, currentTool: null,
  },
  {
    id: 'approval', deviceId: 'device-1', projectId: 'project-1', projectName: 'Dashboard', harness: 'codex', clientType: null,
    title: 'Approval needed', state: 'WAITING_APPROVAL', confidence: 'confirmed',
    lastEventAt: '2026-09-22T10:01:00.000Z', lastReceivedAt: '2026-09-22T10:01:01.000Z', turnStartedAt: null, currentTool: 'terminal',
  },
  {
    id: 'stopped', deviceId: 'device-1', projectId: null, projectName: null, harness: null, clientType: null,
    title: 'Stopped task', state: 'STOPPED', confidence: 'confirmed',
    lastEventAt: '2026-09-22T09:58:00.000Z', lastReceivedAt: '2026-09-22T09:58:01.000Z', turnStartedAt: null, currentTool: null,
  },
];

describe('dashboard display cards', () => {
  it('renders normalized account metrics without provider-specific branches and refreshes by account id', () => {
    const onRefresh = vi.fn();
    render(<QuotaCard account={account} now={new Date('2026-09-22T10:10:00.000Z')} onRefresh={onRefresh} />);

    expect(screen.getByText('new-provider')).toBeInTheDocument();
    expect(screen.getByText('0.00000001', { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新额度' }));
    expect(onRefresh).toHaveBeenCalledWith('account-1');
  });

  it('renders device connectivity and warns when an event stream is incomplete', () => {
    render(<DeviceList devices={devices} />);

    expect(screen.getByText('Mac mini')).toBeInTheDocument();
    expect(screen.getByText('在线')).toBeInTheDocument();
    expect(screen.getByText('离线')).toBeInTheDocument();
    expect(screen.getByText('事件流不完整')).toBeInTheDocument();
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  });

  it('places approval sessions first, distinguishes last-known confidence, and escapes session titles', () => {
    render(<SessionList sessions={sessions} devices={devices} />);

    const titles = within(screen.getByRole('list', { name: '会话' }))
      .getAllByRole('heading', { level: 3 }).map(node => node.textContent);
    expect(titles[0]).toBe('Approval needed');
    expect(titles[1]).toBe('<img src=x onerror=alert(1)> Working task');
    expect(screen.getByText('待审批')).toBeInTheDocument();
    expect(screen.getByText(/最近状态：执行中/)).toBeInTheDocument();
    expect(screen.getByText('状态可信度：未确认')).toBeInTheDocument();
    expect(screen.getByText('当前执行情况未知（设备离线）')).toBeInTheDocument();
    expect(screen.getByText('本轮停止')).toBeInTheDocument();
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });
});
