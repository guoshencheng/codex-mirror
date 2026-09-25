import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardDto } from '../../src/contracts/dashboard';
import { DASHBOARD_POLL_INTERVAL_MS } from '../../src/components/pixel-dashboard-model';
export { normalizeApiOrigin } from '../../src/lib/display-connection';

function isDashboard(value: unknown): value is DashboardDto {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<DashboardDto>;
  return typeof data.generatedAt === 'string' && Array.isArray(data.devices) &&
    Array.isArray(data.sessions) && Array.isArray(data.accounts);
}

export function useDisplaySnapshot(apiOrigin: string | null, token: string | null) {
  const [snapshot, setSnapshot] = useState<DashboardDto | null>(null);
  const [syncHealthy, setSyncHealthy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<Promise<void> | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (!apiOrigin || !token || !mounted.current) return;
    if (active.current) return active.current;
    const requestGeneration = generation.current;
    const task = (async () => {
      try {
        const response = await fetch(`${apiOrigin}/api/display/dashboard`, {
          headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 401) throw new Error('TOKEN_INVALID');
        if (!response.ok) throw new Error('API_UNAVAILABLE');
        const body: unknown = await response.json();
        if (!isDashboard(body)) throw new Error('INVALID_SNAPSHOT');
        if (!mounted.current || requestGeneration !== generation.current) return;
        setSnapshot(body);
        setSyncHealthy(true);
        setError(null);
      } catch (cause) {
        if (!mounted.current || requestGeneration !== generation.current) return;
        setSyncHealthy(false);
        setError(cause instanceof Error ? cause.message : 'API_UNAVAILABLE');
      }
    })();
    active.current = task;
    try { await task; }
    finally { if (active.current === task) active.current = null; }
  }, [apiOrigin, token]);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    active.current = null;
    setSnapshot(null);
    setSyncHealthy(false);
    setError(null);
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, DASHBOARD_POLL_INTERVAL_MS);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [refresh]);

  return { snapshot, syncHealthy, error, refresh };
}
