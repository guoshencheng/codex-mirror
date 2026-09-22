// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardAccount } from '../../src/contracts/dashboard';
import QuotaCard from '../../src/components/quota-card';

afterEach(cleanup);

const account: DashboardAccount = {
  id: 'account-codex',
  providerId: 'codex',
  label: 'Codex',
  deviceIds: [],
  snapshot: {
    accountId: 'account-codex',
    providerId: 'codex',
    observedAt: '2026-09-22T11:00:00.000Z',
    serviceAvailable: true,
    metrics: [],
  },
  lastAttemptAt: '2026-09-22T11:00:00.000Z',
  lastSuccessAt: '2026-09-22T11:00:00.000Z',
  errorCode: null,
  refreshStatus: 'idle',
};

describe('QuotaCard snapshot freshness', () => {
  it('keeps a snapshot fresh until 15 minutes have elapsed and then labels it expired', () => {
    const { rerender } = render(<QuotaCard account={account} now={new Date('2026-09-22T11:14:59.999Z')} onRefresh={() => undefined} />);
    expect(screen.queryByLabelText('额度数据已过期')).not.toBeInTheDocument();

    rerender(<QuotaCard account={account} now={new Date('2026-09-22T11:15:00.000Z')} onRefresh={() => undefined} />);
    expect(screen.getByLabelText('额度数据已过期')).toHaveTextContent('最近一次额度成功更新时间已超过 15 分钟');
  });

  it('does not mark an account without a successful snapshot as expired', () => {
    render(<QuotaCard account={{ ...account, snapshot: null, lastSuccessAt: null }} now={new Date('2026-09-22T12:00:00.000Z')} onRefresh={() => undefined} />);
    expect(screen.queryByLabelText('额度数据已过期')).not.toBeInTheDocument();
    expect(screen.getByText('尚未获取额度数据')).toBeInTheDocument();
  });
});
