// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuotaHistoryDto } from '../../src/contracts/quota-history';
import QuotaHistoryChart from '../../src/components/quota-history-chart';

vi.mock('@ant-design/plots', () => ({
  Line: ({ data, style, point, axis }: {
    data: unknown[];
    style?: { lineWidth?: number };
    point?: { size?: number };
    axis?: { x?: { labelAutoRotate?: boolean } };
  }) => <div data-testid="antv-line-mock" data-points={data.length} data-line-width={style?.lineWidth} data-point-size={point?.size} data-label-auto-rotate={String(axis?.x?.labelAutoRotate)} />,
}));

const history: QuotaHistoryDto = {
  accountId: 'account-a', range: '24h', from: '2026-09-28T00:00:00.000Z', to: '2026-09-29T00:00:00.000Z', generatedAt: '2026-09-29T00:00:00.000Z',
  retentionDays: 90, bucketSeconds: 1800,
  series: [
    { id: 'quota', key: 'weekly', label: '周', kind: 'quota-window', unit: '%', windowDurationSeconds: 604800, points: [
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
  it('mounts an interactive line chart with accessible summaries and exact values', () => {
    render(<QuotaHistoryChart history={history} />);
    expect(screen.getByTestId('quota-history-line-chart')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '额度历史折线图' })).toBeInTheDocument();
    expect(screen.getByText('0.00000001', { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText(/采样点/).length).toBeGreaterThan(0);
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getAllByText('%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('USD').length).toBeGreaterThan(0);
    const line = screen.getAllByTestId('antv-line-mock')[0]!;
    expect(line).toHaveAttribute('data-line-width', '1');
    expect(line).toHaveAttribute('data-point-size', '2');
    expect(line).toHaveAttribute('data-label-auto-rotate', 'false');
    expect(screen.getAllByTestId('quota-history-range')[0]).toHaveTextContent(/^\d{2}\/\d{2} \d{2}:\d{2} — \d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it('exposes the line chart series and axis labels', () => {
    render(<QuotaHistoryChart history={{ ...history, series: [
      history.series[0]!,
      { ...history.series[0]!, id: 'quota-secondary', key: 'secondary', label: '周' },
    ] }} />);
    expect(screen.getAllByText('额度窗口').length).toBe(1);
    expect(screen.getByText('时间')).toBeInTheDocument();
    expect(screen.getByTestId('quota-history-line-chart')).toHaveAttribute('data-series-count', '2');
  });

  it('keeps oversized balance values exact and exposes reset metadata', () => {
    const oversized = '9'.repeat(400);
    render(<QuotaHistoryChart history={{ ...history, series: [
      { ...history.series[0]!, points: [{ ...history.series[0]!.points[0]!, resetsAt: '2026-09-28T06:00:00.000Z' }] },
      { ...history.series[1]!, points: [{ ...history.series[1]!.points[0]!, value: oversized, resetsAt: '2026-09-28T06:00:00.000Z' }] },
    ] }} />);
    expect(screen.getByRole('note')).toHaveTextContent('数值过大，无法绘图');
    expect(screen.getByText(oversized, { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText(/重置/).length).toBeGreaterThan(0);
  });

  it('exposes a selected point summary', () => {
    render(<QuotaHistoryChart history={history} />);
    expect(screen.getByRole('status')).toHaveTextContent('72');
    fireEvent.click(screen.getByRole('button', { name: '下一个采样点' }));
    expect(screen.getByRole('status')).toHaveTextContent('20');
  });

  it('renders an explicit empty state', () => {
    render(<QuotaHistoryChart history={{ ...history, series: [] }} />);
    expect(screen.getByText('所选时间范围内暂无额度历史')).toBeInTheDocument();
  });
});
