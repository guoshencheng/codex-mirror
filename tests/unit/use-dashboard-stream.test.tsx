// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardDto } from '../../src/contracts/dashboard';
import { useDashboardStream } from '../../src/components/use-dashboard-stream';

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(type: string, data = '{}') {
    this.dispatchEvent(new MessageEvent(type, { data }));
  }

  open() { this.onopen?.(new Event('open')); }

  fail() {
    this.onerror?.(new Event('error'));
  }

  close() { this.closed = true; }
}

const initial: DashboardDto = {
  generatedAt: '2026-09-22T12:00:00.000Z',
  devices: [{
    id: 'device-1', name: 'Mac', heartbeatAt: '2026-09-22T11:59:10.000Z', connection: 'online', streamIncomplete: false,
  }],
  sessions: [],
  accounts: [],
};

function Harness({ navigate }: { navigate(path: string): void }) {
  const { data, connected, now, refreshQuota, logout } = useDashboardStream(initial, { navigate });
  return <main>
    <output aria-label="connected">{connected ? 'connected' : 'disconnected'}</output>
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

describe('useDashboardStream', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ csrfToken: 'csrf-one' })));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetches a full snapshot only on sync or invalidation and closes its stream on unmount', async () => {
    const fetchMock = vi.mocked(fetch);
    const navigate = vi.fn();
    const view = render(<Harness navigate={navigate} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', expect.anything()));
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/api/stream');
    expect(screen.getByLabelText('connected')).toHaveTextContent('disconnected');
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/dashboard')).toHaveLength(0);

    await act(async () => { source.open(); });
    expect(screen.getByLabelText('connected')).toHaveTextContent('connected');

    fetchMock.mockImplementation(async input => String(input) === '/api/dashboard'
      ? Response.json({ ...initial, generatedAt: '2026-09-22T12:01:00.000Z' })
      : Response.json({ csrfToken: 'csrf-one' }));
    await act(async () => { source.emit('sync'); });
    await waitFor(() => expect(screen.getByLabelText('generated at')).toHaveTextContent('12:01:00'));
    await act(async () => { source.emit('invalidate', '{"topic":"quota"}'); });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/dashboard')).toHaveLength(2));

    view.unmount();
    expect(source.closed).toBe(true);
  });

  it('uses the server sync after reconnect as the only snapshot trigger', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async input => String(input) === '/api/dashboard'
      ? Response.json(initial)
      : Response.json({ csrfToken: 'csrf-token-with-at-least-forty-characters-0123456789' }));
    const navigate = vi.fn();
    render(<Harness navigate={navigate} />);
    const source = FakeEventSource.instances[0]!;
    await act(async () => { source.open(); });
    await act(async () => { source.emit('sync'); });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/dashboard')).toHaveLength(1));

    await act(async () => { source.fail(); });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/session')).toHaveLength(2));
    await act(async () => { source.open(); });
    await act(async () => { source.emit('sync'); });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/dashboard')).toHaveLength(2));
    await act(async () => { await Promise.resolve(); });

    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/dashboard')).toHaveLength(2);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('marks overlapping stream changes dirty and reloads once the active snapshot finishes', async () => {
    const fetchMock = vi.mocked(fetch);
    const secondSnapshot = deferred<Response>();
    let dashboardCalls = 0;
    fetchMock.mockImplementation(async input => {
      if (String(input) === '/api/dashboard') {
        dashboardCalls += 1;
        if (dashboardCalls === 1) return secondSnapshot.promise;
        return Response.json({ ...initial, generatedAt: '2026-09-22T12:02:00.000Z' });
      }
      return Response.json({ csrfToken: 'csrf-token-with-at-least-forty-characters-0123456789' });
    });
    render(<Harness navigate={vi.fn()} />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => { FakeEventSource.instances[0]!.emit('sync'); });
    await waitFor(() => expect(dashboardCalls).toBe(1));
    await act(async () => { FakeEventSource.instances[0]!.emit('invalidate'); });
    secondSnapshot.resolve(Response.json({ ...initial, generatedAt: '2026-09-22T12:01:00.000Z' }));
    await waitFor(() => expect(dashboardCalls).toBe(2));
    await waitFor(() => expect(screen.getByLabelText('generated at')).toHaveTextContent('12:02:00'));
  });

  it('updates device freshness and elapsed clock locally without polling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T12:00:00.000Z'));
    const fetchMock = vi.mocked(fetch);
    const navigate = vi.fn();
    render(<Harness navigate={navigate} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByLabelText('device connection')).toHaveTextContent('online');

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByLabelText('device connection')).toHaveTextContent('stale');
    expect(screen.getByLabelText('clock')).toHaveTextContent('12:00:10');
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/dashboard')).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('refreshes CSRF state after a stream failure, sends it on quota refresh, and logs out', async () => {
    const fetchMock = vi.mocked(fetch);
    let sessionReads = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/api/auth/session') {
        sessionReads += 1;
        return Response.json({ csrfToken: sessionReads === 1
          ? 'csrf-token-one-with-at-least-forty-characters-0123456789'
          : 'csrf-token-two-with-at-least-forty-characters-0123456789' });
      }
      if (String(input) === '/api/provider-accounts/account-1/refresh') return Response.json({ status: 'queued' }, { status: 202 });
      if (String(input) === '/api/auth/logout') return new Response(null, { status: 204 });
      if (String(input) === '/api/dashboard') return Response.json(initial);
      throw new Error(`Unexpected request ${String(input)} ${init?.method}`);
    });
    const navigate = vi.fn();
    render(<Harness navigate={navigate} />);
    await waitFor(() => expect(sessionReads).toBe(1));
    await act(async () => {
      FakeEventSource.instances[0]!.fail();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(sessionReads).toBe(2));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByText('refresh quota'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/provider-accounts/account-1/refresh', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token-two-with-at-least-forty-characters-0123456789' }),
    })));
    fireEvent.click(screen.getByText('logout'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token-two-with-at-least-forty-characters-0123456789' }),
    })));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'));
    expect(screen.getByLabelText('generated at')).toHaveTextContent('1970-01-01');
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
      throw new Error(`Unexpected request ${String(input)}`);
    });
    const navigate = vi.fn();
    render(<Harness navigate={navigate} />);
    await waitFor(() => expect(sessionReads).toBe(1));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(screen.getByText('logout'));
    await waitFor(() => expect(logoutCalls).toBe(2));

    const logoutRequests = fetchMock.mock.calls.filter(([url]) => url === '/api/auth/logout');
    expect(logoutRequests.map(([, init]) => new Headers(init?.headers).get('x-csrf-token'))).toEqual([
      'csrf-token-old-with-at-least-forty-characters-0123456789',
      'csrf-token-new-with-at-least-forty-characters-0123456789',
    ]);
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('clears the dashboard and redirects when the session endpoint returns 401', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async input => {
      if (String(input) === '/api/auth/session') return new Response(null, { status: 401 });
      throw new Error(`Unexpected request ${String(input)}`);
    });
    const navigate = vi.fn();
    render(<Harness navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'));

    expect(screen.getByLabelText('generated at')).toHaveTextContent('1970-01-01');
    expect(screen.getByLabelText('device connection')).toHaveTextContent('none');
    expect(screen.getByLabelText('connected')).toHaveTextContent('disconnected');
  });
});
