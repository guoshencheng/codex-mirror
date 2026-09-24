// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeApiOrigin, useDisplaySnapshot } from '../../display/src/api';

const snapshot = { generatedAt: '2026-09-23T00:00:00.000Z', devices: [], sessions: [], accounts: [] };

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('standalone display client', () => {
  it('accepts HTTPS API origins and local development but rejects URL paths and insecure remote HTTP', () => {
    expect(normalizeApiOrigin('https://api.example/')).toBe('https://api.example');
    expect(normalizeApiOrigin('http://127.0.0.1:3100')).toBe('http://127.0.0.1:3100');
    expect(() => normalizeApiOrigin('http://api.example')).toThrow();
    expect(() => normalizeApiOrigin('https://api.example/path')).toThrow();
  });

  it('keeps the last good snapshot and marks sync unhealthy after a failed refresh', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return Response.json(snapshot);
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useDisplaySnapshot('https://api.example', `cdu_${'a'.repeat(43)}`));
    await waitFor(() => expect(result.current.syncHealthy).toBe(true));
    expect(result.current.snapshot).toEqual(snapshot);
    await act(async () => { await result.current.refresh(); });
    expect(result.current.syncHealthy).toBe(false);
    expect(result.current.snapshot).toEqual(snapshot);
    expect(fetcher).toHaveBeenCalledWith('https://api.example/api/display/dashboard', expect.objectContaining({
      headers: { Authorization: `Bearer cdu_${'a'.repeat(43)}` },
    }));
  });

  it('ignores an in-flight response from a previous API address', async () => {
    let completeOld!: (response: Response) => void;
    const fetcher = vi.fn((url: string) => url.startsWith('https://old.example')
      ? new Promise<Response>(resolve => { completeOld = resolve; })
      : Promise.resolve(Response.json({ ...snapshot, generatedAt: '2026-09-23T01:00:00.000Z' })));
    vi.stubGlobal('fetch', fetcher);
    const token = `cdu_${'a'.repeat(43)}`;
    const { result, rerender } = renderHook(({ origin }) => useDisplaySnapshot(origin, token), {
      initialProps: { origin: 'https://old.example' },
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    rerender({ origin: 'https://new.example' });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.snapshot?.generatedAt).toBe('2026-09-23T01:00:00.000Z'));
    await act(async () => { completeOld(Response.json(snapshot)); });
    expect(result.current.snapshot?.generatedAt).toBe('2026-09-23T01:00:00.000Z');
  });
});
