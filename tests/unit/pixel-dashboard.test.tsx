// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dashboard from '../../src/components/dashboard';
import type { DashboardAccount, DashboardDto, DashboardSession } from '../../src/contracts/dashboard';

const transport = vi.hoisted(() => ({ syncHealthy: true, refresh: vi.fn(), refreshQuota: vi.fn(), logout: vi.fn() }));
vi.mock('../../src/components/use-dashboard-polling', () => ({
  useDashboardPolling: (initial: DashboardDto) => ({ ...transport, data: initial, now: new Date('2026-09-22T10:00:00Z') }),
}));
afterEach(() => { cleanup(); transport.syncHealthy = true; vi.clearAllMocks(); });
const time = '2026-09-22T10:00:00Z';
function account(id: string): DashboardAccount {
  return { id, providerId: id, label: `${id} account`, deviceIds: [], lastAttemptAt: time, lastSuccessAt: time,
    errorCode: null, refreshStatus: 'idle', snapshot: { accountId: id, providerId: id, observedAt: time, serviceAvailable: true,
      metrics: [{ kind: 'quota-window', key: '5h', label: '5H', usedPercent: 28, windowDurationSeconds: 18000, resetsAt: null }] } };
}
function session(id: string, state: DashboardSession['state'] = 'WORKING'): DashboardSession {
  return { id, deviceId: 'device', title: `Task ${id}`, state, confidence: 'confirmed', projectId: 'project', projectName: 'Project',
    lastEventAt: time, lastReceivedAt: time, turnStartedAt: time, currentTool: null };
}
function data(): DashboardDto {
  return { generatedAt: time, devices: [{ id: 'device', name: 'Mac mini', heartbeatAt: time, connection: 'online', streamIncomplete: false }],
    accounts: ['OpenAI', 'Anthropic', 'MiniMax', 'Other'].map(account),
    sessions: [...Array.from({ length: 7 }, (_, i) => session(String(i))), session('approval', 'WAITING_APPROVAL')] };
}

describe('compact pixel dashboard', () => {
  it('keeps multiple providers visible and makes overflow accounts and sessions reachable', () => {
    const { rerender } = render(<Dashboard initial={data()} />);
    const providers = screen.getByRole('list', { name: 'Provider 额度' });
    expect(within(providers).getAllByRole('listitem')).toHaveLength(3);
    expect(within(providers).getByText('OpenAI')).toBeInTheDocument();
    expect(within(providers).getByText('Anthropic')).toBeInTheDocument();
    expect(within(providers).getByText('MiniMax')).toBeInTheDocument();
    const sessions = screen.getByRole('list', { name: '会话' });
    expect(within(sessions).getAllByRole('listitem')).toHaveLength(6);
    expect(within(sessions).getAllByRole('heading')[0]).toHaveTextContent('Task approval');
    fireEvent.click(screen.getByRole('button', { name: '下一页额度' }));
    expect(within(providers).getByText('Other')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一页会话' }));
    expect(within(sessions).getByText('Task 6')).toBeInTheDocument();
    const smaller = data(); smaller.accounts = [account('OpenAI')]; smaller.sessions = [session('0')];
    rerender(<Dashboard initial={smaller} />);
    expect(within(providers).getByText('OpenAI')).toBeInTheDocument();
    expect(within(sessions).getByText('Task 0')).toBeInTheDocument();
  });

  it('shows at most two pages of sessions', () => {
    const snapshot = data();
    snapshot.sessions = Array.from({ length: 13 }, (_, i) => session(String(i)));
    render(<Dashboard initial={snapshot} />);
    const list = screen.getByRole('list', { name: '会话' });
    expect(screen.getByLabelText('会话页码')).toHaveTextContent('1/2');
    fireEvent.click(screen.getByRole('button', { name: '下一页会话' }));
    expect(screen.getByLabelText('会话页码')).toHaveTextContent('2/2');
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    expect(within(list).queryByText('Task 12')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一页会话' })).toBeDisabled();
  });

  it.each(['offline', 'unconfirmed', 'incomplete', 'disconnected'])('does not present %s task state as current activity', reason => {
    const snapshot = data(); snapshot.sessions = [session('old')];
    if (reason === 'offline') snapshot.devices[0].connection = 'offline';
    if (reason === 'unconfirmed') snapshot.sessions[0].confidence = 'unconfirmed';
    if (reason === 'incomplete') snapshot.devices[0].streamIncomplete = true;
    if (reason === 'disconnected') transport.syncHealthy = false;
    render(<Dashboard initial={snapshot} />);
    expect(screen.getByText('最近：执行中')).toBeInTheDocument();
    expect(screen.queryByText(/1 个任务执行中/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '正在工作' })).not.toBeInTheDocument();
  });

  it('shows unknown quota as unavailable and stale or failed snapshots as last-known values', () => {
    const snapshot = data(); snapshot.accounts = [account('Unknown'), account('Stale'), account('Failed')];
    const metric = snapshot.accounts[0].snapshot!.metrics[0];
    if (metric.kind === 'quota-window') metric.usedPercent = null;
    snapshot.accounts[1].lastSuccessAt = '2026-09-22T09:00:00Z';
    snapshot.accounts[2].errorCode = 'AUTH_EXPIRED';
    render(<Dashboard initial={snapshot} />);
    const list = screen.getByRole('list', { name: 'Provider 额度' });
    expect(within(list).getByText('不可用')).toBeInTheDocument();
    expect(within(list).getByText('已过期')).toBeInTheDocument();
    expect(within(list).getByText('更新失败')).toBeInTheDocument();
    expect(within(list).queryByText('100%')).not.toBeInTheDocument();
  });

  it('preserves balance precision and exposes every metric in read-only details', () => {
    const snapshot = data(); const wallet = account('Wallet');
    wallet.snapshot!.metrics = [
      { kind: 'balance', key: 'wallet', label: '余额', currency: 'CNY', total: '0.00000001', granted: null, toppedUp: null },
      { kind: 'quota-window', key: 'weekly', label: 'Weekly', usedPercent: 59, windowDurationSeconds: 604800, resetsAt: null },
      { kind: 'quota-window', key: 'extra', label: 'Additional', usedPercent: 10, windowDurationSeconds: null, resetsAt: null },
    ]; snapshot.accounts = [wallet];
    render(<Dashboard initial={snapshot} />);
    fireEvent.click(screen.getByRole('button', { name: '查看 Wallet account 额度详情' }));
    expect(screen.getByText('0.00000001', { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Additional' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '刷新额度' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回面板' }));
    expect(screen.getByRole('list', { name: '会话' })).toBeInTheDocument();
  });
});
