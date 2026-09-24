import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { AgentEvent } from '../../src/contracts/events';
import { agentEventSchema } from '../../src/contracts/events';

export type EventWithoutIds = Omit<AgentEvent, 'eventId' | 'deviceId' | 'collectorEpoch' | 'sequence'>;

export interface CollectorQueue {
  append(event: EventWithoutIds): AgentEvent;
  appendHook(event: EventWithoutIds): AgentEvent | null;
  titleCandidates(now: string, limit: number): string[];
  recordTitleCheck(sessionId: string, title: string | null, checkedAt: string): AgentEvent | null;
  peek(limit: number): AgentEvent[];
  ack(epoch: string, contiguousSequence: number): void;
  health(): { queueDepth: number; pendingBytes: number; databaseBytes: number; eventLoss: boolean; errorCode: string | null; epoch: string; lastSequence: number; firstPendingSequence: number };
  getProjectCache(cacheKey: string): { projectKey: string; projectName?: string } | null;
  putProjectCache(cacheKey: string, project: { projectKey: string; projectName?: string }): void;
  close(): void;
}

interface HealthMarker {
  eventLoss: boolean;
  errorCode: string;
  recordedAt: string;
}

function fileSize(path: string): number {
  try { return statSync(path).size; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 0;
    throw error;
  }
}

function atomicHealthWrite(path: string, marker: HealthMarker): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch { /* already renamed */ }
  }
}

function readHealth(path: string): HealthMarker | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<HealthMarker>;
    if (value.eventLoss === true && typeof value.errorCode === 'string' && typeof value.recordedAt === 'string') {
      return value as HealthMarker;
    }
    return null;
  } catch { return null; }
}

