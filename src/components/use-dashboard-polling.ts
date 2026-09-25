'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardDto } from '../contracts/dashboard';
import { DASHBOARD_POLL_INTERVAL_MS } from './pixel-dashboard-model';

const EMPTY_DASHBOARD: DashboardDto = {
  generatedAt: new Date(0).toISOString(),
  devices: [],
  sessions: [],
  accounts: [],
};
const DASHBOARD_REQUEST_TIMEOUT_MS = 15_000;

export interface DashboardPollingOptions {
  navigate?(path: string): void;
  readOnly?: boolean;
}

export interface DashboardPollingValue {
  data: DashboardDto;
  syncHealthy: boolean;
  now: Date;
  refresh(): Promise<void>;
  refreshQuota(accountId: string): Promise<void>;
  logout(): Promise<void>;
}

function defaultNavigate(path: string): void {
  window.location.assign(path);
}

function deviceConnection(heartbeatAt: string | null, nowMilliseconds: number): DashboardDto['devices'][number]['connection'] {
  if (!heartbeatAt) return 'offline';
  const age = Math.max(0, nowMilliseconds - Date.parse(heartbeatAt)) / 1_000;
  if (!Number.isFinite(age) || age >= 120) return 'offline';
  return age >= 60 ? 'stale' : 'online';
}

export function useDashboardPolling(initial: DashboardDto, options: DashboardPollingOptions = {}): DashboardPollingValue {
  const navigate = options.navigate ?? defaultNavigate;
  const readOnly = options.readOnly ?? false;
  const [data, setData] = useState(initial);
  const [syncHealthy, setSyncHealthy] = useState(readOnly);
  const [now, setNow] = useState(() => new Date(initial.generatedAt));
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const alive = useRef(false);
  const redirected = useRef(false);
  const csrfRef = useRef<string | null>(null);
  const activeLoad = useRef<Promise<void> | null>(null);
  const refreshPending = useRef(false);

  const redirectToLogin = useCallback(() => {
    if (redirected.current) return;
    redirected.current = true;
    csrfRef.current = null;
    setCsrfToken(null);
    setData(EMPTY_DASHBOARD);
    setSyncHealthy(false);
    navigate('/login');
  }, [navigate]);

  const renewCsrf = useCallback(async (): Promise<string | null> => {
    try {
      const response = await fetch('/api/auth/session', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (response.status === 401) {
        redirectToLogin();
        return null;
      }
      if (!response.ok) return null;
      const body = await response.json() as { csrfToken?: unknown };
      if (typeof body.csrfToken !== 'string' || body.csrfToken.length < 40 || !alive.current) return null;
      csrfRef.current = body.csrfToken;
      setCsrfToken(body.csrfToken);
      return body.csrfToken;
    } catch {
      return null;
    }
  }, [redirectToLogin]);

  const refresh = useCallback(async (): Promise<void> => {
    if (readOnly || !alive.current || redirected.current) return;
    if (activeLoad.current) {
      refreshPending.current = true;
      await activeLoad.current;
      return;
    }

    const task = (async () => {
      do {
        refreshPending.current = false;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DASHBOARD_REQUEST_TIMEOUT_MS);
        try {
          const response = await fetch('/api/dashboard', {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          });
          if (response.status === 401) {
            redirectToLogin();
            return;
          }
          if (!response.ok) {
            if (alive.current && !redirected.current) setSyncHealthy(false);
            continue;
          }
          const snapshot = await response.json() as DashboardDto;
          if (!alive.current || redirected.current) return;
          setData(snapshot);
          setSyncHealthy(true);
        } catch {
          // Keep the last known snapshot while the server or network is unavailable.
          if (alive.current && !redirected.current) setSyncHealthy(false);
        } finally {
          clearTimeout(timeout);
        }
      } while (refreshPending.current && alive.current && !redirected.current && document.visibilityState !== 'hidden');
    })();
    activeLoad.current = task;
    try { await task; }
    finally {
      if (activeLoad.current === task) activeLoad.current = null;
    }
  }, [readOnly, redirectToLogin]);

  const refreshQuota = useCallback(async (accountId: string): Promise<void> => {
    if (readOnly || !alive.current || redirected.current) return;
    const token = csrfRef.current ?? await renewCsrf();
    if (!token || redirected.current) return;
    let response: Response;
    try {
      response = await fetch(`/api/provider-accounts/${encodeURIComponent(accountId)}/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: '{}',
      });
    } catch {
      return;
    }
    if (response.status === 401) {
      redirectToLogin();
      return;
    }
    if (response.status === 403) {
      const refreshed = await renewCsrf();
      if (!refreshed || redirected.current) return;
      try {
        response = await fetch(`/api/provider-accounts/${encodeURIComponent(accountId)}/refresh`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': refreshed },
          body: '{}',
        });
      } catch {
        return;
      }
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
    }
    await refresh();
  }, [readOnly, redirectToLogin, refresh, renewCsrf]);

  const logout = useCallback(async (): Promise<void> => {
    if (readOnly || !alive.current || redirected.current) return;
    const sendLogout = (token: string) => fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: '{}',
      });
    const token = csrfRef.current ?? await renewCsrf();
    if (!token || redirected.current) return;
    try {
      let response = await sendLogout(token);
      if (response.status === 403) {
        const refreshedToken = await renewCsrf();
        if (!refreshedToken || redirected.current) return;
        response = await sendLogout(refreshedToken);
      }
      if (response.status === 401 || response.status === 204 || response.ok) redirectToLogin();
    } catch {
      // Retain the authenticated UI when logout could not reach the server.
    }
  }, [readOnly, redirectToLogin, renewCsrf]);

  useEffect(() => {
    alive.current = true;
    redirected.current = false;
    let dashboardTimer: ReturnType<typeof setInterval> | undefined;
    let freshnessTimer: ReturnType<typeof setInterval> | undefined;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    if (!readOnly) {
      void renewCsrf();
      if (document.visibilityState !== 'hidden') void refresh();
      dashboardTimer = setInterval(() => {
        if (document.visibilityState !== 'hidden') void refresh();
      }, DASHBOARD_POLL_INTERVAL_MS);
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    const clockTimer = setInterval(() => setNow(new Date()), 1_000);
    if (!readOnly) freshnessTimer = setInterval(() => {
      const at = Date.now();
      setData(previous => ({
        ...previous,
        devices: previous.devices.map(device => ({ ...device, connection: deviceConnection(device.heartbeatAt, at) })),
      }));
    }, 10_000);

    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (dashboardTimer) clearInterval(dashboardTimer);
      clearInterval(clockTimer);
      if (freshnessTimer) clearInterval(freshnessTimer);
    };
  }, [readOnly, refresh, renewCsrf]);

  // Keep the ref in sync for callbacks that may run before React commits state.
  useEffect(() => { csrfRef.current = csrfToken; }, [csrfToken]);

  return { data, syncHealthy, now, refresh, refreshQuota, logout };
}
