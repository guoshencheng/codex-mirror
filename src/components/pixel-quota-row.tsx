import type { DashboardAccount } from '../contracts/dashboard';
import type { QuotaMetric } from '../contracts/quota';
import { quotaNotice } from './pixel-dashboard-model';
import styles from './pixel-dashboard.module.css';

function CompactMetric({ metric }: { metric: QuotaMetric }) {
  if (metric.kind === 'balance') {
    return <span className={styles.balance} title={`${metric.label}：${metric.total} ${metric.currency}`}>
      <small>{metric.currency}</small><strong>{metric.total}</strong>
    </span>;
  }
  const label = metric.windowDurationSeconds === 18_000 ? '5H'
    : metric.windowDurationSeconds === 604_800 ? '周' : metric.label;
  if (metric.usedPercent === null || !Number.isFinite(metric.usedPercent)) {
    return <span className={styles.metric} title={`${metric.label}：额度数据不可用`}><small>{label}</small><span>不可用</span></span>;
  }
  const remaining = Math.round((100 - Math.max(0, Math.min(100, metric.usedPercent))) * 10) / 10;
  return <span className={styles.metric} title={`${metric.label}剩余 ${remaining}%`}>
    <small>{label}</small><span className={styles.bar} aria-hidden="true"><i style={{ width: `${remaining}%` }} /></span>
    <strong>{remaining}%</strong>
  </span>;
}

export default function PixelQuotaRow({ account, now, onOpen }: {
  account: DashboardAccount; now: Date; onOpen(): void;
}) {
  const metrics = account.snapshot?.metrics ?? [];
  const notice = quotaNotice(account, now);
  return <li className={styles.providerItem}>
    <button className={`${styles.providerRow} ${notice ? styles.quotaWarning : ''}`}
      aria-label={`查看 ${account.label} 额度详情`} onClick={onOpen}
      title={`${account.providerId} · ${account.label}${notice ? ` · ${notice}` : ''}`}>
      <span className={styles.providerName}><i />
        <span>{account.providerId}<small>{notice ?? account.label}</small></span>
      </span>
      <span className={styles.metrics}>
        {metrics.length ? metrics.slice(0, 2).map(metric => <CompactMetric key={`${metric.kind}:${metric.key}`} metric={metric} />)
          : <span className={styles.emptyMetric}>尚无额度数据</span>}
      </span>
      <span className={styles.more} aria-hidden="true">{metrics.length > 2 ? '+' : '›'}</span>
    </button>
  </li>;
}