export function openQueue(path: string, maxBytes = 100_000_000, deviceId = process.env.COLLECTOR_DEVICE_ID): CollectorQueue {
  if (!deviceId || !/^[a-zA-Z0-9_-]{1,128}$/.test(deviceId)) throw new Error('DEVICE_ID_REQUIRED');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('INVALID_QUEUE_LIMIT');
  const dbPath = resolve(path);
  const directory = dirname(dbPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const healthPath = `${dbPath}.health.json`;
  const database = new Database(dbPath, { timeout: 200 });
  chmodSync(dbPath, 0o600);
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('busy_timeout = 200');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS pending (
      sequence INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS project_cache (
      cache_key TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      project_name TEXT,
      cached_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS session_tracking (
      session_id TEXT PRIMARY KEY,
      turn_id TEXT,
      waiting_approval INTEGER NOT NULL DEFAULT 0,
      last_hook_at TEXT NOT NULL,
      title TEXT,
      title_checked_at TEXT
    ) STRICT;
  `);
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    try { if (fileSize(file) > 0) chmodSync(file, 0o600); } catch { /* file may disappear after checkpoint */ }
  }
  database.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('device_id', deviceId);
  const savedDevice = database.prepare('SELECT value FROM meta WHERE key = ?').get('device_id') as { value: string };
  if (savedDevice.value !== deviceId) {
    database.close();
    throw new Error('DEVICE_ID_MISMATCH');
  }
  database.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('collector_epoch', randomUUID());
  database.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('last_sequence', '0');
  const epoch = (database.prepare('SELECT value FROM meta WHERE key = ?').get('collector_epoch') as { value: string }).value;
  const healthUpdate = database.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const markLoss = (errorCode: string) => atomicHealthWrite(healthPath, { eventLoss: true, errorCode, recordedAt: new Date().toISOString() });
  const physicalBytes = () => fileSize(dbPath) + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`);

  const appendTransaction = database.transaction((input: EventWithoutIds): AgentEvent => {
    const lastSequence = Number((database.prepare('SELECT value FROM meta WHERE key = ?').get('last_sequence') as { value: string }).value);
    const full = agentEventSchema.parse({ ...input, eventId: randomUUID(), deviceId, collectorEpoch: epoch, sequence: lastSequence + 1 });
    const payload = JSON.stringify(full);
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    const pending = database.prepare('SELECT COALESCE(SUM(payload_bytes), 0) AS bytes FROM pending').get() as { bytes: number };
    const occupied = Math.max(Number(pending.bytes), physicalBytes());
    if (occupied + payloadBytes > maxBytes) throw new Error('QUEUE_FULL');
    database.prepare('INSERT INTO pending(sequence, event_id, payload, payload_bytes) VALUES (?, ?, ?, ?)')
      .run(full.sequence, full.eventId, payload, payloadBytes);
    healthUpdate.run('last_sequence', String(full.sequence));
    return full;
  });

  const appendHookTransaction = database.transaction((input: EventWithoutIds): AgentEvent | null => {
    if (input.type === 'tool.finished') {
      const tracked = database.prepare('SELECT turn_id, waiting_approval FROM session_tracking WHERE session_id = ?')
        .get(input.sessionId) as { turn_id: string | null; waiting_approval: number } | undefined;
      const lastHookAt = new Date(input.occurredAt).toISOString();
      if (!tracked) return null;
      const completedApproval = input.turnId !== null
        && tracked.waiting_approval === 1
        && tracked.turn_id === input.turnId;
      database.prepare('UPDATE session_tracking SET waiting_approval = ?, last_hook_at = ? WHERE session_id = ?')
        .run(completedApproval ? 0 : tracked.waiting_approval, lastHookAt, input.sessionId);
      if (!completedApproval) return null;
      return appendTransaction({ ...input, type: 'turn.resumed', metadata: {} });
    }
    const saved = appendTransaction(input);
    if (input.type !== 'session.metadata.updated') {
      const turnId = input.type === 'turn.started' || input.type === 'approval.requested' ? input.turnId : null;
      const waiting = input.type === 'approval.requested' && input.turnId ? 1 : 0;
      database.prepare(`INSERT INTO session_tracking(session_id, turn_id, waiting_approval, last_hook_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
          turn_id = CASE WHEN excluded.turn_id IS NOT NULL THEN excluded.turn_id ELSE session_tracking.turn_id END,
          waiting_approval = CASE WHEN excluded.waiting_approval = 1 THEN 1
            WHEN ? IN ('turn.started', 'approval.requested', 'turn.stopped', 'turn.interrupted', 'session.ended') THEN 0
            ELSE session_tracking.waiting_approval END,
          last_hook_at = excluded.last_hook_at`)
        .run(input.sessionId, turnId, waiting, new Date(input.occurredAt).toISOString(), input.type);
    }
    return saved;
  });

  const recordTitleTransaction = database.transaction((sessionId: string, title: string | null, checkedAt: string): AgentEvent | null => {
    const tracked = database.prepare('SELECT title FROM session_tracking WHERE session_id = ?')
      .get(sessionId) as { title: string | null } | undefined;
    if (!tracked) return null;
    let clean: string | null = null;
    if (typeof title === 'string') {
      const trimmed = title.trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
      if (trimmed && trimmed.length <= 160) clean = trimmed;
    }
    let event: AgentEvent | null = null;
    if (clean && clean !== tracked.title) {
      event = appendTransaction({
        schemaVersion: 1, sessionId, turnId: null, type: 'session.metadata.updated',
        occurredAt: checkedAt, metadata: { title: clean },
      });
      database.prepare('UPDATE session_tracking SET title = ? WHERE session_id = ?').run(clean, sessionId);
    }
    database.prepare('UPDATE session_tracking SET title_checked_at = ? WHERE session_id = ?').run(checkedAt, sessionId);
    return event;
  });

  return {
    append(event) {
      try { return appendTransaction.immediate(event); }
      catch (error) {
        const code = error instanceof Error && error.message === 'QUEUE_FULL' ? 'QUEUE_FULL'
          : error && typeof error === 'object' && 'code' in error && String(error.code).includes('BUSY') ? 'QUEUE_BUSY'
            : 'QUEUE_WRITE_FAILED';
        try { markLoss(code); } catch { /* best effort health marker when storage is exhausted */ }
        throw new Error(code);
      }
    },
    appendHook(event) {
      try { return appendHookTransaction.immediate(event); }
      catch (error) {
        const code = error instanceof Error && error.message === 'QUEUE_FULL' ? 'QUEUE_FULL' : 'QUEUE_WRITE_FAILED';
        try { markLoss(code); } catch { /* best effort */ }
        throw new Error(code);
      }
    },
    titleCandidates(now, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_TITLE_LIMIT');
      const current = Date.parse(now);
      if (!Number.isFinite(current)) throw new Error('INVALID_TITLE_TIME');
      const recent = new Date(current - 24 * 60 * 60 * 1000).toISOString();
      const rows = database.prepare(`SELECT session_id, title, title_checked_at, last_hook_at FROM session_tracking
        WHERE last_hook_at >= ? ORDER BY last_hook_at DESC`).all(recent) as Array<{
          session_id: string; title: string | null; title_checked_at: string | null; last_hook_at: string;
        }>;
      return rows.filter(row => {
        const interval = row.title || current - Date.parse(row.last_hook_at) >= 300_000 ? 300_000 : 20_000;
        return !row.title_checked_at || current - Date.parse(row.title_checked_at) >= interval;
      })
        .slice(0, limit).map(row => row.session_id);
    },
    recordTitleCheck(sessionId, title, checkedAt) {
      return recordTitleTransaction.immediate(sessionId, title, new Date(checkedAt).toISOString());
    },
    peek(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('INVALID_QUEUE_READ_LIMIT');
      return (database.prepare('SELECT payload FROM pending ORDER BY sequence LIMIT ?').all(limit) as Array<{ payload: string }>)
        .map(row => agentEventSchema.parse(JSON.parse(row.payload)));
    },
    ack(requestEpoch, contiguousSequence) {
      if (requestEpoch !== epoch) throw new Error('EPOCH_MISMATCH');
      if (!Number.isSafeInteger(contiguousSequence) || contiguousSequence < 0) throw new Error('INVALID_ACK');
      const last = Number((database.prepare('SELECT value FROM meta WHERE key = ?').get('last_sequence') as { value: string }).value);
      if (contiguousSequence > last) throw new Error('ACK_OUT_OF_RANGE');
      database.transaction(() => {
        database.prepare('DELETE FROM pending WHERE sequence <= ?').run(contiguousSequence);
      }).immediate();
      database.pragma('wal_checkpoint(TRUNCATE)');
      const remaining = Number((database.prepare('SELECT COUNT(*) AS count FROM pending').get() as { count: number }).count);
      if (remaining === 0) database.exec('VACUUM');
    },
    health() {
      const stats = database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes FROM pending').get() as { count: number; bytes: number };
      const marker = readHealth(healthPath);
      const lastSequence = Number((database.prepare('SELECT value FROM meta WHERE key = ?').get('last_sequence') as { value: string }).value);
      const first = database.prepare('SELECT MIN(sequence) AS sequence FROM pending').get() as { sequence: number | null };
      return {
        queueDepth: Number(stats.count),
        pendingBytes: Number(stats.bytes),
        databaseBytes: physicalBytes(),
        eventLoss: marker?.eventLoss ?? false,
        errorCode: marker?.errorCode ?? null,
        epoch,
        lastSequence,
        firstPendingSequence: first.sequence ?? lastSequence + 1,
      };
    },
    getProjectCache(cacheKey) {
      const result = database.prepare('SELECT project_key, project_name, cached_at FROM project_cache WHERE cache_key = ?').get(cacheKey) as {
        project_key: string; project_name: string | null; cached_at: string;
      } | undefined;
      if (!result || Date.now() - Date.parse(result.cached_at) > 24 * 60 * 60 * 1000) return null;
      return { projectKey: result.project_key, ...(result.project_name ? { projectName: result.project_name } : {}) };
    },
    putProjectCache(cacheKey, project) {
      database.prepare(`INSERT INTO project_cache(cache_key, project_key, project_name, cached_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET project_key=excluded.project_key,
        project_name=excluded.project_name, cached_at=excluded.cached_at`)
        .run(cacheKey, project.projectKey, project.projectName ?? null, new Date().toISOString());
    },
    close() { database.close(); },
  };
}
