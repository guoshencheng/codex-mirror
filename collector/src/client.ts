import { z } from 'zod';
import type { AgentEvent } from '../../src/contracts/events';
import type { CollectorConfig } from './config';
import type { UploadAcknowledgment, UploadBatch, UploadTransport } from './uploader';

const acknowledgmentSchema = z.object({
  epoch: z.string().min(1).max(128),
  acknowledgedThrough: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
const heartbeatResponseSchema = z.object({ ok: z.literal(true) }).strict();

export interface CollectorHeartbeat {
  epoch: string;
  bootId: string;
  queuedThrough: number;
  firstPendingSequence: number;
  queueDepth: number;
  eventLoss: boolean;
}

export class CollectorHttpError extends Error {
  constructor(readonly status: number) { super(`HTTP_${status}`); }
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function request(fetcher: Fetcher, url: string, token: string, body: object, timeoutMs = 5_000): Promise<Response> {
  try {
    return await fetcher(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof CollectorHttpError) throw error;
    throw new Error('COLLECTOR_NETWORK_ERROR');
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('INVALID_UPLOAD_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > 16_384) {
        await reader.cancel();
        throw new Error('INVALID_UPLOAD_RESPONSE');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const text = new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error('INVALID_UPLOAD_RESPONSE'); }
}

export function createCollectorClient(config: CollectorConfig, fetcher: Fetcher = fetch): {
  upload: UploadTransport;
  heartbeat(input: CollectorHeartbeat, timeoutMs?: number): Promise<void>;
} {
  const base = config.serverUrl.replace(/\/$/, '');
  return {
    async upload(batch: UploadBatch): Promise<UploadAcknowledgment> {
      const response = await request(fetcher, `${base}/api/agent/events`, config.deviceToken, batch);
      if (!response.ok) throw new CollectorHttpError(response.status);
      const parsed = acknowledgmentSchema.safeParse(await boundedJson(response));
      if (!parsed.success || parsed.data.epoch !== batch.epoch) throw new Error('INVALID_UPLOAD_RESPONSE');
      const maxSent = batch.events.at(-1)?.sequence ?? 0;
      if (parsed.data.acknowledgedThrough > maxSent) throw new Error('INVALID_UPLOAD_RESPONSE');
      return parsed.data;
    },
    async heartbeat(input: CollectorHeartbeat, timeoutMs = 5_000): Promise<void> {
      const response = await request(fetcher, `${base}/api/agent/heartbeat`, config.deviceToken, input, timeoutMs);
      if (!response.ok) throw new CollectorHttpError(response.status);
      if (!heartbeatResponseSchema.safeParse(await boundedJson(response)).success) throw new Error('INVALID_HEARTBEAT_RESPONSE');
    },
  };
}

export type CollectorEvent = AgentEvent;
