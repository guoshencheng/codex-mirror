import type { DashboardAccount, DashboardDevice, DashboardSession } from '../contracts/dashboard';

export const sessionLabels: Record<DashboardSession['state'], string> = {
  IDLE: '待命', WORKING: '执行中', WAITING_APPROVAL: '待审批', STOPPED: '本轮停止',
  INTERRUPTED: '已中断', ENDED: '已结束', UNKNOWN: '状态未知',
};

export function harnessLabel(session: Pick<DashboardSession, 'harness' | 'clientType'>): string {
  if (session.harness === 'kimi') return session.clientType === 'cli' ? 'Kimi CLI'
    : session.clientType === 'desktop' ? 'Kimi 桌面端' : 'Kimi Code';
  if (session.harness === 'codex') return session.clientType === 'cli' ? 'Codex CLI'
    : session.clientType === 'desktop' ? 'Codex Desktop' : 'Codex';
  return '来源未知';
}

export function isCurrentSession(session: DashboardSession, device: DashboardDevice | undefined, syncHealthy: boolean): boolean {
  return syncHealthy && session.confidence === 'confirmed' && device?.connection === 'online' && !device.streamIncomplete;
}

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

export function ageText(at: string | null, now: Date): string {
  const timestamp = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(timestamp)) return '时间未知';
  const seconds = Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

export function durationText(at: string | null, now: Date): string {
  const timestamp = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(timestamp)) return '--:--';
  const seconds = Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
