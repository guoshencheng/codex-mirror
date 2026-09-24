import { useEffect, useState } from 'react';
import Dashboard from '../../src/components/dashboard';
import type { DashboardDto } from '../../src/contracts/dashboard';
import { DISPLAY_TOKEN_PATTERN, normalizeApiOrigin } from '../../src/lib/display-connection';
import { useDisplaySnapshot } from './api';
import '../../src/app/globals.css';
import './style.css';

const DEFAULT_ORIGIN = 'https://codex-status.icerock.top';
const EMPTY: DashboardDto = { generatedAt: new Date(0).toISOString(), devices: [], sessions: [], accounts: [] };

function savedToken(): string | null {
  try {
    const value = sessionStorage.getItem('display-user-token');
    return value && DISPLAY_TOKEN_PATTERN.test(value) ? value : null;
  } catch { return null; }
}

function savedOrigin(): string {
  try { return normalizeApiOrigin(localStorage.getItem('display-api-origin') ?? DEFAULT_ORIGIN); }
  catch { return DEFAULT_ORIGIN; }
}

export default function App() {
  const [token, setToken] = useState(savedToken);
  const [origin] = useState(savedOrigin);
  const [linkError, setLinkError] = useState('');
  const { snapshot, syncHealthy, error } = useDisplaySnapshot(origin, token);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.hash.slice(1));
    const tokens = parameters.getAll('token');
    if (!tokens.length) return;
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    if (tokens.length !== 1 || !DISPLAY_TOKEN_PATTERN.test(tokens[0]!)) {
      setLinkError('展示链接中的 Token 无效。');
      return;
    }
    try {
      sessionStorage.setItem('display-user-token', tokens[0]!);
      setToken(tokens[0]!);
      setLinkError('');
    } catch { setLinkError('无法保存展示链接中的 Token。'); }
  }, []);

  if (!token) return <main className="display-access-message" role="status">
    <h1>CODEX DESK</h1>
    <p>{linkError || '请使用带 Token 的展示链接打开此页面。'}</p>
  </main>;

  return <>
    <Dashboard initial={EMPTY} readOnly externalSnapshot={snapshot} externalHealthy={syncHealthy} />
    {error === 'TOKEN_INVALID' ? <p className="display-access-error" role="alert">展示 Token 已失效，请重新打开有效的展示链接。</p> : null}
  </>;
}
