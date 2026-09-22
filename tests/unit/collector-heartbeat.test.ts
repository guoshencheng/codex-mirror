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
    append: vi.fn(), peek: vi.fn(() => pending), ack: vi.fn(() => { pending = []; }), close: vi.fn(),
    health: () => ({ queueDepth: 3, pendingBytes: 90, databaseBytes: 4_000, eventLoss: true, errorCode: 'QUEUE_FULL', epoch: 'epoch-a', lastSequence: 17 }),
    getProjectCache: vi.fn().mockReturnValue(null), putProjectCache: vi.fn(),
  };
}

describe('collector heartbeat and event-only loop', () => {
  it('builds health heartbeat fields without inspecting any Codex process state', () => {
    expect(heartbeatPayload(fakeQueue(), 'boot-a')).toEqual({
      epoch: 'epoch-a', bootId: 'boot-a', queuedThrough: 17, queueDepth: 3, eventLoss: true,
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
      upload: async batch => {
        order.push('upload');
        return { epoch: batch.epoch, acknowledgedThrough: batch.events[0]!.sequence };
      },
      signal: controller.signal,
      sleep: async () => { controller.abort(); },
    });
    expect(order).toEqual(['heartbeat', 'upload']);
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
});
