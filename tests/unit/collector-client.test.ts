import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/contracts/events';
import { createCollectorClient } from '../../collector/src/client';
import type { CollectorConfig } from '../../collector/src/config';

const config: CollectorConfig = {
  schemaVersion: 1,
  deviceId: 'device-a',
  deviceToken: 'a'.repeat(64),
  serverUrl: 'https://dashboard.example.test',
  queuePath: '/tmp/queue.sqlite',
};
const event: AgentEvent = {
  schemaVersion: 1, eventId: 'event-1', deviceId: 'device-a', collectorEpoch: 'epoch-a', sequence: 1,
  sessionId: 'session-a', turnId: 'turn-a', type: 'turn.started', occurredAt: '2026-09-22T00:00:00Z', metadata: {},
};

describe('collector HTTP client', () => {
  it('sends ordered event batches with the device bearer token and validates the acknowledgment', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ epoch: 'epoch-a', acknowledgedThrough: 1 }));
    const client = createCollectorClient(config, fetcher);
    await expect(client.upload({ epoch: 'epoch-a', events: [event] })).resolves.toEqual({ epoch: 'epoch-a', acknowledgedThrough: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://dashboard.example.test/api/agent/events');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: {
      authorization: `Bearer ${config.deviceToken}`, 'content-type': 'application/json',
    } });
    expect(JSON.parse(String(init.body))).toEqual({ epoch: 'epoch-a', events: [event] });
  });

  it('sends only collector heartbeat metadata without process or prompt data', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const client = createCollectorClient(config, fetcher);
    await client.heartbeat({ epoch: 'epoch-a', bootId: 'boot-a', queuedThrough: 1, queueDepth: 1, eventLoss: false });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://dashboard.example.test/api/agent/heartbeat');
    expect(JSON.parse(String(init.body))).toEqual({ epoch: 'epoch-a', bootId: 'boot-a', queuedThrough: 1, queueDepth: 1, eventLoss: false });
  });

  it('does not treat malformed responses as durable acknowledgments', async () => {
    const client = createCollectorClient(config, vi.fn().mockResolvedValue(Response.json({ epoch: 'other', acknowledgedThrough: 4 })));
    await expect(client.upload({ epoch: 'epoch-a', events: [event] })).rejects.toThrow('INVALID_UPLOAD_RESPONSE');
  });

  it('surfaces bounded HTTP status errors for retry and authentication pause behavior', async () => {
    const client = createCollectorClient(config, vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    await expect(client.upload({ epoch: 'epoch-a', events: [event] })).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an oversized server response without treating it as an acknowledgment', async () => {
    const client = createCollectorClient(config, vi.fn().mockResolvedValue(new Response('x'.repeat(16_385))));
    await expect(client.upload({ epoch: 'epoch-a', events: [event] })).rejects.toThrow('INVALID_UPLOAD_RESPONSE');
  });
});
