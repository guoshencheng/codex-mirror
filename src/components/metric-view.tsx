import type { BalanceMetric, QuotaMetric, QuotaWindowMetric } from '../contracts/quota';

function formatPercent(value: number): string {
  return String(value);
}

function BalanceView({ metric }: { metric: BalanceMetric }) {
  return <section aria-label={metric.label} data-metric-kind="balance">
    <h3>{metric.label}</h3>
    <p><strong>{metric.total}</strong> <span>{metric.currency}</span></p>
    {metric.granted !== null ? <p>赠送：{metric.granted}</p> : null}
    {metric.toppedUp !== null ? <p>充值：{metric.toppedUp}</p> : null}
    {metric.details?.map(detail => <p key={detail.key}>{detail.label}：{detail.value}</p>)}
  </section>;
}

function QuotaWindowView({ metric }: { metric: QuotaWindowMetric }) {
  if (metric.usedPercent === null) {
    return <section aria-label={metric.label} data-metric-kind="quota-window">
      <h3>{metric.label}</h3>
      <p>额度数据不可用</p>
    </section>;
  }

  const used = Math.max(0, Math.min(100, metric.usedPercent));
  const remaining = 100 - used;
  const usedText = formatPercent(used);
  const remainingText = formatPercent(remaining);

  return <section aria-label={metric.label} data-metric-kind="quota-window">
    <h3>{metric.label}</h3>
    <p>已使用 {usedText}%，剩余 {remainingText}%</p>
    <div
      role="progressbar"
      aria-label={`${metric.label}已使用`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={used}
      aria-valuetext={`已使用 ${usedText}%，剩余 ${remainingText}%`}
    >
      <div aria-hidden="true" style={{ width: `${used}%` }} />
    </div>
  </section>;
}

export default function MetricView({ metric }: { metric: QuotaMetric }) {
  return metric.kind === 'balance'
    ? <BalanceView metric={metric} />
    : <QuotaWindowView metric={metric} />;
}
