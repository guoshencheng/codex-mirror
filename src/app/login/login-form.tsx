'use client';

import { useState, type FormEvent } from 'react';

export default function LoginForm() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: form.get('token') }),
        cache: 'no-store',
      });
      if (response.ok) {
        window.location.assign('/');
        return;
      }
      setError(response.status === 429 ? '登录尝试过多，请稍后再试。' : '用户 Token 不正确。');
    } catch {
      setError('暂时无法登录，请检查网络后重试。');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <h1>Codex 状态面板</h1>
    <form onSubmit={submit} autoComplete="on">
      <label htmlFor="token">用户 Token</label>
      <input id="token" name="token" type="password" autoComplete="current-password" required maxLength={256} spellCheck={false} />
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
    </form>
  </>;
}
