import type { DashboardAccount } from '../contracts/dashboard';
import MetricView from './metric-view';

const refreshStatusText = {
  idle: '可刷新',
  queued: '排队中',
  running: '刷新中',
  error: '刷新失败',
} as const;

function displayTimestamp(value: string | null): string {
  return value ? value.replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC') : '尚无记录';
}

export interface QuotaCardProps {
  account: DashboardAccount;
  onRefresh(accountId: string): void | Promise<void>;
}

export default function QuotaCard({ account, onRefresh }: QuotaCardProps) {
  const metrics = account.snapshot?.metrics ?? [];
  const busy = account.refreshStatus === 'queued' || account.refreshStatus === 'running';

  return <article className="ds-card ds-quota-card" aria-label={`${account.label}额度`}>
    <header className="ds-card__header">
      <div className="ds-stack">
        <span className="ds-section-label">{account.providerId}</span>
        <h2 className="ds-card__title">{account.label}</h2>
        <span className="ds-meta">关联 {account.deviceIds.length} 台设备</span>
      </div>
      <span className={`ds-status ${busy ? 'ds-status--waiting' : 'ds-status--muted'}`}>
        {refreshStatusText[account.refreshStatus]}
      </span>
    </header>

    {account.snapshot?.serviceAvailable === false
      ? <p className="ds-notice">Provider 服务当前不可用，以下为最近一次已保存的数据。</p>
      : null}
    {account.errorCode ? <p className="ds-notice">最近更新失败：{account.errorCode}</p> : null}

    {metrics.length > 0
      ? <div className="ds-metric-grid ds-quota-card__metrics">
        {metrics.map(metric => <MetricView key={`${metric.kind}:${metric.key}`} metric={metric} />)}
      </div>
      : <p className="ds-constraint">{account.snapshot ? '服务暂不提供可展示的额度' : '尚未获取额度数据'}</p>}

    <footer className="ds-card__footer">
      <div className="ds-stack">
        <span className="ds-meta">最近成功：{displayTimestamp(account.lastSuccessAt)}</span>
        <span className="ds-meta">最近尝试：{displayTimestamp(account.lastAttemptAt)}</span>
      </div>
      <button className="ds-btn" type="button" disabled={busy} onClick={() => onRefresh(account.id)}>
        刷新额度
      </button>
    </footer>
  </article>;
}
