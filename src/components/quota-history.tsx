'use client';

import { useEffect, useRef, useState } from 'react';
import type { QuotaHistoryDto, QuotaHistoryLoader, QuotaHistoryRange } from '../contracts/quota-history';
import QuotaHistoryChart from './quota-history-chart';
import styles from './quota-history.module.css';

const ranges: readonly { value: QuotaHistoryRange; label: string }[] = [
  { value: '24h', label: '24 小时' }, { value: '7d', label: '7 天' }, { value: '30d', label: '30 天' }, { value: '90d', label: '90 天' },
];

export default function QuotaHistory({ accountId, loadHistory }: { accountId: string; loadHistory: QuotaHistoryLoader }) {
  const [range, setRange] = useState<QuotaHistoryRange>('24h');
  const [retry, setRetry] = useState(0);
  const [history, setHistory] = useState<QuotaHistoryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const historyRef = useRef<QuotaHistoryDto | null>(null);
  const identityRef = useRef<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const identity = `${accountId}:${range}`;
    const preserve = identityRef.current === identity && historyRef.current?.accountId === accountId && historyRef.current?.range === range;
    identityRef.current = identity;
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    if (!preserve) {
      historyRef.current = null;
      setHistory(null);
    }
    setLoading(true);
    setError(false);
    let disposed = false;

    const load = async () => {
      if (disposed || document.visibilityState === 'hidden') return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      try {
        const result = await loadHistory(accountId, range, controller.signal);
        if (disposed || controller.signal.aborted || generation !== generationRef.current) return;
        historyRef.current = result;
        setHistory(result);
        setError(false);
      } catch {
        if (disposed || controller.signal.aborted || generation !== generationRef.current) return;
        setError(true);
      } finally {
        if (!disposed && generation === generationRef.current && controllerRef.current === controller) setLoading(false);
      }
    };

    void load();
    const timer = window.setInterval(() => { void load(); }, 60_000);
    const visibility = () => {
      if (document.visibilityState === 'hidden') controllerRef.current?.abort();
      else void load();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true;
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [accountId, range, loadHistory, retry]);

  return <section className={styles.history} aria-label="额度历史">
    <header className={styles.historyHeader}>
      <h3>额度历史</h3>
      <div className={styles.rangeButtons} role="group" aria-label="历史范围">
        {ranges.map(item => <button key={item.value} type="button" aria-pressed={range === item.value} onClick={() => setRange(item.value)}>{item.label}</button>)}
      </div>
    </header>
    {range !== '24h' ? <p className={styles.sampled}>采样趋势</p> : null}
    {error && history ? <p className={styles.error} role="alert">历史更新失败 <button type="button" onClick={() => setRetry(value => value + 1)} aria-label="重试历史">重试</button></p> : null}
    {error && !history ? <p className={styles.error} role="alert">历史加载失败 <button type="button" onClick={() => setRetry(value => value + 1)} aria-label="重试历史">重试</button></p> : null}
    {loading && !history ? <p className={styles.loading} role="status">正在加载额度历史…</p> : null}
    {history ? <QuotaHistoryChart history={history} /> : null}
    {!loading && !error && !history ? <p className={styles.empty}>所选时间范围内暂无额度历史</p> : null}
  </section>;
}
