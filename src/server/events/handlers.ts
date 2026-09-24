import type { Pool } from 'pg';
import { authenticateDevice, consumeDeviceRateLimit } from './device-auth';
import { EventIngestError, ingestBatch, recordHeartbeat } from './ingest';
import { noStoreJson, readBoundedJson, RequestBodyError } from './http';

function ingestStatus(code: string): number {
  if (code === 'EVENT_BATCH_TOO_LARGE') return 413;
  if (code === 'DEVICE_UNAVAILABLE') return 403;
  if (['DEVICE_MISMATCH', 'EPOCH_MISMATCH', 'EVENT_CONFLICT'].includes(code)) return 409;
  return 400;
}

export function createAgentHandlers(pool: Pool): {
  events(request: Request): Promise<Response>;
  heartbeat(request: Request): Promise<Response>;
  identity(request: Request): Promise<Response>;
} {
  return {
    async identity(request) {
      try {
        const device = await authenticateDevice(request, pool);
        return device ? noStoreJson({ deviceId: device.id }) : noStoreJson({ error: 'UNAUTHORIZED' }, 401);
      } catch {
        return noStoreJson({ error: 'SERVICE_UNAVAILABLE' }, 503);
      }
    },
    async events(request) {
      let device: { id: string } | null;
      try { device = await authenticateDevice(request, pool); }
      catch { return noStoreJson({ error: 'SERVICE_UNAVAILABLE' }, 503); }
      if (!device) return noStoreJson({ error: 'UNAUTHORIZED' }, 401);
      try {
        const limit = await consumeDeviceRateLimit(device.id, pool);
        if (!limit.allowed) return noStoreJson({ error: 'RATE_LIMITED' }, 429, { 'retry-after': String(limit.retryAfterSeconds) });
        const body = await readBoundedJson(request);
        return noStoreJson(await ingestBatch(device.id, body, { pool }));
      } catch (error) {
        if (error instanceof RequestBodyError) return noStoreJson({ error: error.message }, error.status);
        if (error instanceof EventIngestError) return noStoreJson({ error: error.code }, ingestStatus(error.code));
        return noStoreJson({ error: 'INGEST_FAILED' }, 500);
      }
    },
    async heartbeat(request) {
      let device: { id: string } | null;
      try { device = await authenticateDevice(request, pool); }
      catch { return noStoreJson({ error: 'SERVICE_UNAVAILABLE' }, 503); }
      if (!device) return noStoreJson({ error: 'UNAUTHORIZED' }, 401);
      try {
        const limit = await consumeDeviceRateLimit(device.id, pool);
        if (!limit.allowed) return noStoreJson({ error: 'RATE_LIMITED' }, 429, { 'retry-after': String(limit.retryAfterSeconds) });
        const body = await readBoundedJson(request);
        await recordHeartbeat(device.id, body, new Date().toISOString(), { pool });
        return noStoreJson({ ok: true });
      } catch (error) {
        if (error instanceof RequestBodyError) return noStoreJson({ error: error.message }, error.status);
        if (error instanceof EventIngestError) {
          return noStoreJson({ error: error.code }, error.code === 'DEVICE_UNAVAILABLE' ? 403 : 400);
        }
        return noStoreJson({ error: 'HEARTBEAT_FAILED' }, 500);
      }
    },
  };
}
