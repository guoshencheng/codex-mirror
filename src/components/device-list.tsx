import type { DashboardDevice } from '../contracts/dashboard';

const connectionLabel = {
  online: '在线',
  stale: '可能离线',
  offline: '离线',
} as const;

const connectionStyle = {
  online: 'ds-status--active',
  stale: 'ds-status--waiting',
  offline: 'ds-status--muted',
} as const;

function displayTimestamp(value: string | null): string {
  return value ? value.replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC') : '尚未上报';
}

export interface DeviceListProps {
  devices: readonly DashboardDevice[];
}

export default function DeviceList({ devices }: DeviceListProps) {
  if (devices.length === 0) return <p className="ds-constraint">尚未连接设备</p>;

  return <div className="ds-list ds-device-list" role="list" aria-label="设备">
    {devices.map(device => <article className="ds-card ds-device-card" key={device.id} role="listitem">
      <header className="ds-card__header">
        <h3 className="ds-card__title">{device.name}</h3>
        <span className={`ds-status ${connectionStyle[device.connection]}`}>
          {connectionLabel[device.connection]}
        </span>
      </header>
      <p className="ds-meta">最近上报：<time dateTime={device.heartbeatAt ?? undefined}>{displayTimestamp(device.heartbeatAt)}</time></p>
      {device.streamIncomplete ? <p className="ds-notice">事件流不完整</p> : null}
    </article>)}
  </div>;
}
