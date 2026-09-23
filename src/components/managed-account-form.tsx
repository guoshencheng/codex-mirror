'use client';

import { useRef, useState } from 'react';
import styles from './pixel-dashboard.module.css';
import CodexLoginForm from './codex-login-form';

type ManagedProviderId = 'deepseek' | 'kimi-code-cn';
type AccountRow = { id: number; providerId: ManagedProviderId; label: string; apiKey: string };
type AccountResult = { ok: true; id: string } | { ok: false; error: string };

function errorText(code: string, providerId: ManagedProviderId = 'deepseek'): string {
  const provider = providerId === 'deepseek' ? 'DeepSeek' : 'Kimi Code 中国站';
  if (['AUTH_REQUIRED', 'AUTH_EXPIRED', 'FORBIDDEN'].includes(code)) return 'API Key 无效或无权读取额度';
  if (code === 'RATE_LIMITED') return `${provider} 请求过于频繁，请稍后再试`;
  if (code === 'TIMEOUT') return `连接 ${provider} 超时，请稍后再试`;
  if (code === 'UNAVAILABLE') return `当前节点无法连接 ${provider} 额度接口`;
  if (code === 'SCHEMA_CHANGED') return `${provider} 返回的额度格式暂时无法识别`;
  if (code === 'CREDENTIAL_STORE_UNAVAILABLE') return '服务器密钥配置不可用';
  if (code === 'SAVE_UNAVAILABLE') return '额度已读取，但保存账号失败';
  if (code === 'INVALID_INPUT') return '请检查账号名称和 API Key';
  return '读取额度失败，请稍后重试';
}

export default function ManagedAccountForm({ onSaved }: { onSaved(done: boolean): Promise<void> }) {
  const nextId = useRef(1);
  const [rows, setRows] = useState<AccountRow[]>([{ id: 0, providerId: 'deepseek', label: '', apiKey: '' }]);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [codexMode, setCodexMode] = useState(false);

  const update = (id: number, field: 'label' | 'apiKey', value: string) => {
    setRows(current => current.map(row => row.id === id ? { ...row, [field]: value } : row));
    setErrors(current => { const copy = { ...current }; delete copy[id]; return copy; });
  };

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    setErrors({});
    try {
      const session = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      if (session.status === 401) { window.location.assign('/login'); return; }
      if (!session.ok) throw new Error('无法获取会话');
      const { csrfToken } = await session.json() as { csrfToken: string };
      const response = await fetch('/api/provider-accounts', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ accounts: rows.map(({ providerId, label, apiKey }) => ({ providerId, label, apiKey })) }),
      });
      if (response.status === 401) { window.location.assign('/login'); return; }
      const body = await response.json() as { error?: string; results?: AccountResult[] };
      if (!body.results || body.results.length !== rows.length) throw new Error(errorText(body.error ?? ''));
      const failed = rows.filter((_, index) => !body.results![index]?.ok);
      const nextErrors: Record<number, string> = {};
      rows.forEach((row, index) => {
        const result = body.results![index];
        if (result && !result.ok) nextErrors[row.id] = errorText(result.error, row.providerId);
      });
      setErrors(nextErrors);
      const savedCount = rows.length - failed.length;
      if (savedCount > 0) {
        setRows(failed.length ? failed : [{ id: nextId.current++, providerId: 'deepseek', label: '', apiKey: '' }]);
        setMessage(failed.length ? `已添加 ${savedCount} 个账号，以下账号可修改后重试。` : '账号已添加。');
        await onSaved(failed.length === 0);
      } else setMessage('未添加账号，请查看各行的错误。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '添加失败，请稍后重试'); }
    finally { setSaving(false); }
  }

  if (codexMode) return <CodexLoginForm onSaved={onSaved} onBack={() => setCodexMode(false)} />;

  return <form className={styles.manualForm} onSubmit={event => void save(event)}>
    <h2>添加账号</h2>
    <p>可添加 Codex、DeepSeek 和 Kimi Code 中国站账号，额度由服务端读取。</p>
    <button className={styles.action} type="button" onClick={() => setCodexMode(true)}>登录 Codex</button>
    {rows.map((row, index) => <div className={styles.accountEntry} key={row.id}>
      <div className={styles.accountEntryHead}><strong>账号 {index + 1}</strong>
        {rows.length > 1 ? <button type="button" disabled={saving} onClick={() => setRows(current => current.filter(item => item.id !== row.id))}>移除</button> : null}</div>
      <label>平台<select value={row.providerId} onChange={event => setRows(current => current.map(item => item.id === row.id ? { ...item, providerId: event.target.value as ManagedProviderId } : item))}>
        <option value="deepseek">DeepSeek</option><option value="kimi-code-cn">Kimi Code 中国站</option>
      </select></label>
      <label>账号名称<input required maxLength={120} value={row.label} onChange={event => update(row.id, 'label', event.target.value)} placeholder="例如：DeepSeek 主账号" /></label>
      <label>{row.providerId === 'deepseek' ? 'DeepSeek API Key' : 'Kimi Code 中国站 API Key'}<input required type="password" autoComplete="off" maxLength={500} value={row.apiKey} onChange={event => update(row.id, 'apiKey', event.target.value)} placeholder="sk-…" /></label>
      {errors[row.id] ? <p role="alert">{errors[row.id]}</p> : null}
    </div>)}
    {rows.length < 10 ? <button className={styles.action} type="button" disabled={saving} onClick={() => setRows(current => [...current, { id: nextId.current++, providerId: 'deepseek', label: '', apiKey: '' }])}>＋ 再加一个账号</button> : null}
    {message ? <p role="status">{message}</p> : null}
    <button className={styles.action} disabled={saving}>{saving ? '读取并保存中…' : `添加 ${rows.length} 个账号并读取额度`}</button>
  </form>;
}
