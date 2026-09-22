'use client';

import Link from 'next/link';
import type { DashboardDto, DashboardSession } from '../contracts/dashboard';
import DeviceList from './device-list';
import QuotaCard from './quota-card';
import SessionList from './session-list';
import { useDashboardStream } from './use-dashboard-stream';

function elapsed(start: string | null, now: Date): string | null {
  if (!start) return null;
  const startedAt = Date.parse(start);
  if (!Number.isFinite(startedAt)) return null;
  const seconds = Math.max(0, Math.floor((now.getTime() - startedAt) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function sessionDuration(session: DashboardSession, now: Date): string | null {
  return elapsed(session.turnStartedAt, now);
}

export interface DashboardProps {
  initial: DashboardDto;
}

export default function Dashboard({ initial }: DashboardProps) {
  const { data, connected, now, refresh, refreshQuota, logout } = useDashboardStream(initial);

  return <main className="ds-app">
    <header className="ds-topbar">
      <Link className="ds-topbar__brand" href="/">Codex 状态面板</Link>
      <nav className="ds-topbar__nav" aria-label="主导航">
        <Link href="/">状态面板</Link>
        <Link href="/devices">设备</Link>
        <button className="ds-btn ds-btn--sm" type="button" onClick={() => void logout()}>退出登录</button>
      </nav>
    </header>

    <header className="ds-page-header">
      <div>
        <span className="ds-page-header__context">实时状态</span>
        <h1 className="ds-page-header__title">任务与额度</h1>
        <p className="ds-page-header__description">设备上报事件驱动更新；离线时保留最近一次已知状态。</p>
      </div>
      <div className="ds-actions">
        <span className={`ds-status ${connected ? 'ds-status--active' : 'ds-status--waiting'}`} aria-label="实时流状态" aria-live="polite">
          {connected ? '实时流已连接' : '实时流已断开'}
        </span>
        <button className="ds-btn" type="button" onClick={() => void refresh()}>刷新全部</button>
      </div>
    </header>

    <section className="ds-stack" aria-labelledby="quota-heading">
      <h2 className="ds-panel-title" id="quota-heading">Provider 额度</h2>
      {data.accounts.length > 0
        ? <div className="ds-metric-grid">
          {data.accounts.map(account => <QuotaCard key={account.id} account={account} now={now} onRefresh={refreshQuota} />)}
        </div>
        : <p className="ds-constraint">尚未配置额度账号</p>}
    </section>

    <div className="ds-content-grid">
      <section className="ds-stack" aria-labelledby="devices-heading">
        <div className="ds-card__header">
          <h2 className="ds-panel-title" id="devices-heading">设备</h2>
          <Link className="ds-btn ds-btn--sm" href="/devices">设备接入</Link>
        </div>
        <DeviceList devices={data.devices} />
      </section>

      <section className="ds-stack" aria-labelledby="sessions-heading">
        <h2 className="ds-panel-title" id="sessions-heading">会话</h2>
        <SessionList sessions={data.sessions} devices={data.devices} />
        {data.sessions.some(session => session.turnStartedAt !== null)
          ? <section className="ds-card" aria-label="会话持续时间">
            <h3 className="ds-card__title">本轮持续时间</h3>
            <div className="ds-list">
              {data.sessions.filter(session => session.turnStartedAt !== null).map(session => (
                <p className="ds-row" key={`${session.deviceId}:${session.id}`}>
                  <span className="ds-row__main">{session.title}</span>
                  <time className="ds-status ds-status--muted">{sessionDuration(session, now)}</time>
                </p>
              ))}
            </div>
          </section>
          : null}
      </section>
    </div>

    <footer className="ds-statusbar">
      <span>{connected ? '接收实时变更' : '连接中断，显示最近快照'}</span>
      <span>快照时间：<time dateTime={data.generatedAt}>{data.generatedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC')}</time></span>
      <span>当前时间：<time dateTime={now.toISOString()}>{now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC')}</time></span>
    </footer>
  </main>;
}
