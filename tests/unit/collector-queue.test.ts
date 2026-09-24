import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openQueue } from '../../collector/src/queue';

const directories: string[] = [];
async function queuePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-collector-'));
  directories.push(directory);
  return join(directory, 'queue.sqlite');
}

const input = {
  schemaVersion: 1 as const, sessionId: 'session-a', turnId: 'turn-a', type: 'turn.started' as const,
  occurredAt: '2026-09-22T00:00:00Z', metadata: { title: 'safe title' },
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('durable local event queue', () => {
  it('reports the first pending sequence after acknowledgments for server migration', async () => {
    const queue = openQueue(await queuePath(), 1_000_000, 'device-a');
    const first = queue.append(input);
    const second = queue.append({ ...input, type: 'turn.stopped' });
    const third = queue.append({ ...input, type: 'turn.started' });
    queue.ack(first.collectorEpoch, second.sequence);
    expect(queue.health()).toMatchObject({ lastSequence: third.sequence, firstPendingSequence: third.sequence, queueDepth: 1 });
    queue.ack(first.collectorEpoch, third.sequence);
    expect(queue.health()).toMatchObject({ lastSequence: third.sequence, firstPendingSequence: third.sequence + 1, queueDepth: 0 });
    queue.close();
  });
  it('only emits a tool completion after an approval request, including across restart', async () => {
    const path = await queuePath();
    let queue = openQueue(path, 1_000_000, 'device-a');
    expect(queue.appendHook({ ...input, type: 'tool.finished', metadata: {} })).toBeNull();
    queue.appendHook({ ...input, type: 'approval.requested', metadata: {} });
    queue.close();

    queue = openQueue(path, 1_000_000, 'device-a');
    const resumed = queue.appendHook({ ...input, type: 'tool.finished', metadata: {} });
    expect(resumed).toMatchObject({ type: 'turn.resumed', metadata: {} });
    expect(queue.appendHook({ ...input, type: 'tool.finished', metadata: {} })).toBeNull();
    expect(queue.peek(10).map(event => event.type)).toEqual(['approval.requested', 'turn.resumed']);
    queue.close();
  });

  it('does not resume an old approval after a new turn starts', async () => {
    const queue = openQueue(await queuePath(), 1_000_000, 'device-a');
    queue.appendHook({ ...input, type: 'approval.requested', metadata: {} });
    queue.appendHook({ ...input, type: 'turn.started', turnId: 'turn-b', metadata: {} });
    expect(queue.appendHook({ ...input, type: 'tool.finished', metadata: {} })).toBeNull();
    expect(queue.peek(10).map(event => event.type)).toEqual(['approval.requested', 'turn.started']);
    queue.close();
  });

  it('does not infer an approval resolution without a matching turn ID', async () => {
    const queue = openQueue(await queuePath(), 1_000_000, 'device-a');
    queue.appendHook({ ...input, type: 'approval.requested', turnId: null, metadata: {} });
    expect(queue.appendHook({ ...input, type: 'tool.finished', metadata: {} })).toBeNull();
    expect(queue.peek(10).map(event => event.type)).toEqual(['approval.requested']);
    queue.close();
  });

  it('retries missing titles and emits only changed titles as metadata events', async () => {
    const queue = openQueue(await queuePath(), 1_000_000, 'device-a');
    queue.appendHook({ ...input, metadata: {} });
    expect(queue.titleCandidates('2026-09-22T00:00:01Z', 10)).toEqual(['session-a']);
    expect(queue.recordTitleCheck('session-a', null, '2026-09-22T00:00:01Z')).toBeNull();
    expect(queue.titleCandidates('2026-09-22T00:00:02Z', 10)).toEqual([]);
    expect(queue.titleCandidates('2026-09-22T00:00:22Z', 10)).toEqual(['session-a']);
    const titleEvent = queue.recordTitleCheck('session-a', 'Actual task', '2026-09-22T00:00:22Z');
    expect(titleEvent).toMatchObject({ type: 'session.metadata.updated', metadata: { title: 'Actual task' } });
    expect(queue.recordTitleCheck('session-a', 'Actual task', '2026-09-22T00:05:23Z')).toBeNull();
    expect(queue.recordTitleCheck('session-a', 'Renamed task', '2026-09-22T00:10:24Z'))
      .toMatchObject({ type: 'session.metadata.updated', metadata: { title: 'Renamed task' } });
    expect(queue.peek(10).map(event => event.type)).toEqual([
      'turn.started', 'session.metadata.updated', 'session.metadata.updated',
    ]);
    queue.close();
  });

  it('keeps event ids, sequence, and epoch stable across restart until contiguous ack', async () => {
    const path = await queuePath();
    let queue = openQueue(path, 1_000_000, 'device-a');
    const first = queue.append(input);
    const second = queue.append({ ...input, type: 'turn.stopped' });
    expect(second.sequence).toBe(first.sequence + 1);
    queue.close();

    queue = openQueue(path, 1_000_000, 'device-a');
    expect(queue.peek(20)).toEqual([first, second]);
    expect(() => queue.ack(first.collectorEpoch, second.sequence + 1)).toThrow('ACK_OUT_OF_RANGE');
    expect(() => queue.ack('wrong-epoch', first.sequence)).toThrow('EPOCH_MISMATCH');
    queue.ack(first.collectorEpoch, first.sequence);
    expect(queue.peek(20)).toEqual([second]);
    queue.ack(first.collectorEpoch, second.sequence);
    expect(queue.peek(20)).toEqual([]);
    queue.close();
  });

  it('rejects a queue identity change and preserves the original device binding', async () => {
    const path = await queuePath();
    const queue = openQueue(path, 100_000, 'device-a');
    queue.close();
    expect(() => openQueue(path, 100_000, 'device-b')).toThrow('DEVICE_ID_MISMATCH');
  });

  it('marks event loss and refuses new writes when the byte budget is exhausted', async () => {
    const path = await queuePath();
    const queue = openQueue(path, 1, 'device-a');
    expect(() => queue.append(input)).toThrow('QUEUE_FULL');
    expect(queue.health()).toMatchObject({ eventLoss: true });
    expect(queue.peek(1)).toEqual([]);
    queue.close();
  });

  it('serializes concurrent appends without reusing sequence or event ids', async () => {
    const path = await queuePath();
    const queue = openQueue(path, 1_000_000, 'device-a');
    const events = Array.from({ length: 30 }, (_, index) => queue.append({
      ...input, sessionId: `session-${index}`,
    }));
    expect(events.map(event => event.sequence)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(new Set(events.map(event => event.eventId)).size).toBe(30);
    queue.close();
  });
});
