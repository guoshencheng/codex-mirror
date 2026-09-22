import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { agentEventSchema, type AgentEvent, type SessionState } from '../../contracts/events';
import { eventDatabasePool } from './database';
import { reduceSession } from './reducer';

const eventBatchSchema = z.object({
  epoch: z.string().min(1).max(128),
  events: z.array(agentEventSchema).min(1).max(100),
}).strict();

const heartbeatSchema = z.object({
  epoch: z.string().min(1).max(128),
  bootId: z.string().min(1).max(128),
  queuedThrough: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  queueDepth: z.number().int().min(0).max(100_000_000),
  eventLoss: z.boolean(),
}).strict();

export type EventBatch = z.infer<typeof eventBatchSchema>;
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;
export interface IngestResult { epoch: string; acknowledgedThrough: number; }
interface IngestOptions { pool?: Pool; receivedAt?: string; }
interface HeartbeatOptions { pool?: Pool; }

export class EventIngestError extends Error {
  constructor(readonly code: string) { super(code); }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(value: AgentEvent): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function validateBatch(deviceId: string, raw: unknown): EventBatch {
  const parsed = eventBatchSchema.safeParse(raw);
  if (!parsed.success) throw new EventIngestError('INVALID_EVENT_BATCH');
  const bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
  if (bytes > 256_000) throw new EventIngestError('EVENT_BATCH_TOO_LARGE');
  for (const event of parsed.data.events) {
    if (event.deviceId !== deviceId) throw new EventIngestError('DEVICE_MISMATCH');
    if (event.collectorEpoch !== parsed.data.epoch) throw new EventIngestError('EPOCH_MISMATCH');
  }
  const sequences = new Set<number>();
  const ids = new Set<string>();
  for (const event of parsed.data.events) {
    if (sequences.has(event.sequence) || ids.has(event.eventId)) throw new EventIngestError('EVENT_CONFLICT');
    sequences.add(event.sequence);
    ids.add(event.eventId);
  }
  return parsed.data;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function markSessionsUnconfirmed(client: PoolClient, deviceId: string): Promise<void> {
  await client.query(`UPDATE sessions SET state = jsonb_set(state, '{confidence}', '"unconfirmed"'::jsonb), updated_at = now()
    WHERE device_id = $1`, [deviceId]);
}

async function ensureStream(
  client: PoolClient,
  deviceId: string,
  epoch: string,
  generation: number,
  recoveryThrough: number,
): Promise<void> {
  await client.query('UPDATE device_streams SET active = false, retired_at = now() WHERE device_id = $1 AND active', [deviceId]);
  await markSessionsUnconfirmed(client, deviceId);
  await client.query(`INSERT INTO device_streams(device_id, epoch, generation, active, recovery_through)
    VALUES ($1, $2, $3, true, $4)`, [deviceId, epoch, generation, recoveryThrough]);
  await client.query('UPDATE devices SET current_epoch = $2, generation = $3 WHERE id = $1', [deviceId, epoch, generation]);
}

async function checkDuplicate(client: PoolClient, deviceId: string, event: AgentEvent, hash: string): Promise<'same' | 'none'> {
  const existing = await client.query(`SELECT event_id, sequence, payload_hash FROM agent_events
    WHERE device_id = $1 AND (event_id = $2 OR (epoch = $3 AND sequence = $4)) LIMIT 1`,
  [deviceId, event.eventId, event.collectorEpoch, event.sequence]);
  if (!existing.rowCount) return 'none';
  const row = existing.rows[0] as { event_id: string; sequence: string | number; payload_hash: string };
  if (row.event_id !== event.eventId || Number(row.sequence) !== event.sequence || row.payload_hash.trim() !== hash) {
    throw new EventIngestError('EVENT_CONFLICT');
  }
  return 'same';
}

async function applyContiguous(client: PoolClient, deviceId: string, epoch: string, generation: number, now: string): Promise<number> {
  const streamResult = await client.query(`SELECT contiguous_sequence, recovery_through FROM device_streams
    WHERE device_id = $1 AND epoch = $2 AND active FOR UPDATE`, [deviceId, epoch]);
  const stream = streamResult.rows[0] as { contiguous_sequence: string | number; recovery_through: string | number };
  let sequence = Number(stream.contiguous_sequence);
  const recoveryThrough = Number(stream.recovery_through);
  while (sequence < Number.MAX_SAFE_INTEGER) {
    const next = await client.query(`SELECT sequence, payload, received_at FROM agent_events
      WHERE device_id = $1 AND epoch = $2 AND sequence = $3`, [deviceId, epoch, sequence + 1]);
    if (!next.rowCount) break;
    const stored = next.rows[0] as { sequence: string | number; payload: AgentEvent; received_at: string | Date };
    const event = agentEventSchema.parse(stored.payload);
    const sessionRow = await client.query('SELECT generation, state FROM sessions WHERE device_id = $1 AND session_id = $2 FOR UPDATE', [deviceId, event.sessionId]);
    const saved = sessionRow.rows[0] as { generation: number; state: SessionState } | undefined;
    const previous = saved?.generation === generation ? saved.state : null;
    const receivedAt = iso(stored.received_at ?? now);
    const reduced = reduceSession(previous, event, receivedAt);
    if (event.sequence <= recoveryThrough) reduced.confidence = 'unconfirmed';
    const projectKey = event.metadata.projectKey ?? null;
    if (projectKey) {
      await client.query(`INSERT INTO projects(project_key, name) VALUES ($1, $2)
        ON CONFLICT(project_key) DO UPDATE SET name = COALESCE(EXCLUDED.name, projects.name), updated_at = now()`,
      [projectKey, event.metadata.projectName ?? null]);
    }
    await client.query(`INSERT INTO sessions(device_id, session_id, generation, state, project_key, title)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6)
      ON CONFLICT(device_id, session_id) DO UPDATE SET generation = EXCLUDED.generation, state = EXCLUDED.state,
        project_key = CASE WHEN sessions.generation = EXCLUDED.generation THEN COALESCE(EXCLUDED.project_key, sessions.project_key) ELSE EXCLUDED.project_key END,
        title = CASE WHEN sessions.generation = EXCLUDED.generation THEN COALESCE(EXCLUDED.title, sessions.title) ELSE EXCLUDED.title END,
        updated_at = now()`,
    [deviceId, event.sessionId, generation, JSON.stringify(reduced), projectKey, event.metadata.title ?? null]);
    await client.query('UPDATE agent_events SET applied = true WHERE device_id = $1 AND epoch = $2 AND sequence = $3', [deviceId, epoch, event.sequence]);
    sequence++;
  }
  const gapResult = await client.query(`SELECT EXISTS(SELECT 1 FROM agent_events WHERE device_id = $1 AND epoch = $2 AND sequence > $3) AS has_gap`,
    [deviceId, epoch, sequence]);
  const gapDetected = Boolean((gapResult.rows[0] as { has_gap: boolean }).has_gap);
  await client.query(`UPDATE device_streams SET contiguous_sequence = $3::bigint, gap_detected = $4,
    incomplete = queue_lost OR $4, last_event_at = CASE WHEN $3::bigint > 0 THEN GREATEST(COALESCE(last_event_at, $5::timestamptz), $5::timestamptz) ELSE last_event_at END
    WHERE device_id = $1 AND epoch = $2`, [deviceId, epoch, sequence, gapDetected, now]);
  if (gapDetected) await markSessionsUnconfirmed(client, deviceId);
  return sequence;
}

export async function ingestBatch(deviceId: string, raw: unknown, options: IngestOptions = {}): Promise<IngestResult> {
  const batch = validateBatch(deviceId, raw);
  const maxSent = Math.max(...batch.events.map(event => event.sequence));
  const pool = options.pool ?? eventDatabasePool();
  const receivedAt = options.receivedAt ?? new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deviceResult = await client.query('SELECT id, generation, current_epoch FROM devices WHERE id = $1 AND revoked_at IS NULL FOR UPDATE', [deviceId]);
    if (!deviceResult.rowCount) throw new EventIngestError('DEVICE_UNAVAILABLE');
    const device = deviceResult.rows[0] as { id: string; generation: number; current_epoch: string | null };
    const knownStream = await client.query('SELECT active, contiguous_sequence FROM device_streams WHERE device_id = $1 AND epoch = $2', [deviceId, batch.epoch]);
    if (knownStream.rowCount && !(knownStream.rows[0] as { active: boolean }).active) {
      const watermark = Number((knownStream.rows[0] as { contiguous_sequence: string | number }).contiguous_sequence);
      await client.query('COMMIT');
      return { epoch: batch.epoch, acknowledgedThrough: Math.min(watermark, maxSent) };
    }
    if (!knownStream.rowCount) {
      const maxQueued = Math.max(...batch.events.map(event => event.sequence));
      await ensureStream(client, deviceId, batch.epoch, device.generation + 1, maxQueued);
    }
    for (const event of batch.events) {
      const hash = payloadHash(event);
      const duplicate = await checkDuplicate(client, deviceId, event, hash);
      if (duplicate === 'same') continue;
      const stream = await client.query('SELECT contiguous_sequence FROM device_streams WHERE device_id = $1 AND epoch = $2', [deviceId, batch.epoch]);
      const watermark = Number((stream.rows[0] as { contiguous_sequence: string | number }).contiguous_sequence);
      if (event.sequence <= watermark) continue;
      await client.query(`INSERT INTO agent_events(device_id, epoch, sequence, event_id, session_id, event_type,
        occurred_at, received_at, payload_hash, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [deviceId, batch.epoch, event.sequence, event.eventId, event.sessionId, event.type, event.occurredAt, receivedAt, hash, JSON.stringify(event)]);
    }
    const streamInfo = await client.query('SELECT generation, active FROM device_streams WHERE device_id = $1 AND epoch = $2', [deviceId, batch.epoch]);
    if (!(streamInfo.rows[0] as { active: boolean }).active) {
      const watermark = Number((knownStream.rows[0] as { contiguous_sequence: string | number } | undefined)?.contiguous_sequence ?? 0);
      await client.query('COMMIT');
      return { epoch: batch.epoch, acknowledgedThrough: Math.min(watermark, maxSent) };
    }
    const generation = Number((streamInfo.rows[0] as { generation: number }).generation);
    const acknowledgedThrough = await applyContiguous(client, deviceId, batch.epoch, generation, receivedAt);
    await client.query('COMMIT');
    return { epoch: batch.epoch, acknowledgedThrough: Math.min(acknowledgedThrough, maxSent) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function recordHeartbeat(deviceId: string, raw: unknown, receivedAt: string, options: HeartbeatOptions = {}): Promise<void> {
  const parsed = heartbeatSchema.safeParse(raw);
  if (!parsed.success) throw new EventIngestError('INVALID_HEARTBEAT');
  const heartbeat = parsed.data;
  const pool = options.pool ?? eventDatabasePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT id, generation, current_epoch, last_heartbeat_at, last_boot_id
      FROM devices WHERE id = $1 AND revoked_at IS NULL FOR UPDATE`, [deviceId]);
    if (!result.rowCount) throw new EventIngestError('DEVICE_UNAVAILABLE');
    const device = result.rows[0] as { id: string; generation: number; current_epoch: string | null; last_heartbeat_at: Date | string | null; last_boot_id: string | null };
    const streamResult = await client.query('SELECT active, boot_id FROM device_streams WHERE device_id = $1 AND epoch = $2', [deviceId, heartbeat.epoch]);
    if (streamResult.rowCount && !(streamResult.rows[0] as { active: boolean }).active) {
      await client.query('COMMIT');
      return;
    }
    const isNew = streamResult.rowCount === 0;
    const restarted = !isNew && (!device.last_boot_id || device.last_boot_id !== heartbeat.bootId);
    const offline = Boolean(device.last_heartbeat_at && Date.parse(receivedAt) - new Date(device.last_heartbeat_at).getTime() >= 120_000);
    if (isNew) await ensureStream(client, deviceId, heartbeat.epoch, device.generation + 1, heartbeat.queuedThrough);
    else if (restarted || offline) {
      await client.query('UPDATE device_streams SET recovery_through = GREATEST(recovery_through, $3) WHERE device_id = $1 AND epoch = $2',
        [deviceId, heartbeat.epoch, heartbeat.queuedThrough]);
      await markSessionsUnconfirmed(client, deviceId);
    }
    await client.query(`UPDATE device_streams SET boot_id = $3, last_heartbeat_at = $4,
      queue_lost = queue_lost OR $5, incomplete = incomplete OR $5
      WHERE device_id = $1 AND epoch = $2`, [deviceId, heartbeat.epoch, heartbeat.bootId, receivedAt, heartbeat.eventLoss]);
    await client.query(`UPDATE devices SET last_heartbeat_at = $2, last_boot_id = $3,
      last_queue_depth = $4, event_loss = event_loss OR $5 WHERE id = $1`,
    [deviceId, receivedAt, heartbeat.bootId, heartbeat.queueDepth, heartbeat.eventLoss]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
