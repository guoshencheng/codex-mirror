// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dashboard from '../../src/components/dashboard';
import type { DashboardAccount, DashboardDto } from '../../src/contracts/dashboard';
import type { QuotaHistoryLoader } from '../../src/contracts/quota-history';

const transport = vi.hoisted(() => ({ syncHealthy: true, refresh: vi.fn(), refreshQuota: vi.fn(), logout: vi.fn() }));
vi.mock('../../src/components/use-dashboard-polling', () => ({
  useDashboardPolling: (initial: DashboardDto) => ({ ...transport, data: initial, now: new Date('2026-09-22T10:00:00Z') }),
}));
afterEach(() => { cleanup(); transport.syncHealthy = true; vi.clearAllMocks(); });
const time = '2026-09-22T10:00:00Z';
function account(id: string): DashboardAccount {
  return { id, providerId: id, label: `${id} account`, lastAttemptAt: time, lastSuccessAt: time,
    errorCode: null, refreshStatus: 'idle', snapshot: { accountId: id, providerId: id, observedAt: time, serviceAvailable: true,
      metrics: [{ kind: 'quota-window', key: '5h', label: '5H', usedPercent: 28, windowDurationSeconds: 18000, resetsAt: null }] } };
}
function data(): DashboardDto {
  return { generatedAt: time, accounts: ['OpenAI', 'Anthropic', 'MiniMax', 'Other', ...Array.from({ length: 6 }, (_, i) => `Provider ${i + 4}`)].map(account) };
}

describe('compact pixel dashboard', () => {
  it('keeps provider accounts visible and makes overflow accounts reachable', () => {
    const { rerender } = render(<Dashboard initial={data()} />);
    const providers = screen.getByRole('list', { name: 'Provider 额度' });
    expect(within(providers).getAllByRole('listitem')).toHaveLength(9);
    expect(within(providers).getByText('OpenAI')).toBeInTheDocument();
    expect(within(providers).getByText('Anthropic')).toBeInTheDocument();
    expect(within(providers).getByText('MiniMax')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一页额度' }));
    expect(within(providers).getByText('Provider 9')).toBeInTheDocument();
    const smaller = data(); smaller.accounts = [account('OpenAI')];
    rerender(<Dashboard initial={smaller} />);
    expect(within(providers).getByText('OpenAI')).toBeInTheDocument();
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
    const walletButton = screen.getByRole('button', { name: '查看 Wallet account 额度详情' });
    expect(screen.queryByText('点击账号查看额度历史')).not.toBeInTheDocument();
    expect(screen.queryByText(/历史/)).not.toBeInTheDocument();
    fireEvent.click(walletButton);
    expect(screen.getByText('0.00000001', { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Additional' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '刷新额度' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回面板' }));
    expect(screen.getByRole('list', { name: 'Provider 额度' })).toBeInTheDocument();
  });

  it('loads injected quota history only after opening details and keeps the card read-only', async () => {
    const snapshot = data();
    const historyLoader = vi.fn<QuotaHistoryLoader>(async () => ({
      accountId: 'OpenAI', range: '24h', from: time, to: time, generatedAt: time, retentionDays: 90, bucketSeconds: 1800,
      series: [{ id: 'quota', key: 'weekly', label: '周', kind: 'quota-window', unit: '%', windowDurationSeconds: 604800,
        points: [{ observedAt: time, value: 72, resetsAt: null, breakBefore: true }] }],
    }));
    render(<Dashboard initial={snapshot} readOnly historyLoader={historyLoader} />);
    expect(historyLoader).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '查看 OpenAI account 额度详情' }));
    await waitFor(() => expect(historyLoader).toHaveBeenCalledWith('OpenAI', '24h', expect.any(AbortSignal)));
    expect(screen.queryByRole('button', { name: '刷新额度' })).not.toBeInTheDocument();
    expect(screen.getByText('72')).toBeInTheDocument();
  });

  it('labels a read-only static preview without making a history request', () => {
    render(<Dashboard initial={data()} readOnly />);
    fireEvent.click(screen.getByRole('button', { name: '查看 OpenAI account 额度详情' }));
    expect(screen.getByText('静态预览不提供额度历史')).toBeInTheDocument();
  });
});
