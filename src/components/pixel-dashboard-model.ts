import type { DashboardAccount } from '../contracts/dashboard';

export const DASHBOARD_POLL_INTERVAL_MS = 10_000;

export function quotaNotice(account: DashboardAccount, now: Date): string | null {
  if (account.snapshot?.serviceAvailable === false) return '服务不可用';
  if (account.errorCode || account.refreshStatus === 'error') return '更新失败';
  if (account.refreshStatus === 'queued') return '排队中';
  if (account.refreshStatus === 'running') return '刷新中';
  if (!account.snapshot) return '暂无数据';
  const at = Date.parse(account.lastSuccessAt ?? account.snapshot.observedAt);
  if (!Number.isFinite(at) || now.getTime() - at >= 15 * 60_000) return '已过期';
  return null;
}

export function syncCountdownText(at: string, now: Date): string {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) return '同步时间未知';
  const seconds = Math.max(0, Math.ceil((timestamp + DASHBOARD_POLL_INTERVAL_MS - now.getTime()) / 1000));
  return seconds > 0 ? `${seconds} 秒后同步` : '即将同步';
}
