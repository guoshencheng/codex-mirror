'use client';

import { useEffect, useRef, useState } from 'react';
import type { DashboardDto } from '../contracts/dashboard';
import QuotaCard from './quota-card';
import PixelQuotaRow from './pixel-quota-row';
import { ageText, durationText, harnessLabel, isCurrentSession, sessionLabels } from './pixel-dashboard-model';
import { useDashboardPolling } from './use-dashboard-polling';
import styles from './pixel-dashboard.module.css';

type Detail = { kind: 'account'; id: string } | { kind: 'session'; id: string; deviceId: string } | { kind: 'devices' };

function Pager({ page, pages, label, onChange }: { page: number; pages: number; label: string; onChange(page: number): void }) {
  if (pages <= 1) return null;
  return <span className={styles.pager}>
    <button aria-label={`上一页${label}`} disabled={page === 0} onClick={() => onChange(page - 1)}>‹</button>
    <span aria-label={`${label}页码`}>{page + 1}/{pages}</span>
    <button aria-label={`下一页${label}`} disabled={page + 1 >= pages} onClick={() => onChange(page + 1)}>›</button>
  </span>;
}

function PixelRobot() {
  return <span className={styles.robot} aria-hidden="true"><svg viewBox="0 0 32 32" shapeRendering="crispEdges">
    <path fill="#0b151a" d="M14 2h4v5h-4zM6 7h20v3h3v15h-4v5h-7v-4h-4v4H7v-5H3V10h3z" />
    <path fill="currentColor" d="M14 2h4v3h-4zM7 8h18v3h3v12h-5v5h-4v-5h-6v5H9v-5H4V11h3z" />
    <path fill="#dcecc1" d="M8 9h16v2H8z" /><path fill="#233638" d="M8 12h16v9H8z" />
    <path fill="currentColor" d="M10 14h3v3h-3zM19 14h3v3h-3zM14 18h4v1h-4z" />
    <path fill="#344b49" d="M3 29h26v2H3z" />
  </svg></span>;
}

export interface DashboardProps {
  initial: DashboardDto;
  readOnly?: boolean;
  externalSnapshot?: DashboardDto | null;
  externalHealthy?: boolean;
  settingsHref?: string;
}

