import type { DashboardDevice, DashboardSession } from '../contracts/dashboard';

const sessionStateLabel: Record<DashboardSession['state'], string> = {
  IDLE: '待命',
  WORKING: '执行中',
  WAITING_APPROVAL: '待审批',
  STOPPED: '本轮停止',
  INTERRUPTED: '已中断',
  ENDED: '已结束',
  UNKNOWN: '状态未知',
};

function displayTimestamp(value: string): string {
  return value.replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC');
}

function connectionHint(device: DashboardDevice | undefined): string {
  if (!device) return '设备状态未知';
  if (device.connection === 'offline') return '设备离线';
  if (device.connection === 'stale') return '设备上报过期';
  return '设备在线';
}

export interface SessionListProps {
  sessions: readonly DashboardSession[];
  devices: readonly DashboardDevice[];
}

export default function SessionList({ sessions, devices }: SessionListProps) {
  if (sessions.length === 0) return <p className="ds-constraint">暂无会话事件</p>;

  const devicesById = new Map(devices.map(device => [device.id, device]));
  const ordered = [...sessions].sort((left, right) => Number(right.state === 'WAITING_APPROVAL') - Number(left.state === 'WAITING_APPROVAL'));

  return <div className="ds-list ds-session-list" role="list" aria-label="会话">
    {ordered.map(session => {
      const device = devicesById.get(session.deviceId);
      const stateIsCurrent = session.confidence === 'confirmed' && device?.connection === 'online';
      const prefix = stateIsCurrent ? '当前状态' : '最近状态';
      const confidence = session.confidence === 'confirmed' ? '已确认' : '未确认';
      const stateIsWorkingButUncertain = session.state === 'WORKING' && !stateIsCurrent;

      return <article className="ds-card ds-session-card" key={`${session.deviceId}:${session.id}`} role="listitem">
        <header className="ds-card__header">
          <h3 className="ds-card__title">{session.title}</h3>
          <span className={`ds-status ${session.state === 'WAITING_APPROVAL' ? 'ds-status--waiting' : 'ds-status--muted'}`}>
            {sessionStateLabel[session.state]}
          </span>
        </header>
        <p className="ds-meta">
          {session.projectName ?? '未归属项目'} · {device?.name ?? '未知设备'}
        </p>
        <p>{prefix}：{sessionStateLabel[session.state]}</p>
        <p className="ds-meta">状态可信度：{confidence}</p>
        {stateIsWorkingButUncertain
          ? <p className="ds-notice">当前执行情况未知（{connectionHint(device)}）</p>
          : null}
        <p className="ds-meta">最近事件：<time dateTime={session.lastEventAt}>{displayTimestamp(session.lastEventAt)}</time></p>
      </article>;
    })}
  </div>;
}
