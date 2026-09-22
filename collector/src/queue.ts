import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { AgentEvent } from '../../src/contracts/events';
import { agentEventSchema } from '../../src/contracts/events';

export type EventWithoutIds = Omit<AgentEvent, 'eventId' | 'deviceId' | 'collectorEpoch' | 'sequence'>;

export interface CollectorQueue {
  append(event: EventWithoutIds): AgentEvent;
  peek(limit: number): AgentEvent[];
  ack(epoch: string, contiguousSequence: number): void;
  health(): { queueDepth: number; pendingBytes: number; databaseBytes: number; eventLoss: boolean; errorCode: string | null; epoch: string; lastSequence: number };
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
      return {
        queueDepth: Number(stats.count),
        pendingBytes: Number(stats.bytes),
        databaseBytes: physicalBytes(),
        eventLoss: marker?.eventLoss ?? false,
        errorCode: marker?.errorCode ?? null,
        epoch,
        lastSequence: Number((database.prepare('SELECT value FROM meta WHERE key = ?').get('last_sequence') as { value: string }).value),
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
