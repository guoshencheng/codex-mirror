// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MetricView from '../../src/components/metric-view';

describe('MetricView', () => {
  it('renders an unfamiliar provider balance generically and preserves exact amount precision', () => {
    render(<MetricView metric={{
      kind: 'balance',
      key: 'new-provider:CNY',
      label: '账户余额',
      currency: 'CNY',
      total: '0.00000001',
      granted: '1.230000',
      toppedUp: '2.000001',
      details: [{ key: 'wallet', label: '钱包可用', value: '0.00000001' }],
    }} />);

    expect(screen.getByText('0.00000001', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('CNY', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('赠送：1.230000')).toBeInTheDocument();
    expect(screen.getByText('充值：2.000001')).toBeInTheDocument();
    expect(screen.getByText('钱包可用：0.00000001')).toBeInTheDocument();
  });

  it('shows unknown quota as unavailable without inventing 100 percent remaining', () => {
    render(<MetricView metric={{
      kind: 'quota-window',
      key: 'unknown',
      label: '用量窗口',
      usedPercent: null,
      windowDurationSeconds: null,
      resetsAt: null,
    }} />);

    expect(screen.getByText('额度数据不可用')).toBeInTheDocument();
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('exposes a labeled quota progress bar with a bounded numeric value', () => {
    render(<MetricView metric={{
      kind: 'quota-window',
      key: 'weekly-window',
      label: '周额度',
      usedPercent: 42.5,
      windowDurationSeconds: 604_800,
      resetsAt: null,
    }} />);

    const progress = screen.getByRole('progressbar', { name: '周额度已使用' });
    expect(progress).toHaveAttribute('aria-valuemin', '0');
    expect(progress).toHaveAttribute('aria-valuemax', '100');
    expect(progress).toHaveAttribute('aria-valuenow', '42.5');
    expect(progress).toHaveAttribute('aria-valuetext', '已使用 42.5%，剩余 57.5%');
  });

  it('renders reset times in the browser timezone and labels missing reset data', () => {
    const resetAt = '2026-09-23T00:00:00.000Z';
    const { container, rerender } = render(<MetricView metric={{
      kind: 'quota-window', key: 'daily', label: '日额度', usedPercent: 12,
      windowDurationSeconds: 86_400, resetsAt: resetAt,
    }} />);

    const reset = within(container).getByLabelText('重置时间');
    expect(reset).toHaveAttribute('dateTime', resetAt);
    expect(reset.textContent).not.toContain('Z');
    expect(reset.textContent).not.toContain('UTC');

    rerender(<MetricView metric={{
      kind: 'quota-window', key: 'daily', label: '日额度', usedPercent: 12,
      windowDurationSeconds: 86_400, resetsAt: null,
    }} />);
    expect(within(container).getByText('重置时间：未提供')).toBeInTheDocument();
  });
});