export default function Dashboard({ initial, readOnly = false, externalSnapshot, externalHealthy, settingsHref }: DashboardProps) {
  const polling = useDashboardPolling(initial, { readOnly });
  const data = externalSnapshot ?? polling.data;
  const syncHealthy = externalHealthy ?? polling.syncHealthy;
  const { now } = polling;
  const host = useRef<HTMLElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [scale, setScale] = useState<number | null>(null);
  const [accountPage, setAccountPage] = useState(0);
  const [sessionPage, setSessionPage] = useState(0);
  const [detail, setDetail] = useState<Detail | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const fit = () => setScale(Math.min(element.clientWidth, element.clientHeight) / 400);
    fit();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', fit);
      return () => window.removeEventListener('resize', fit);
    }
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (detail) backButton.current?.focus();
    else opener.current?.focus();
  }, [detail]);

  const devicesById = new Map(data.devices.map(device => [device.id, device]));
  const activeSessions = data.sessions.filter(session => session.state === 'WORKING' || session.state === 'WAITING_APPROVAL');
  const current = activeSessions.filter(session => isCurrentSession(session, devicesById.get(session.deviceId), syncHealthy));
  const working = current.filter(session => session.state === 'WORKING');
  const waiting = current.filter(session => session.state === 'WAITING_APPROVAL').length;
  const recentlyWorking = activeSessions.filter(session => session.state === 'WORKING').length;
  const recentlyWaiting = activeSessions.filter(session => session.state === 'WAITING_APPROVAL').length;
  const online = data.devices.filter(device => device.connection === 'online').length;
  const offline = !syncHealthy || (data.devices.length > 0 && online === 0);
  const staticSnapshot = readOnly && externalSnapshot === undefined && externalHealthy === undefined;
  const title = offline ? '连接待恢复' : waiting ? '等你点个头' : working.length ? '正在工作'
    : recentlyWaiting ? '最近有待响应' : recentlyWorking ? '最近有任务运行' : '正在待命';
  const priority = (state: string) => state === 'WAITING_APPROVAL' ? 0 : state === 'WORKING' ? 1 : 2;
  const sessions = [...activeSessions].sort((a, b) => priority(a.state) - priority(b.state) || b.lastEventAt.localeCompare(a.lastEventAt));
  const listedSessions = sessions.slice(0, 12);
  const accountPages = Math.max(1, Math.ceil(data.accounts.length / 3));
  const sessionPages = Math.max(1, Math.ceil(listedSessions.length / 6));
  const visibleAccountPage = Math.min(accountPage, accountPages - 1);
  const visibleSessionPage = Math.min(sessionPage, sessionPages - 1);
  const selectedAccount = detail?.kind === 'account' ? data.accounts.find(account => account.id === detail.id) : undefined;
  const selectedSession = detail?.kind === 'session' ? data.sessions.find(session => session.id === detail.id && session.deviceId === detail.deviceId) : undefined;
  const selectedDevice = selectedSession ? devicesById.get(selectedSession.deviceId) : undefined;
  const longestStart = working.map(session => session.turnStartedAt).filter((at): at is string => at !== null && Number.isFinite(Date.parse(at))).sort()[0] ?? null;

  const open = (next: Detail, button: HTMLButtonElement) => { opener.current = button; setDetail(next); };
  return <main ref={host} className={styles.host} aria-label="Codex 状态面板">
    <div className={styles.frame} style={{ width: scale === null ? 0 : scale * 400, height: scale === null ? 0 : scale * 400 }}>
      <div className={`${styles.board} ${offline ? styles.offline : waiting ? styles.waiting : ''}`}
        data-testid="pixel-dashboard" style={{ transform: `scale(${scale ?? 1})`, visibility: scale === null ? 'hidden' : 'visible' }}
        onKeyDown={event => { if (event.key === 'Escape' && detail) { event.preventDefault(); setDetail(null); } }}>
        <header className={styles.topbar}>
          <h1>▦ CODEX DESK</h1>
          <div className={styles.topActions}>
            <span className={styles.connection} aria-label="面板同步状态" aria-live="polite"><i />{syncHealthy ? '同步正常' : '同步中断'}</span>
            {settingsHref ? <a className={styles.settingsLink} href={settingsHref} aria-label="打开设置" title="打开设置">⚙</a> : null}
          </div>
        </header>
        {detail ? <section className={styles.detailView} aria-label="面板详情">
          <button className={styles.back} aria-label="返回面板" ref={backButton} onClick={() => setDetail(null)}>‹ 返回面板</button>
          <div className={styles.detailScroll}>
            {detail.kind === 'account' ? selectedAccount
              ? <QuotaCard account={selectedAccount} now={now} onRefresh={() => {}} readOnly /> : <p>该账号已不在当前快照中</p> : null}
            {detail.kind === 'session' ? selectedSession ? <article className={styles.sessionDetail}>
              <h2>{selectedSession.title}</h2>
              <p>{isCurrentSession(selectedSession, selectedDevice, syncHealthy) ? '当前状态' : '最近状态'}：{sessionLabels[selectedSession.state]}</p>
              {!isCurrentSession(selectedSession, selectedDevice, syncHealthy) ? <p className={styles.warning}>当前执行情况未知，请检查设备连接与状态同步。</p> : null}
              <dl><dt>项目</dt><dd>{selectedSession.projectName ?? '未归属项目'}</dd>
                <dt>Harness</dt><dd>{harnessLabel(selectedSession)}</dd>
                <dt>设备</dt><dd>{selectedDevice?.name ?? '未知设备'}</dd>
                <dt>状态可信度</dt><dd>{selectedSession.confidence === 'confirmed' ? '已确认' : '未确认'}</dd>
                {selectedSession.currentTool ? <><dt>当前工具</dt><dd>{selectedSession.currentTool}</dd></> : null}
                <dt>最近活动</dt><dd><time dateTime={selectedSession.lastReceivedAt}
                  title={selectedSession.lastEventAt}>{ageText(selectedSession.lastReceivedAt, now)}</time></dd>
                <dt>本轮开始</dt><dd>{selectedSession.turnStartedAt ?? '未上报'}</dd>
                {selectedSession.state === 'WORKING' && isCurrentSession(selectedSession, selectedDevice, syncHealthy)
                  ? <><dt>本轮持续</dt><dd>{durationText(selectedSession.turnStartedAt, now)}</dd></> : null}
              </dl>
            </article> : <p>该会话已不在当前快照中</p> : null}
            {detail.kind === 'devices' ? <><h2>设备状态</h2>{data.devices.map(device =>
              <p key={device.id}>{device.name} · {device.connection === 'online' ? '在线' : device.connection === 'stale' ? '待确认' : '离线'}</p>)}</> : null}
          </div>
        </section> : <>
          <section className={styles.hero} aria-label="任务总状态">
            <PixelRobot /><h2>{title}</h2>
            <span className={styles.summary}>{offline ? '显示最近快照' : waiting ? `${waiting} 个任务待审批` : working.length ? `${working.length} 个任务执行中`
              : recentlyWaiting ? `${recentlyWaiting} 个任务最近等待响应` : recentlyWorking ? `${recentlyWorking} 个任务最近执行中` : '等待新的任务'}</span>
            {working.length && !offline ? <time className={styles.timer} title="当前执行中任务的最长持续时间">{durationText(longestStart, now)}</time> : null}
          </section>
          <section className={styles.quota} aria-labelledby="quota-heading">
            <div className={styles.sectionHead}><h2 id="quota-heading">额度 <small>/ 剩余</small></h2>
              <Pager page={visibleAccountPage} pages={accountPages} label="额度" onChange={setAccountPage} />
              {accountPages === 1 ? <span>额度窗口 · 或余额</span> : null}
            </div>
            <ul className={styles.providerList} aria-label="Provider 额度">
              {data.accounts.slice(visibleAccountPage * 3, visibleAccountPage * 3 + 3).map(account => <PixelQuotaRow
                key={account.id} account={account} now={now} onOpen={() => {
                  opener.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
                  setDetail({ kind: 'account', id: account.id });
                }} />)}
            </ul>
            {!data.accounts.length ? <p className={styles.empty}>尚未配置额度账号</p> : null}
          </section>
          <section className={styles.sessions} aria-labelledby="sessions-heading">
            <div className={styles.sectionHead}><h2 id="sessions-heading">会话 <small>/ {listedSessions.length}</small></h2>
              <span>{waiting} 待审批 · {working.length} 执行中</span>
              <Pager page={visibleSessionPage} pages={sessionPages} label="会话" onChange={setSessionPage} />
            </div>
            <ul className={styles.sessionList} aria-label="会话">
              {listedSessions.slice(visibleSessionPage * 6, visibleSessionPage * 6 + 6).map(session => {
                const device = devicesById.get(session.deviceId);
                const currentState = isCurrentSession(session, device, syncHealthy);
                const label = `${currentState ? '' : '最近：'}${sessionLabels[session.state]}`;
                return <li key={`${session.deviceId}:${session.id}`} className={currentState && session.state === 'WAITING_APPROVAL' ? styles.attention : ''}>
                  <h3><button className={styles.sessionRow} onClick={event => open({ kind: 'session', id: session.id, deviceId: session.deviceId }, event.currentTarget)}
                    title={`${session.title} · ${harnessLabel(session)} · ${session.projectName ?? '未归属项目'} · ${device?.name ?? '未知设备'} · ${label}`}>
                    <span className={styles.symbol} aria-hidden="true">{!currentState ? '?' : session.state === 'WAITING_APPROVAL' ? '!' : session.state === 'WORKING' ? '›' : '·'}</span>
                    <span className={styles.sessionName}>{session.title}</span>
                    <span className={styles.project}>{harnessLabel(session)} · {device?.name ?? '未知设备'}</span>
                    <span className={styles.badge}>{label}</span>
                  </button></h3>
                </li>;
              })}
            </ul>
            {!sessions.length ? <p className={styles.empty}>暂无运行中或待你响应的会话</p> : null}
          </section>
        </>}
        <footer className={styles.footer}>
          <button title="查看设备状态" aria-label="查看设备状态" onClick={event => open({ kind: 'devices' }, event.currentTarget)}>■ {online}/{data.devices.length} 在线{data.devices.length > online ? ` · ${data.devices.length - online} 未在线` : ''}</button>
          <span title={`快照时间：${data.generatedAt}`}>{staticSnapshot ? '静态快照' : syncHealthy ? syncCountdownText(data.generatedAt, now) : '同步中断'}</span>
        </footer>
      </div>
    </div>
  </main>;
}
