import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, EventType } from '../../src/contracts/events';
import { ingestBatch, recordHeartbeat, type EventBatch } from '../../src/server/events/ingest';
import { createAgentHandlers } from '../../src/server/events/handlers';

const testToken = 'a'.repeat(43);

function connectionString(): string {
  const value = process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
  const db = decodeURIComponent(new URL(value).pathname.replace(/^\//, ''));
  if (!db.endsWith('_test')) throw new Error('TEST_DATABASE_NAME_REQUIRED');
  return value;
}

async function withEventsDb<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  const schema = `events_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: connectionString(), max: 1 });
  const setup = await admin.connect();
  try { await setup.query(`CREATE SCHEMA ${schema}`); } finally { setup.release(); }
  const pool = new Pool({ connectionString: connectionString(), max: 4, options: `-c search_path=${schema}` });
  try {
    for (const file of ['001-quota.sql', '002-events.sql', '009-session-harness.sql']) {
      await pool.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
    }
    await pool.query(`INSERT INTO devices(id, name, token_hash) VALUES ('d1', 'Laptop', $1)`, [createHash('sha256').update(testToken).digest('hex')]);
    return await run(pool);
  } finally {
    await pool.end();
    const cleanup = await admin.connect();
    try { await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { cleanup.release(); await admin.end(); }
  }
}

const at = '2026-09-22T00:00:00.000Z';
function event(sequence: number, type: EventType, turnId: string | null = 't1', overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    schemaVersion: 1, eventId: `e${sequence}`, deviceId: 'd1', collectorEpoch: 'epoch-a',
    sequence, sessionId: 's1', turnId, type, occurredAt: at, metadata: {}, ...overrides,
  };
}
function batch(...events: AgentEvent[]): EventBatch { return { epoch: 'epoch-a', events }; }

describe('PostgreSQL-backed ordered event ingest', () => {
  it('continues an adopted queue from its first pending sequence', async () => {
    await withEventsDb(async pool => {
      await recordHeartbeat('d1', { epoch: 'epoch-a', bootId: 'boot-a', queuedThrough: 42,
        firstPendingSequence: 41, queueDepth: 2, eventLoss: false }, at, { pool });
      expect(await ingestBatch('d1', batch(event(41, 'turn.started'), event(42, 'turn.stopped')), { pool, receivedAt: at }))
        .toEqual({ epoch: 'epoch-a', acknowledgedThrough: 42 });
      expect((await pool.query('SELECT state FROM sessions WHERE device_id = $1', ['d1'])).rows[0]?.state.state).toBe('STOPPED');
    });
  });
  it('updates a late title without refreshing the execution activity timestamp', async () => {
    await withEventsDb(async pool => {
      await ingestBatch('d1', batch(event(1, 'turn.started')), { pool, receivedAt: at });
      const before = (await pool.query('SELECT state FROM sessions WHERE device_id = $1 AND session_id = $2', ['d1', 's1'])).rows[0].state;
      await ingestBatch('d1', batch(event(2, 'session.metadata.updated', null, {
        occurredAt: '2026-09-22T00:05:00.000Z', metadata: { title: 'Actual task' },
      })), { pool, receivedAt: '2026-09-22T00:05:01.000Z' });
      const after = (await pool.query('SELECT title, state FROM sessions WHERE device_id = $1 AND session_id = $2', ['d1', 's1'])).rows[0];
      expect(after.title).toBe('Actual task');
      expect(after.state).toMatchObject({
        state: 'WORKING', lastSequence: 2, lastEventAt: before.lastEventAt, lastReceivedAt: before.lastReceivedAt,
      });
    });
  });

  it('buffers gaps, applies newly contiguous events once, and returns a contiguous acknowledgment', async () => {
    await withEventsDb(async pool => {
      const first = event(1, 'turn.started');
      const stop = event(2, 'turn.stopped');
      expect(await ingestBatch('d1', batch(stop), { pool, receivedAt: at })).toEqual({ epoch: 'epoch-a', acknowledgedThrough: 0 });
      expect((await pool.query('SELECT incomplete FROM device_streams WHERE device_id = $1 AND epoch = $2', ['d1', 'epoch-a'])).rows[0]?.incomplete).toBe(true);
      expect(await ingestBatch('d1', batch(first), { pool, receivedAt: at })).toEqual({ epoch: 'epoch-a', acknowledgedThrough: 1 });
      expect((await pool.query('SELECT incomplete FROM device_streams WHERE device_id = $1 AND epoch = $2', ['d1', 'epoch-a'])).rows[0]?.incomplete).toBe(false);
      const state = await pool.query('SELECT state FROM sessions WHERE device_id = $1 AND session_id = $2', ['d1', 's1']);
      expect(state.rows[0]?.state.state).toBe('STOPPED');
      await ingestBatch('d1', batch(first, stop), { pool, receivedAt: at });
      expect(Number((await pool.query('SELECT count(*) AS count FROM agent_events')).rows[0]?.count)).toBe(2);
      expect(await ingestBatch('d1', batch(first), { pool, receivedAt: at })).toEqual({ epoch: 'epoch-a', acknowledgedThrough: 1 });
    });
  });

  it('rejects events whose embedded device identity does not match the authenticated device', async () => {
    await withEventsDb(async pool => {
      await expect(ingestBatch('d1', batch(event(1, 'turn.started', 't1', { deviceId: 'd2' })), { pool, receivedAt: at }))
        .rejects.toThrow('DEVICE_MISMATCH');
    });
  });

  it('rejects a sequence or event ID reused with a different canonical payload', async () => {
    await withEventsDb(async pool => {
      const first = event(1, 'turn.started');
      await ingestBatch('d1', batch(first), { pool, receivedAt: at });
      await expect(ingestBatch('d1', batch({ ...first, type: 'turn.interrupted' }), { pool, receivedAt: at }))
        .rejects.toThrow('EVENT_CONFLICT');
    });
  });

  it('retains watermarks after event cleanup so expired sequence numbers are never replayed', async () => {
    await withEventsDb(async pool => {
      const first = event(1, 'turn.started');
      await ingestBatch('d1', batch(first), { pool, receivedAt: at });
      await pool.query('DELETE FROM agent_events WHERE device_id = $1 AND epoch = $2', ['d1', 'epoch-a']);
      const replay = await ingestBatch('d1', batch(first), { pool, receivedAt: '2026-09-22T00:30:00.000Z' });
      expect(replay).toEqual({ epoch: 'epoch-a', acknowledgedThrough: 1 });
      expect(Number((await pool.query('SELECT count(*) AS count FROM agent_events')).rows[0]?.count)).toBe(0);
      expect((await pool.query('SELECT state FROM sessions WHERE device_id = $1 AND session_id = $2', ['d1', 's1'])).rows[0]?.state.state)
        .toBe('WORKING');
    });
  });

  it('retires old epochs and never lets their delayed events overwrite a new generation', async () => {
    await withEventsDb(async pool => {
      await recordHeartbeat('d1', { epoch: 'epoch-a', bootId: 'boot-a', queuedThrough: 0, queueDepth: 0, eventLoss: false }, at, { pool });
      await ingestBatch('d1', batch(event(1, 'turn.started')), { pool, receivedAt: at });
      await recordHeartbeat('d1', { epoch: 'epoch-b', bootId: 'boot-b', queuedThrough: 0, queueDepth: 0, eventLoss: false }, '2026-09-22T00:03:00.000Z', { pool });
      const newer: AgentEvent = { ...event(1, 'turn.started', 't2'), eventId: 'b1', collectorEpoch: 'epoch-b', occurredAt: '2026-09-22T00:03:01.000Z' };
      await ingestBatch('d1', { epoch: 'epoch-b', events: [newer] }, { pool, receivedAt: '2026-09-22T00:03:01.000Z' });
      const oldStop: AgentEvent = { ...event(2, 'turn.stopped'), collectorEpoch: 'epoch-a' };
      const oldAck = await ingestBatch('d1', { epoch: 'epoch-a', events: [oldStop] }, { pool, receivedAt: '2026-09-22T00:03:02.000Z' });
      expect(oldAck).toEqual({ epoch: 'epoch-a', acknowledgedThrough: 1 });
      const state = await pool.query('SELECT state FROM sessions WHERE device_id = $1 AND session_id = $2', ['d1', 's1']);
      expect(state.rows[0]?.state.turnId).toBe('t2');
      expect(state.rows[0]?.state.state).toBe('WORKING');
    });
  });

  it('marks buffered historical work unconfirmed on restart until a post-watermark turn starts', async () => {
    await withEventsDb(async pool => {
      await recordHeartbeat('d1', { epoch: 'epoch-a', bootId: 'boot-a', queuedThrough: 0, queueDepth: 0, eventLoss: false }, at, { pool });
      await ingestBatch('d1', batch(event(1, 'turn.started')), { pool, receivedAt: at });
      await recordHeartbeat('d1', { epoch: 'epoch-a', bootId: 'boot-b', queuedThrough: 2, queueDepth: 1, eventLoss: false }, '2026-09-22T00:03:00.000Z', { pool });
      const oldTurn: AgentEvent = { ...event(2, 'tool.started'), collectorEpoch: 'epoch-a', metadata: { toolName: 'Read' } };
      await ingestBatch('d1', { epoch: 'epoch-a', events: [oldTurn] }, { pool, receivedAt: '2026-09-22T00:03:01.000Z' });
      let state = await pool.query('SELECT state FROM sessions WHERE device_id = $1 AND session_id = $2', ['d1', 's1']);
      expect(state.rows[0]?.state.confidence).toBe('unconfirmed');
      const newTurn: AgentEvent = { ...event(3, 'turn.started', 't2'), collectorEpoch: 'epoch-a' };
      await ingestBatch('d1', { epoch: 'epoch-a', events: [newTurn] }, { pool, receivedAt: '2026-09-22T00:03:02.000Z' });
      state = await pool.query('SELECT state FROM sessions WHERE device_id = $1 AND session_id = $2', ['d1', 's1']);
      expect(state.rows[0]?.state.confidence).toBe('confirmed');
    });
  });

  it('keeps queue-loss health incomplete after a healthy heartbeat resumes', async () => {
    await withEventsDb(async pool => {
      await recordHeartbeat('d1', { epoch: 'epoch-a', bootId: 'boot-a', queuedThrough: 0, queueDepth: 0, eventLoss: true }, at, { pool });
      await recordHeartbeat('d1', { epoch: 'epoch-a', bootId: 'boot-a', queuedThrough: 0, queueDepth: 0, eventLoss: false }, '2026-09-22T00:00:20.000Z', { pool });
      const row = await pool.query('SELECT incomplete, queue_lost FROM device_streams WHERE device_id = $1 AND epoch = $2', ['d1', 'epoch-a']);
      expect(row.rows[0]).toMatchObject({ incomplete: true, queue_lost: true });
    });
  });

  it('authenticates Next.js ingest handlers, accepts the collector wire protocol, and bounds request bodies', async () => {
    await withEventsDb(async pool => {
      const handlers = createAgentHandlers(pool);
      const eventBody = batch(event(1, 'turn.started'));
      const unauthorized = await handlers.events(new Request('https://dashboard.test/api/agent/events', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(eventBody),
      }));
      expect(unauthorized.status).toBe(401);
      const heartbeat = await handlers.heartbeat(new Request('https://dashboard.test/api/agent/heartbeat', {
        method: 'POST', headers: { authorization: `Bearer ${testToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ epoch: 'epoch-a', bootId: 'boot-a', queuedThrough: 0, queueDepth: 1, eventLoss: false }),
      }));
      expect(heartbeat.status).toBe(200);
      expect(await heartbeat.json()).toEqual({ ok: true });
      const accepted = await handlers.events(new Request('https://dashboard.test/api/agent/events', {
        method: 'POST', headers: { authorization: `Bearer ${testToken}`, 'content-type': 'application/json' }, body: JSON.stringify(eventBody),
      }));
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ epoch: 'epoch-a', acknowledgedThrough: 1 });
      expect(accepted.headers.get('cache-control')).toBe('no-store');
      const oversized = await handlers.events(new Request('https://dashboard.test/api/agent/events', {
        method: 'POST', headers: { authorization: `Bearer ${testToken}`, 'content-type': 'application/json', 'content-length': '256001' }, body: '{}',
      }));
      expect(oversized.status).toBe(413);
      const streamedOversized = await handlers.events(new Request('https://dashboard.test/api/agent/events', {
        method: 'POST', headers: { authorization: `Bearer ${testToken}`, 'content-type': 'application/json' }, body: ' '.repeat(256_001),
      }));
      expect(streamedOversized.status).toBe(413);
    });
  });
});
