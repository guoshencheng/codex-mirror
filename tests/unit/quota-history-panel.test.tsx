// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuotaHistoryDto, QuotaHistoryLoader, QuotaHistoryRange } from '../../src/contracts/quota-history';
import QuotaHistory from '../../src/components/quota-history';

const history = (range: QuotaHistoryRange, value = 72): QuotaHistoryDto => ({
  accountId: 'account-a', range, from: '2026-09-28T00:00:00.000Z', to: '2026-09-29T00:00:00.000Z', generatedAt: '2026-09-29T00:00:00.000Z',
  retentionDays: 90, bucketSeconds: range === '24h' ? 1800 : 7200,
  series: [{ id: 'quota', key: 'primary', label: '5H', kind: 'quota-window', unit: '%', windowDurationSeconds: 18000,
    points: [{ observedAt: '2026-09-28T01:00:00.000Z', value, resetsAt: null, breakBefore: true }] }],
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('QuotaHistory', () => {
  it('loads the default range, switches ranges, and shows sampled history', async () => {
    const loader = vi.fn<QuotaHistoryLoader>(async (_account, range) => history(range));
    render(<QuotaHistory accountId="account-a" loadHistory={loader} />);
    await waitFor(() => expect(screen.getByText('72')).toBeInTheDocument());
    expect(loader).toHaveBeenCalledWith('account-a', '24h', expect.any(AbortSignal));
    fireEvent.click(screen.getByRole('button', { name: '7 天' }));
    await waitFor(() => expect(loader).toHaveBeenCalledWith('account-a', '7d', expect.any(AbortSignal)));
    expect(screen.getByText('采样趋势')).toBeInTheDocument();
  });

  it('keeps old data on same-range refresh failure and can retry', async () => {
    let calls = 0;
    const loader = vi.fn<QuotaHistoryLoader>(async (_account, range) => {
      calls += 1;
      if (calls === 2) throw new Error('network');
      return history(range, calls === 3 ? 60 : 72);
    });
    vi.useFakeTimers();
    render(<QuotaHistory accountId="account-a" loadHistory={loader} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText('72')).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(60_000); await Promise.resolve(); });
    expect(screen.getByText('历史更新失败')).toBeInTheDocument();
    expect(screen.getByText('72')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试历史' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText('60')).toBeInTheDocument();
  });

  it('aborts stale range requests and stops polling while hidden', async () => {
    let resolveFirst!: (value: QuotaHistoryDto) => void;
    const first = new Promise<QuotaHistoryDto>(resolve => { resolveFirst = resolve; });
    const loader = vi.fn<QuotaHistoryLoader>((_account, range, signal) => {
      if (range === '24h') return first;
      return Promise.resolve(history(range, 60));
    });
    const { unmount } = render(<QuotaHistory accountId="account-a" loadHistory={loader} />);
    fireEvent.click(screen.getByRole('button', { name: '7 天' }));
    await waitFor(() => expect(screen.getByText('60')).toBeInTheDocument());
    expect(loader.mock.calls[0]?.[2].aborted).toBe(true);
    resolveFirst(history('24h', 72));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('60')).toBeInTheDocument();

    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    const before = loader.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(loader.mock.calls.length).toBe(before);
    unmount();
  });
});
