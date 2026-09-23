'use client';

import { useEffect, useState } from 'react';
import styles from './pixel-dashboard.module.css';

type LoginState = { id: string; status: string; verificationUrl: string | null; userCode: string | null; accountId: string | null; error: string | null };
const active = new Set(['queued', 'starting', 'awaiting']);

function message(error: string | null): string {
  if (error === 'CODEX_AUTH_UNAVAILABLE') return '无法启动设备码登录。请在 ChatGPT 设置中确认已启用设备码登录。';
  if (error === 'LOGIN_EXPIRED') return '登录已过期，请重新开始。';
  if (error === 'WORKER_RESTARTED') return '服务已重启，请重新开始登录。';
  if (error === 'LOGIN_IN_PROGRESS') return '当前会话已有登录进行中，请等待或取消后重试。';
  if (error === 'LOGIN_CAP_REACHED') return '当前登录请求较多，请稍后重试。';
  return 'Codex 登录失败，请重试。';
}

function officialUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'auth.openai.com' ? value : null;
  } catch { return null; }
}

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) { window.location.assign('/login'); throw new Error('请重新登录看板'); }
  if (!response.ok) throw new Error('无法获取会话');
  const body = await response.json() as { csrfToken?: string };
  if (!body.csrfToken) throw new Error('无法获取会话');
  return body.csrfToken;
}

export default function CodexLoginForm({ onSaved, onBack }: { onSaved(done: boolean): Promise<void>; onBack(): void }) {
  const [label, setLabel] = useState('');
  const [login, setLogin] = useState<LoginState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!login || !active.has(login.status)) return;
    let stopped = false;
    const poll = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const response = await fetch(`/api/provider-accounts/codex-login/${encodeURIComponent(login.id)}`, { credentials: 'same-origin', cache: 'no-store' });
        if (response.status === 401) { window.location.assign('/login'); return; }
        if (!response.ok) throw new Error('读取登录状态失败');
        const next = await response.json() as LoginState;
        if (!stopped) {
          setLogin(next);
          if (next.status === 'succeeded') await onSaved(true);
        }
      } catch { if (!stopped) setError('暂时无法读取登录状态，正在重试。'); }
    };
    const timer = window.setInterval(() => { void poll(); }, 2000);
    void poll();
    return () => { stopped = true; window.clearInterval(timer); };
  }, [login?.id, login?.status, onSaved]);

  async function start(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const token = await csrfToken();
      const response = await fetch('/api/provider-accounts/codex-login', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ label: label.trim() }),
      });
      if (response.status === 401) { window.location.assign('/login'); return; }
      const body = await response.json() as LoginState & { error?: string };
      if (!response.ok) throw new Error(message(body.error ?? null));
      setLogin(body);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '无法开始登录'); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (!login) return;
    setBusy(true);
    try {
      const token = await csrfToken();
      await fetch(`/api/provider-accounts/codex-login/${encodeURIComponent(login.id)}`, {
        method: 'DELETE', credentials: 'same-origin', cache: 'no-store', headers: { 'X-CSRF-Token': token },
      });
      setLogin(null);
    } catch { setError('取消失败，请稍后重试。'); }
    finally { setBusy(false); }
  }

  const url = officialUrl(login?.verificationUrl ?? null);
  return <section className={styles.manualForm} aria-label="添加 Codex 账号">
    <h2>添加 Codex 账号</h2>
    <p>使用 ChatGPT 设备码登录。请先在 ChatGPT 设置中启用设备码登录。</p>
    {!login || !active.has(login.status) ? <form onSubmit={event => void start(event)}>
      <label>账号名称<input required maxLength={120} value={label} onChange={event => setLabel(event.target.value)} placeholder="例如：Codex 主账号" /></label>
      <button className={styles.action} disabled={busy}>{busy ? '正在开始…' : '开始 Codex 登录'}</button>
    </form> : null}
    {active.has(login?.status ?? '') ? <div role="status">
      {url && login?.userCode ? <p>打开 <a href={url} target="_blank" rel="noopener noreferrer">OpenAI 授权页面</a>，输入代码 <strong>{login.userCode}</strong>。</p>
        : <p>正在获取授权代码…</p>}
      <p>等待 ChatGPT 登录完成…</p>
      <button className={styles.action} type="button" disabled={busy} onClick={() => void cancel()}>取消登录</button>
    </div> : null}
    {login?.status === 'succeeded' ? <p role="status">Codex 账号已添加，额度正在显示。</p> : null}
    {login && ['failed', 'expired', 'cancelled'].includes(login.status) ? <p role="alert">{message(login.error)}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <button className={styles.action} type="button" onClick={onBack}>返回其他平台</button>
  </section>;
}
