// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardDto } from '../../src/contracts/dashboard';
import { useDashboardPolling } from '../../src/components/use-dashboard-polling';

const initial: DashboardDto = {
  generatedAt: '2026-09-22T12:00:00.000Z',
  devices: [{
    id: 'device-1', name: 'Mac', heartbeatAt: '2026-09-22T11:59:10.000Z', connection: 'online', streamIncomplete: false,
  }],
  sessions: [],
  accounts: [],
};

function Harness({ navigate }: { navigate(path: string): void }) {
  const { data, syncHealthy, now, refreshQuota, logout } = useDashboardPolling(initial, { navigate });
  return <main>
    <output aria-label="sync state">{syncHealthy ? 'connected' : 'disconnected'}</output>
    <output aria-label="device connection">{data.devices[0]?.connection ?? 'none'}</output>
    <output aria-label="generated at">{data.generatedAt}</output>
    <output aria-label="clock">{now.toISOString()}</output>
    <button onClick={() => void refreshQuota('account-1')}>refresh quota</button>
    <button onClick={() => void logout()}>logout</button>
  </main>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let originalVisibilityDescriptor: PropertyDescriptor | undefined;

describe('useDashboardPolling', () => {
  beforeEach(() => {
    originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    vi.stubGlobal('fetch', vi.fn(async input => String(input) === '/api/dashboard'
      ? Response.json(initial)
      : Response.json({ csrfToken: 'csrf-token-with-at-least-forty-characters-0123456789' })));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalVisibilityDescriptor) Object.defineProperty(document, 'visibilityState', originalVisibilityDescriptor);
    else Reflect.deleteProperty(document, 'visibilityState');
  });

  it('polls immediately and every 10 seconds while visible, then refreshes when shown again', async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    const fetchMock = vi.mocked(fetch);
    let dashboardReads = 0;
    fetchMock.mockImplementation(async input => {
      if (String(input) === '/api/dashboard') {
        dashboardReads += 1;
        return Response.json({ ...initial, generatedAt: `2026-09-22T12:00:${String(dashboardReads).padStart(2, '0')}.000Z` });
      }
      return Response.json({ csrfToken: 'csrf-token-with-at-least-forty-characters-0123456789' });
    });
    const view = render(<Harness navigate={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(dashboardReads).toBe(1);
    expect(screen.getByLabelText('generated at')).toHaveTextContent('12:00:01');
    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard', expect.objectContaining({ cache: 'no-store' }));

    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(dashboardReads).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(dashboardReads).toBe(2);

    visibility = 'hidden';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(dashboardReads).toBe(2);

    visibility = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(dashboardReads).toBe(3);
    expect(screen.getByLabelText('generated at')).toHaveTextContent('12:00:03');

    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(dashboardReads).toBe(3);
  });

  it('keeps the last snapshot after a failed poll and recovers on the next successful poll', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    let dashboardReads = 0;
    fetchMock.mockImplementation(async input => {
      if (String(input) === '/api/dashboard') {
        dashboardReads += 1;
        if (dashboardReads === 2) return Response.json({ error: 'unavailable' }, { status: 503 });
        return Response.json({ ...initial, generatedAt: `2026-09-22T12:00:0${dashboardReads}.000Z` });
      }
      return Response.json({ csrfToken: 'csrf-token-with-at-least-forty-characters-0123456789' });
    });
    render(<Harness navigate={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByLabelText('sync state')).toHaveTextContent('connected');
    expect(screen.getByLabelText('generated at')).toHaveTextContent('12:00:01');

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByLabelText('sync state')).toHaveTextContent('disconnected');
    expect(screen.getByLabelText('generated at')).toHaveTextContent('12:00:01');

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByLabelText('sync state')).toHaveTextContent('connected');
    expect(screen.getByLabelText('generated at')).toHaveTextContent('12:00:03');
  });

  it('serializes overlapping polls and performs one queued read afterward', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    const pendingSnapshot = deferred<Response>();
    let dashboardReads = 0;
    fetchMock.mockImplementation(async input => {
      if (String(input) === '/api/dashboard') {
        dashboardReads += 1;
        return dashboardReads === 1 ? pendingSnapshot.promise : Response.json({ ...initial, generatedAt: '2026-09-22T12:02:00.000Z' });
      }
      return Response.json({ csrfToken: 'csrf-token-with-at-least-forty-characters-0123456789' });
    });
    render(<Harness navigate={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(dashboardReads).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(dashboardReads).toBe(1);
    pendingSnapshot.resolve(Response.json({ ...initial, generatedAt: '2026-09-22T12:01:00.000Z' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(dashboardReads).toBe(2);
    expect(screen.getByLabelText('generated at')).toHaveTextContent('12:02:00');

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(dashboardReads).toBe(3);
  });

  it('queues one fresh read when the page becomes visible during an in-flight request', async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    const fetchMock = vi.mocked(fetch);
    const pendingSnapshot = deferred<Response>();
    let dashboardReads = 0;
    fetchMock.mockImplementation(async input => {
      if (String(input) === '/api/dashboard') {
        dashboardReads += 1;
        return dashboardReads === 1 ? pendingSnapshot.promise : Response.json({ ...initial, generatedAt: '2026-09-22T12:02:00.000Z' });
      }
      return Response.json({ csrfToken: 'csrf-token-with-at-least-forty-characters-0123456789' });
    });
    render(<Harness navigate={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(dashboardReads).toBe(1);

    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(dashboardReads).toBe(1);

    pendingSnapshot.resolve(Response.json({ ...initial, generatedAt: '2026-09-22T12:01:00.000Z' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(dashboardReads).toBe(2);
    expect(screen.getByLabelText('generated at')).toHaveTextContent('12:02:00');
  });

  it('does not run a queued read after the page becomes hidden and refreshes when shown again', async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    const fetchMock = vi.mocked(fetch);
    const pendingSnapshot = deferred<Response>();
    let dashboardReads = 0;
    fetchMock.mockImplementation(async input => {
      if (String(input) === '/api/dashboard') {
        dashboardReads += 1;
        return dashboardReads === 1 ? pendingSnapshot.promise : Response.json({ ...initial, generatedAt: '2026-09-22T12:04:00.000Z' });
      }
      return Response.json({ csrfToken: 'csrf-token-with-at-least-forty-characters-0123456789' });
    });
    render(<Harness navigate={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(dashboardReads).toBe(1);

    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    pendingSnapshot.resolve(Response.json({ ...initial, generatedAt: '2026-09-22T12:03:00.000Z' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(dashboardReads).toBe(1);

    visibility = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dashboardReads).toBe(2);
    expect(screen.getByLabelText('generated at')).toHaveTextContent('12:04:00');
  });

  it('aborts a stalled dashboard request after 15 seconds and runs the queued poll', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    const navigate = vi.fn();
    let dashboardReads = 0;
    let firstSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) !== '/api/dashboard') return Response.json({ csrfToken: 'csrf-token-with-at-least-forty-characters-0123456789' });
      dashboardReads += 1;
      if (dashboardReads > 1) return Response.json({ ...initial, generatedAt: '2026-09-22T12:03:00.000Z' });
      firstSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        firstSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    render(<Harness navigate={navigate} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(dashboardReads).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
    expect(firstSignal?.aborted).toBe(false);
    expect(dashboardReads).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(firstSignal?.aborted).toBe(true);
    expect(dashboardReads).toBe(2);
    expect(screen.getByLabelText('generated at')).toHaveTextContent('12:03:00');
    expect(screen.getByLabelText('sync state')).toHaveTextContent('connected');
  });

  it('updates device freshness and elapsed clock locally between dashboard polls', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T12:00:00.000Z'));
    const fetchMock = vi.mocked(fetch);
    const navigate = vi.fn();
    render(<Harness navigate={navigate} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByLabelText('device connection')).toHaveTextContent('online');
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/dashboard')).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByLabelText('device connection')).toHaveTextContent('stale');
    expect(screen.getByLabelText('clock')).toHaveTextContent('12:00:10');
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/dashboard')).toHaveLength(2);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sends the current CSRF token when manually requesting a quota refresh', async () => {
    const fetchMock = vi.mocked(fetch);
    let dashboardReads = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/api/auth/session') return Response.json({ csrfToken: 'csrf-token-with-at-least-forty-characters-0123456789' });
      if (String(input) === '/api/provider-accounts/account-1/refresh') return Response.json({ status: 'queued' }, { status: 202 });
      if (String(input) === '/api/dashboard') {
        dashboardReads += 1;
        return Response.json({ ...initial, generatedAt: `2026-09-22T12:00:0${dashboardReads}.000Z` });
      }
      if (String(input) === '/api/auth/logout') return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${String(input)} ${init?.method}`);
    });
    const navigate = vi.fn();
    render(<Harness navigate={navigate} />);
    await waitFor(() => expect(dashboardReads).toBe(1));
    fireEvent.click(screen.getByText('refresh quota'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/provider-accounts/account-1/refresh', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token-with-at-least-forty-characters-0123456789' }),
    })));
    await waitFor(() => expect(dashboardReads).toBe(2));
    expect(screen.getByLabelText('generated at')).toHaveTextContent('12:00:02');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('renews CSRF and retries logout once after a forbidden response', async () => {
    const fetchMock = vi.mocked(fetch);
    let sessionReads = 0;
    let logoutCalls = 0;
    fetchMock.mockImplementation(async input => {
      if (String(input) === '/api/auth/session') {
        sessionReads += 1;
        return Response.json({ csrfToken: sessionReads === 1
          ? 'csrf-token-old-with-at-least-forty-characters-0123456789'
          : 'csrf-token-new-with-at-least-forty-characters-0123456789' });
      }
      if (String(input) === '/api/auth/logout') {
        logoutCalls += 1;
        return new Response(null, { status: logoutCalls === 1 ? 403 : 204 });
      }
      if (String(input) === '/api/dashboard') return Response.json(initial);
      throw new Error(`Unexpected request ${String(input)}`);
    });
    const navigate = vi.fn();
    render(<Harness navigate={navigate} />);
    await waitFor(() => expect(sessionReads).toBe(1));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/dashboard')).toBe(true));
    fireEvent.click(screen.getByText('logout'));
    await waitFor(() => expect(logoutCalls).toBe(2));

    const logoutRequests = fetchMock.mock.calls.filter(([url]) => url === '/api/auth/logout');
    expect(logoutRequests.map(([, init]) => new Headers(init?.headers).get('x-csrf-token'))).toEqual([
      'csrf-token-old-with-at-least-forty-characters-0123456789',
      'csrf-token-new-with-at-least-forty-characters-0123456789',
    ]);
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('clears the dashboard and redirects when the dashboard poll returns 401', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async input => {
      if (String(input) === '/api/auth/session') return Response.json({ csrfToken: 'csrf-token-with-at-least-forty-characters-0123456789' });
      if (String(input) === '/api/dashboard') return new Response(null, { status: 401 });
      throw new Error(`Unexpected request ${String(input)}`);
    });
    const navigate = vi.fn();
    render(<Harness navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'));

    expect(screen.getByLabelText('generated at')).toHaveTextContent('1970-01-01');
    expect(screen.getByLabelText('device connection')).toHaveTextContent('none');
    expect(screen.getByLabelText('sync state')).toHaveTextContent('disconnected');
  });
});

function ReadOnlyHarness({ navigate }: { navigate(path: string): void }) {
  const { data, syncHealthy, refresh, refreshQuota, logout } = useDashboardPolling(initial, { navigate, readOnly: true });
  return <main>
    <output aria-label="read-only sync">{syncHealthy ? 'connected' : 'disconnected'}</output>
    <output aria-label="read-only snapshot">{data.generatedAt}</output>
    <button onClick={() => void refresh()}>refresh dashboard</button>
    <button onClick={() => void refreshQuota('account-1')}>refresh quota</button>
    <button onClick={() => void logout()}>logout</button>
  </main>;
}

describe('read-only dashboard preview', () => {
  it('renders its snapshot without contacting auth, dashboard, quota, or logout endpoints', async () => {
    const navigate = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<ReadOnlyHarness navigate={navigate} />);
    expect(screen.getByLabelText('read-only sync')).toHaveTextContent('connected');
    expect(screen.getByLabelText('read-only snapshot')).toHaveTextContent(initial.generatedAt);
    fireEvent.click(screen.getByRole('button', { name: 'refresh dashboard' }));
    fireEvent.click(screen.getByRole('button', { name: 'refresh quota' }));
    fireEvent.click(screen.getByRole('button', { name: 'logout' }));
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
