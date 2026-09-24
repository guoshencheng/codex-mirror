'use client';

import { useState } from 'react';

interface InstallLinkResponse {
  installUrl?: unknown;
  collectorOrigin?: unknown;
  expiresAt?: unknown;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function displayExpiry(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export default function InstallLinkGenerator() {
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  async function generate(): Promise<void> {
    setBusy(true);
    setCommand(null);
    setExpiresAt(null);
    setMessage('');
    try {
      const sessionResponse = await fetch('/api/auth/session', { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
      if (!sessionResponse.ok) throw new Error(sessionResponse.status === 401 ? '登录已过期，请重新登录。' : '无法验证当前登录状态。');
      const session = await sessionResponse.json() as { csrfToken?: unknown };
      if (typeof session.csrfToken !== 'string' || session.csrfToken.length < 40) throw new Error('无法验证当前登录状态。');

      const response = await fetch('/api/devices/install-link', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: '{}',
      });
      if (!response.ok) throw new Error(response.status === 401 ? '登录已过期，请重新登录。' : '生成安装链接失败，请稍后重试。');
      const result = await response.json() as InstallLinkResponse;
      if (typeof result.installUrl !== 'string' || typeof result.expiresAt !== 'string') throw new Error('服务器返回的安装链接无效。');
      const url = new URL(result.installUrl);
      const collectorOrigin = typeof result.collectorOrigin === 'string' ? result.collectorOrigin : window.location.origin;
      const grant = url.searchParams.get('grant');
      if (url.origin !== collectorOrigin ||
          (url.origin !== window.location.origin && url.protocol !== 'https:') ||
          url.username || url.password || url.pathname !== '/api/collector/install' || url.hash ||
          [...url.searchParams.keys()].some(key => key !== 'grant') ||
          url.searchParams.getAll('grant').length !== 1 || !grant || !/^[A-Za-z0-9_-]{43}$/.test(grant)) {
        throw new Error('服务器返回的安装链接无效。');
      }
      setCommand(`curl -fsSL ${shellQuote(url.toString())} | bash`);
      setExpiresAt(result.expiresAt);
      setMessage('安装命令已生成；授权码 15 分钟内有效，执行后只能注册一台设备。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '生成安装链接失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  async function copyCommand(): Promise<void> {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setMessage('已复制安装命令。授权码 15 分钟内有效，执行后只能注册一台设备。');
    } catch {
      setMessage('复制失败，请手动复制上方命令。');
    }
  }

  return <div className="ds-stack">
    <div className="ds-actions">
      <button className="ds-btn ds-btn--primary" type="button" onClick={() => void generate()} disabled={busy}>
        {busy ? '正在生成…' : '生成一次性安装命令'}
      </button>
      {command ? <button className="ds-btn" type="button" onClick={() => void copyCommand()}>复制安装命令</button> : null}
    </div>
    {command ? <>
      <pre className="ds-card"><code>{command}</code></pre>
      {expiresAt ? <p className="ds-meta">有效期至 {displayExpiry(expiresAt)}</p> : null}
    </> : null}
    {message ? <p className="ds-notice" role="status" aria-live="polite">{message}</p> : null}
  </div>;
}
