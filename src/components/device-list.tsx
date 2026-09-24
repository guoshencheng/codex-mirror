'use client';

import { useState } from 'react';
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
  const [names, setNames] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  async function save(id: string): Promise<void> {
    const name = draft.trim();
    if (!name || name.length > 120) { setMessage('名称需为 1 到 120 个字符。'); return; }
    setSaving(true);
    setMessage('');
    try {
      const sessionResponse = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      if (!sessionResponse.ok) throw new Error('登录已过期，请重新登录。');
      const session = await sessionResponse.json() as { csrfToken?: unknown };
      if (typeof session.csrfToken !== 'string') throw new Error('无法验证当前登录状态。');
      const response = await fetch('/api/devices/rename', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ id, name }),
      });
      if (!response.ok) throw new Error(response.status === 401 ? '登录已过期，请重新登录。' : '保存失败，请稍后重试。');
      const saved = await response.json() as { name?: unknown };
      if (typeof saved.name !== 'string') throw new Error('服务器返回的名称无效。');
      setNames(previous => ({ ...previous, [id]: saved.name as string }));
      setEditing(null);
      setMessage('设备名称已保存。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败，请稍后重试。');
    } finally { setSaving(false); }
  }

  if (devices.length === 0) return <p className="ds-constraint">尚未连接设备</p>;

  return <div className="ds-list ds-device-list" role="list" aria-label="设备">
    {devices.map(device => <article className="ds-card ds-device-card" key={device.id} role="listitem">
      <header className="ds-card__header">
        <h3 className="ds-card__title">{names[device.id] ?? device.name}</h3>
        <span className={`ds-status ${connectionStyle[device.connection]}`}>
          {connectionLabel[device.connection]}
        </span>
      </header>
      {editing === device.id ? <form onSubmit={event => { event.preventDefault(); void save(device.id); }}>
        <label htmlFor={`device-name-${device.id}`}>设备显示名</label>
        <input id={`device-name-${device.id}`} className="ds-input" value={draft} maxLength={120}
          onChange={event => setDraft(event.target.value)} disabled={saving} />
        <div className="ds-actions">
          <button className="ds-btn ds-btn--primary" type="submit" disabled={saving}>{saving ? '保存中…' : '保存名称'}</button>
          <button className="ds-btn" type="button" onClick={() => { setEditing(null); setMessage(''); }} disabled={saving}>取消</button>
        </div>
      </form> : <button className="ds-btn" type="button" aria-label={`修改 ${names[device.id] ?? device.name} 的显示名`}
        onClick={() => { setEditing(device.id); setDraft(names[device.id] ?? device.name); setMessage(''); }}>改名</button>}
      {editing === device.id && message ? <p className="ds-notice" role="status">{message}</p> : null}
      <p className="ds-meta">最近上报：<time dateTime={device.heartbeatAt ?? undefined}>{displayTimestamp(device.heartbeatAt)}</time></p>
      {device.streamIncomplete ? <p className="ds-notice">事件流不完整</p> : null}
    </article>)}
  </div>;
}
