import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openQueue } from '../../collector/src/queue';
import { uploadOnce, UploadResponseError } from '../../collector/src/uploader';

const directories: string[] = [];
async function makeQueue() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-upload-'));
  directories.push(directory);
  return openQueue(join(directory, 'queue.sqlite'), 1_000_000, 'device-a');
}
const event = (sessionId: string) => ({
  schemaVersion: 1 as const, sessionId, turnId: 'turn-a', type: 'turn.started' as const,
  occurredAt: '2026-09-22T00:00:00Z', metadata: {},
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('collector event uploader', () => {
  it('keeps the exact event in the durable queue after a network failure', async () => {
    const queue = await makeQueue();
    const saved = queue.append(event('s1'));
    const transport = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(uploadOnce(queue, transport)).rejects.toThrow('offline');
    expect(queue.peek(10)).toEqual([saved]);
    await expect(uploadOnce(queue, vi.fn().mockResolvedValue({ epoch: saved.collectorEpoch, acknowledgedThrough: saved.sequence })))
      .resolves.toBeUndefined();
    expect(queue.peek(10)).toEqual([]);
    queue.close();
  });

  it('shrinks rejected 413 batches and only removes a server-acknowledged prefix', async () => {
    const queue = await makeQueue();
    const events = Array.from({ length: 4 }, (_, index) => queue.append(event(`s${index}`)));
    const sizes: number[] = [];
    const transport = vi.fn(async (batch: { epoch: string; events: readonly typeof events[number][] }) => {
      sizes.push(batch.events.length);
      if (sizes.length === 1) throw new UploadResponseError(413);
      return { epoch: batch.epoch, acknowledgedThrough: batch.events[0]!.sequence };
    });
    await uploadOnce(queue, transport);
    expect(sizes[0]).toBe(4);
    expect(sizes.slice(1)).toEqual([2, 2, 2, 1]);
    expect(queue.peek(10)).toEqual([]);
    queue.close();
  });

  it('rejects foreign epochs and acknowledgments beyond the sent range without dropping data', async () => {
    const queue = await makeQueue();
    const saved = queue.append(event('s1'));
    await expect(uploadOnce(queue, async () => ({ epoch: 'foreign', acknowledgedThrough: saved.sequence })))
      .rejects.toThrow('ACK_EPOCH_MISMATCH');
    await expect(uploadOnce(queue, async () => ({ epoch: saved.collectorEpoch, acknowledgedThrough: saved.sequence + 1 })))
      .rejects.toThrow('ACK_OUT_OF_RANGE');
    expect(queue.peek(10)).toEqual([saved]);
    queue.close();
  });

  it('does not skip an event rejected as a single oversized request', async () => {
    const queue = await makeQueue();
    const saved = queue.append(event('s1'));
    await expect(uploadOnce(queue, async () => { throw new UploadResponseError(413); }))
      .rejects.toThrow('SINGLE_EVENT_REJECTED');
    expect(queue.peek(10)).toEqual([saved]);
    queue.close();
  });
});
