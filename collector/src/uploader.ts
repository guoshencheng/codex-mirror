import type { AgentEvent } from '../../src/contracts/events';
import type { CollectorQueue } from './queue';

export interface UploadBatch {
  epoch: string;
  events: readonly AgentEvent[];
}

export interface UploadAcknowledgment {
  epoch: string;
  acknowledgedThrough: number;
}

export type UploadTransport = (batch: UploadBatch) => Promise<UploadAcknowledgment>;

const maxBatchEvents = 100;
const maxBatchBytes = 256_000;

export class UploadResponseError extends Error {
  constructor(readonly status: number) { super(`UPLOAD_HTTP_${status}`); }
}

function boundedBatch(events: AgentEvent[]): AgentEvent[] {
  const batch: AgentEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const eventBytes = new TextEncoder().encode(JSON.stringify(event)).length;
    if (batch.length > 0 && bytes + eventBytes > maxBatchBytes) break;
    if (eventBytes > maxBatchBytes) throw new Error('EVENT_EXCEEDS_BATCH_LIMIT');
    batch.push(event);
    bytes += eventBytes;
  }
  return batch;
}

function is413(error: unknown): boolean {
  return error instanceof UploadResponseError ? error.status === 413
    : Boolean(error && typeof error === 'object' && 'status' in error && error.status === 413);
}

export async function uploadOnce(queue: Pick<CollectorQueue, 'peek' | 'ack'>, transport: UploadTransport): Promise<void> {
  let countLimit = maxBatchEvents;
  while (true) {
    const batch = boundedBatch(queue.peek(countLimit));
    if (batch.length === 0) return;
    const epoch = batch[0]!.collectorEpoch;
    if (batch.some(event => event.collectorEpoch !== epoch)) throw new Error('MIXED_EPOCH_BATCH');
    let acknowledgment: UploadAcknowledgment;
    try { acknowledgment = await transport({ epoch, events: batch }); }
    catch (error) {
      if (!is413(error)) throw error;
      if (batch.length === 1) throw new Error('SINGLE_EVENT_REJECTED');
      countLimit = Math.max(1, Math.floor(batch.length / 2));
      continue;
    }
    if (acknowledgment.epoch !== epoch) throw new Error('ACK_EPOCH_MISMATCH');
    if (!Number.isSafeInteger(acknowledgment.acknowledgedThrough)
      || acknowledgment.acknowledgedThrough < 0
      || acknowledgment.acknowledgedThrough > batch[batch.length - 1]!.sequence) {
      throw new Error('ACK_OUT_OF_RANGE');
    }
    if (acknowledgment.acknowledgedThrough < batch[0]!.sequence) throw new Error('ACK_NO_PROGRESS');
    queue.ack(epoch, acknowledgment.acknowledgedThrough);
    if (acknowledgment.acknowledgedThrough === batch[batch.length - 1]!.sequence) countLimit = maxBatchEvents;
  }
}
