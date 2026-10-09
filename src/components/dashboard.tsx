'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardDto } from '../contracts/dashboard';
import type { QuotaHistoryLoader } from '../contracts/quota-history';
import { createQuotaHistoryLoader } from '../lib/quota-history-client';
import QuotaCard from './quota-card';
import PixelQuotaRow from './pixel-quota-row';
import { syncCountdownText } from './pixel-dashboard-model';
import { useDashboardPolling } from './use-dashboard-polling';
import styles from './pixel-dashboard.module.css';

type Detail = { kind: 'account'; id: string };
const ACCOUNTS_PER_PAGE = 9;

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
  historyLoader?: QuotaHistoryLoader;
}

export default function Dashboard({ initial, readOnly = false, externalSnapshot, externalHealthy, settingsHref, historyLoader: suppliedHistoryLoader }: DashboardProps) {
  const polling = useDashboardPolling(initial, { readOnly });
  const data = externalSnapshot ?? polling.data;
  const syncHealthy = externalHealthy ?? polling.syncHealthy;
  const { now } = polling;
  const historyLoader = useMemo(() => {
    if (suppliedHistoryLoader) return suppliedHistoryLoader;
    return readOnly ? undefined : createQuotaHistoryLoader();
  }, [readOnly, suppliedHistoryLoader]);
  const host = useRef<HTMLElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [scale, setScale] = useState<number | null>(null);
  const [accountPage, setAccountPage] = useState(0);
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

  const accountPages = Math.max(1, Math.ceil(data.accounts.length / ACCOUNTS_PER_PAGE));
  const visibleAccountPage = Math.min(accountPage, accountPages - 1);
  const selectedAccount = detail ? data.accounts.find(account => account.id === detail.id) : undefined;
  const staticSnapshot = readOnly && externalSnapshot === undefined && externalHealthy === undefined;

  return <main ref={host} className={styles.host} aria-label="Provider 额度面板">
    <div className={styles.frame} style={{ width: scale === null ? 0 : scale * 400, height: scale === null ? 0 : scale * 400 }}>
      <div className={`${styles.board} ${syncHealthy ? '' : styles.offline}`}
        data-testid="pixel-dashboard" style={{ transform: `scale(${scale ?? 1})`, visibility: scale === null ? 'hidden' : 'visible' }}
        onKeyDown={event => { if (event.key === 'Escape' && detail) { event.preventDefault(); setDetail(null); } }}>
        <header className={styles.topbar}>
          <h1>▦ PROVIDER QUOTAS</h1>
          <div className={styles.topActions}>
            <span className={styles.connection} aria-label="额度同步状态" aria-live="polite"><i />{syncHealthy ? '同步正常' : '同步中断'}</span>
            {settingsHref ? <a className={styles.settingsLink} href={settingsHref} aria-label="打开设置" title="打开设置">⚙</a> : null}
          </div>
        </header>
        {detail ? <section className={styles.detailView} aria-label="额度详情">
          <button className={styles.back} aria-label="返回面板" ref={backButton} onClick={() => setDetail(null)}>‹ 返回面板</button>
          <div className={styles.detailScroll}>
            {selectedAccount ? <QuotaCard account={selectedAccount} now={now}
              onRefresh={accountId => polling.refreshQuota(accountId)} readOnly={readOnly} historyLoader={historyLoader} />
              : <p>该账号已不在当前快照中</p>}
          </div>
        </section> : <>
          <section className={styles.hero} aria-label="额度总览">
            <PixelRobot /><h2>额度总览</h2>
            <span className={styles.summary}>{data.accounts.length ? `${data.accounts.length} 个账号已接入` : '添加 Provider 账号以开始追踪'}</span>
          </section>
          <section className={styles.quota} aria-labelledby="quota-heading">
            <div className={styles.sectionHead}><h2 id="quota-heading">Provider 额度 <small>/ 剩余</small></h2>
              <Pager page={visibleAccountPage} pages={accountPages} label="额度" onChange={setAccountPage} />
            </div>
            <ul className={styles.providerList} aria-label="Provider 额度">
              {data.accounts.slice(visibleAccountPage * ACCOUNTS_PER_PAGE, (visibleAccountPage + 1) * ACCOUNTS_PER_PAGE).map(account => <PixelQuotaRow
                key={account.id} account={account} now={now} onOpen={() => {
                  opener.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
                  setDetail({ kind: 'account', id: account.id });
                }} />)}
            </ul>
            {!data.accounts.length ? <p className={styles.empty}>尚未配置额度账号</p> : null}
          </section>
        </>}
        <footer className={styles.footer}>
          <span title={`快照时间：${data.generatedAt}`}>{staticSnapshot ? '静态预览' : syncHealthy ? syncCountdownText(data.generatedAt, now) : '同步中断'}</span>
        </footer>
      </div>
    </div>
  </main>;
}
