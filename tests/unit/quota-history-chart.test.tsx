// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { QuotaHistoryDto } from '../../src/contracts/quota-history';
import QuotaHistoryChart from '../../src/components/quota-history-chart';

const history: QuotaHistoryDto = {
  accountId: 'account-a', range: '24h', from: '2026-09-28T00:00:00.000Z', to: '2026-09-29T00:00:00.000Z', generatedAt: '2026-09-29T00:00:00.000Z',
  retentionDays: 90, bucketSeconds: 1800,
  series: [
    { id: 'quota', key: 'primary', label: '5H', kind: 'quota-window', unit: '%', windowDurationSeconds: 18000, points: [
      { observedAt: '2026-09-28T01:00:00.000Z', value: 72, resetsAt: null, breakBefore: true },
      { observedAt: '2026-09-28T02:00:00.000Z', value: 20, resetsAt: null, breakBefore: true },
    ] },
    { id: 'balance', key: 'wallet', label: '余额', kind: 'balance', unit: 'USD', windowDurationSeconds: null, points: [
      { observedAt: '2026-09-28T01:00:00.000Z', value: '0.00000001', resetsAt: null, breakBefore: true },
    ] },
  ],
};

describe('QuotaHistoryChart', () => {
  afterEach(cleanup);
  it('draws real-time SVG paths with breaks, accessible summaries, and exact values', () => {
    render(<QuotaHistoryChart history={history} />);
    const paths = screen.getAllByTestId('quota-history-series-path');
    expect(paths[0]).toHaveAttribute('d', expect.stringContaining('M'));
    expect((paths[0]?.getAttribute('d')?.match(/M/g) ?? []).length).toBe(2);
    expect(screen.getByText('0.00000001', { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText(/采样点/).length).toBeGreaterThan(0);
    expect(document.querySelector('svg')?.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it('supports keyboard navigation and a selected point summary', () => {
    render(<QuotaHistoryChart history={history} />);
    const chart = screen.getAllByRole('img')[0]!;
    fireEvent.keyDown(chart, { key: 'End' });
    expect(screen.getByRole('status')).toHaveTextContent('20');
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(screen.getByRole('status')).toHaveTextContent('72');
  });

  it('renders an explicit empty state', () => {
    render(<QuotaHistoryChart history={{ ...history, series: [] }} />);
    expect(screen.getByText('所选时间范围内暂无额度历史')).toBeInTheDocument();
  });
});
