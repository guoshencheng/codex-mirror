import { describe, expect, it, vi } from 'vitest';
import { heartbeatPayload, runCollectorLoop } from '../../collector/src/heartbeat';
import type { CollectorQueue } from '../../collector/src/queue';

function fakeQueue(): CollectorQueue {
  const queued = {
    schemaVersion: 1 as const, eventId: 'event-a', deviceId: 'device-a', collectorEpoch: 'epoch-a', sequence: 1,
    sessionId: 'session-a', turnId: 'turn-a', type: 'turn.started' as const,
    occurredAt: '2026-09-22T00:00:00Z', metadata: {},
  };
  let pending = [queued];
  return {
    append: vi.fn(),
    peek: vi.fn(() => pending), ack: vi.fn(() => { pending = []; }), close: vi.fn(),
    health: () => ({ queueDepth: 3, pendingBytes: 90, databaseBytes: 4_000, eventLoss: true, errorCode: 'QUEUE_FULL', epoch: 'epoch-a', lastSequence: 17, firstPendingSequence: 15 }),
    getProjectCache: vi.fn().mockReturnValue(null), putProjectCache: vi.fn(),
    appendHook: vi.fn().mockReturnValue(null), titleCandidates: vi.fn().mockReturnValue([]), recordTitleCheck: vi.fn().mockReturnValue(null),
  };
}

describe('collector heartbeat and event-only loop', () => {
  it('builds health heartbeat fields without inspecting any Codex process state', () => {
    expect(heartbeatPayload(fakeQueue(), 'boot-a')).toEqual({
      epoch: 'epoch-a', bootId: 'boot-a', queuedThrough: 17, firstPendingSequence: 15, queueDepth: 3, eventLoss: true,
    });
  });

  it('registers startup recovery heartbeat before uploading the durable queue', async () => {
    const queue = fakeQueue();
    const order: string[] = [];
    const controller = new AbortController();
    await runCollectorLoop({
      queue,
      bootId: 'boot-a',
      heartbeat: async payload => { expect(payload.queuedThrough).toBe(17); order.push('heartbeat'); },
      refreshMetadata: async () => { order.push('metadata'); },
      upload: async batch => {
        order.push('upload');
        return { epoch: batch.epoch, acknowledgedThrough: batch.events[0]!.sequence };
      },
      signal: controller.signal,
      sleep: async () => { controller.abort(); },
    });
    expect(order).toEqual(['metadata', 'heartbeat', 'upload']);
  });

  it('uploads lifecycle events even when local metadata lookup fails', async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const errors: string[] = [];
    await runCollectorLoop({
      queue: fakeQueue(), bootId: 'boot-a', heartbeat: async () => {},
      refreshMetadata: async () => { throw new Error('TITLE_READ_TIMEOUT'); },
      upload: async batch => { order.push('upload'); return { epoch: batch.epoch, acknowledgedThrough: batch.events[0]!.sequence }; },
      signal: controller.signal, sleep: async () => { controller.abort(); }, onError: code => errors.push(code),
    });
    expect(order).toEqual(['upload']);
    expect(errors).toContain('TITLE_READ_TIMEOUT');
  });

  it('does not upload backlog if startup heartbeat fails', async () => {
    const controller = new AbortController();
    const upload = vi.fn();
    await runCollectorLoop({
      queue: fakeQueue(), bootId: 'boot-a', heartbeat: async () => { throw new Error('offline'); },
      upload, signal: controller.signal,
      sleep: async () => { controller.abort(); },
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it('checks local thread titles even when the heartbeat request fails', async () => {
    const controller = new AbortController();
    const refreshMetadata = vi.fn(async () => {});
    await runCollectorLoop({
      queue: fakeQueue(), bootId: 'boot-a',
      heartbeat: async () => { throw new Error('offline'); },
      upload: vi.fn(), refreshMetadata, signal: controller.signal,
      sleep: async () => { controller.abort(); },
    });
    expect(refreshMetadata).toHaveBeenCalledOnce();
  });
});
