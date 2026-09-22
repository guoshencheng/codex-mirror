import type { Pool, PoolClient } from 'pg';
import {
  adminStreamLockKey,
  notificationDatabasePool,
  notificationHub,
  type DashboardNotification,
  type PgNotificationHub,
} from '../db/notifications';

export interface AdminStreamOptions {
  pool?: Pool;
  hub?: PgNotificationHub;
  heartbeatMs?: number;
  connectionLimit?: number;
}

const encoder = new TextEncoder();

function frame(notification: DashboardNotification): Uint8Array {
  if (notification.type === 'sync') return encoder.encode('event: sync\ndata: {}\n\n');
  return encoder.encode(`event: invalidate\ndata: ${JSON.stringify({ topic: notification.topic })}\n\n`);
}

async function acquireAdminSlot(pool: Pool, adminId: string, limit: number): Promise<() => Promise<void>> {
  const client = await pool.connect();
  let heldSlot: number | null = null;
  try {
    for (let slot = 0; slot < limit; slot += 1) {
      const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [adminStreamLockKey(adminId, slot)]);
      if ((result.rows[0] as { acquired: boolean }).acquired) { heldSlot = slot; break; }
    }
    if (heldSlot === null) throw new Error('STREAM_LIMIT');
  } catch (error) {
    if (heldSlot === null) {
      try { client.release(!(error instanceof Error && error.message === 'STREAM_LIMIT')); } catch { /* already released */ }
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [adminStreamLockKey(adminId, heldSlot!)]);
      client.release();
    } catch {
      client.release(true);
    }
  };
}

export async function createAdminStream(
  request: Request,
  sessionId: string,
  options: AdminStreamOptions = {},
): Promise<Response> {
  const pool = options.pool ?? notificationDatabasePool();
  const hub = options.hub ?? notificationHub();
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const connectionLimit = options.connectionLimit ?? 5;
  const sessionResult = await pool.query('SELECT admin_id FROM admin_sessions WHERE id = $1 AND expires_at > now()', [sessionId]);
  const adminId = (sessionResult.rows[0] as { admin_id?: string } | undefined)?.admin_id;
  if (!adminId) throw new Error('STREAM_AUTH_EXPIRED');
  const releaseSlot = await acquireAdminSlot(pool, adminId, connectionLimit);
  let unsubscribe: (() => void) | undefined;
  try { unsubscribe = await hub.subscribe(onNotification); }
  catch (error) { await releaseSlot(); throw error; }

  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let checkingSession = false;
  let cleanupPromise: Promise<void> | undefined;
  let needsSync = false;

  const cleanup = (closeController: boolean): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      closed = true;
      if (keepalive) clearInterval(keepalive);
      keepalive = undefined;
      request.signal.removeEventListener('abort', abort);
      unsubscribe?.();
      unsubscribe = undefined;
      if (closeController) {
        try { controller?.close(); } catch { /* already canceled */ }
      }
      await releaseSlot();
    })();
    return cleanupPromise;
  };

  const enqueue = (notification: DashboardNotification): boolean => {
    if (closed || !controller) return false;
    if (controller.desiredSize !== null && controller.desiredSize <= 0) {
      void cleanup(true);
      return false;
    }
    try { controller.enqueue(frame(notification)); return true; }
    catch { void cleanup(false); return false; }
  };

  function onNotification(notification: DashboardNotification): void {
    if (!controller) { needsSync = true; return; }
    enqueue(notification);
  }

  const abort = () => { void cleanup(true); };

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      request.signal.addEventListener('abort', abort, { once: true });
      enqueue({ type: 'sync' });
      if (needsSync) {
        needsSync = false;
        // The initial full sync subsumes notifications received before stream startup.
      }
      keepalive = setInterval(() => {
        void (async () => {
          if (closed || checkingSession) return;
          checkingSession = true;
          try {
            const valid = await pool.query('SELECT 1 FROM admin_sessions WHERE id = $1 AND expires_at > now()', [sessionId]);
            if (closed) return;
            if (!valid.rowCount) { await cleanup(true); return; }
            if (controller?.desiredSize && controller.desiredSize > 0) controller.enqueue(encoder.encode(': keep-alive\n\n'));
          } catch { await cleanup(true); }
          finally { checkingSession = false; }
        })();
      }, heartbeatMs);
      if (request.signal.aborted) abort();
    },
    cancel() { return cleanup(false); },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
