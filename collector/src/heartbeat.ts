import type { UploadTransport } from './uploader';
import type { CollectorQueue } from './queue';
import type { CollectorHeartbeat } from './client';
import { CollectorHttpError } from './client';
import { uploadOnce } from './uploader';

export interface HeartbeatQueue extends Pick<CollectorQueue, 'health'> {
  peek: CollectorQueue['peek'];
  ack: CollectorQueue['ack'];
}

export function heartbeatPayload(queue: Pick<CollectorQueue, 'health'>, bootId: string): CollectorHeartbeat {
  const health = queue.health();
  return {
    epoch: health.epoch,
    bootId,
    queuedThrough: health.lastSequence,
    queueDepth: health.queueDepth,
    eventLoss: health.eventLoss,
  };
}

export function retryDelayMs(failures: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(6, failures - 1));
  const base = Math.min(60_000, 1_000 * 2 ** exponent);
  const jitter = 0.75 + Math.max(0, Math.min(1, random())) * 0.5;
  return Math.max(1_000, Math.round(base * jitter));
}

function errorCode(error: unknown): string {
  if (error instanceof CollectorHttpError) {
    if (error.status === 401 || error.status === 403) return 'DEVICE_AUTH_FAILED';
    if (error.status === 429) return 'SERVER_RATE_LIMITED';
    if (error.status === 413) return 'SERVER_REJECTED_BATCH';
    if (error.status >= 500) return 'SERVER_UNAVAILABLE';
  }
  if (error instanceof Error && ['SINGLE_EVENT_REJECTED', 'ACK_EPOCH_MISMATCH', 'ACK_OUT_OF_RANGE', 'ACK_NO_PROGRESS'].includes(error.message)) {
    return error.message;
  }
  return 'COLLECTOR_REQUEST_FAILED';
}

export async function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function runCollectorLoop(options: {
  queue: HeartbeatQueue;
  bootId: string;
  heartbeat(input: CollectorHeartbeat): Promise<void>;
  upload: UploadTransport;
  signal: AbortSignal;
  heartbeatIntervalMs?: number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onError?: (code: string) => void;
}): Promise<void> {
  const interval = options.heartbeatIntervalMs ?? 20_000;
  const sleep = options.sleep ?? sleepUntil;
  let failures = 0;
  while (!options.signal.aborted) {
    try {
      // Recovery watermark is acknowledged before sending any queued event from this boot.
      await options.heartbeat(heartbeatPayload(options.queue, options.bootId));
      await uploadOnce(options.queue, options.upload);
      failures = 0;
      await sleep(interval, options.signal);
    } catch (error) {
      failures += 1;
      options.onError?.(errorCode(error));
      await sleep(retryDelayMs(failures, options.random), options.signal);
    }
  }
}
