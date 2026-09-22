import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { QuotaRepository } from '../../src/server/quota/repository';
import { cleanupAgentEvents } from '../../src/server/events/retention';

function connectionString(): string {
  const value = process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
  const db = decodeURIComponent(new URL(value).pathname.replace(/^\//, ''));
  if (!db.endsWith('_test')) throw new Error('TEST_DATABASE_NAME_REQUIRED');
  return value;
}

async function withRetentionDb<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  const schema = `retention_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: connectionString(), max: 1 });
  const setup = await admin.connect();
  try { await setup.query(`CREATE SCHEMA ${schema}`); } finally { setup.release(); }
  const pool = new Pool({ connectionString: connectionString(), max: 4, options: `-c search_path=${schema}` });
  try {
    for (const file of ['001-quota.sql', '002-events.sql']) {
      await pool.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
    }
    const tokenHash = createHash('sha256').update('test-device-token').digest('hex');
    await pool.query('INSERT INTO devices(id, name, token_hash) VALUES ($1, $2, $3)', ['device-a', 'Laptop', tokenHash]);
    return await run(pool);
  } finally {
    await pool.end();
    const cleanup = await admin.connect();
    try { await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { cleanup.release(); await admin.end(); }
  }
}

describe('database retention cleanup', () => {
  it('deletes only expired applied events except the current turn start and keeps live state/watermarks/latest quota', async () => {
    await withRetentionDb(async pool => {
      await pool.query(`INSERT INTO provider_accounts(id, provider_id, label, credential_ref)
        VALUES ('deepseek-primary', 'deepseek', 'DeepSeek', 'deepseek-key')`);
      await pool.query(`INSERT INTO quota_refresh_status(account_id, next_attempt_at)
        VALUES ('deepseek-primary', now())`);
      const snapshot = {
        accountId: 'deepseek-primary', providerId: 'deepseek', observedAt: '2026-09-22T00:00:00.000Z',
        metrics: [], serviceAvailable: true,
      };
      await pool.query('INSERT INTO quota_latest(account_id, snapshot) VALUES ($1, $2::jsonb)', ['deepseek-primary', JSON.stringify(snapshot)]);
      await pool.query(`INSERT INTO quota_snapshots(account_id, observed_at, snapshot)
        VALUES ($1, '2026-06-23T00:00:00.000Z', $2::jsonb), ($1, '2026-06-25T00:00:00.000Z', $2::jsonb)`,
      ['deepseek-primary', JSON.stringify(snapshot)]);

      await pool.query(`INSERT INTO device_streams(device_id, epoch, generation, contiguous_sequence, incomplete, gap_detected)
        VALUES ('device-a', 'epoch-a', 1, 5, true, true)`);
      const state = {
        state: 'WORKING', turnId: 'turn-current', lastSequence: 5,
        lastEventAt: '2026-08-22T00:00:00.000Z', lastReceivedAt: '2026-08-22T00:00:00.000Z',
        confidence: 'unconfirmed', currentTool: null,
      };
      await pool.query(`INSERT INTO sessions(device_id, session_id, generation, state)
        VALUES ('device-a', 'session-a', 1, $1::jsonb)`, [JSON.stringify(state)]);

      const rows = [
        { sequence: 1, id: 'old-applied-session-start', type: 'session.started', turnId: null, old: true, applied: true },
        { sequence: 2, id: 'old-applied-old-turn', type: 'turn.started', turnId: 'turn-old', old: true, applied: true },
        { sequence: 3, id: 'old-applied-current-turn', type: 'turn.started', turnId: 'turn-current', old: true, applied: true },
        { sequence: 4, id: 'old-unapplied-gap', type: 'tool.started', turnId: 'turn-current', old: true, applied: false },
        { sequence: 5, id: 'recent-applied', type: 'tool.finished', turnId: 'turn-current', old: false, applied: true },
      ];
      for (const row of rows) {
        const receivedAt = row.old ? '2026-08-22T00:00:00.000Z' : '2026-09-01T00:00:00.000Z';
        const payload = {
          schemaVersion: 1, eventId: row.id, deviceId: 'device-a', collectorEpoch: 'epoch-a',
          sequence: row.sequence, sessionId: 'session-a', turnId: row.turnId, type: row.type,
          occurredAt: receivedAt, metadata: {},
        };
        await pool.query(`INSERT INTO agent_events(device_id, epoch, sequence, event_id, session_id, event_type,
          occurred_at, received_at, payload_hash, payload, applied)
          VALUES ('device-a', 'epoch-a', $1, $2, 'session-a', $3, $4, $4, $5, $6::jsonb, $7)`,
        [row.sequence, row.id, row.type, receivedAt, 'a'.repeat(64), JSON.stringify(payload), row.applied]);
      }

      const eventCount = await cleanupAgentEvents(pool, new Date('2026-08-23T00:00:00.000Z'));
      const historyCount = await new QuotaRepository(pool).cleanupHistory(new Date('2026-06-24T00:00:00.000Z'));
      expect(eventCount).toBe(2);
      expect(historyCount).toBe(1);
      expect((await pool.query('SELECT event_id FROM agent_events ORDER BY sequence')).rows.map(row => row.event_id))
        .toEqual(['old-applied-current-turn', 'old-unapplied-gap', 'recent-applied']);
      expect((await pool.query('SELECT contiguous_sequence, incomplete, gap_detected FROM device_streams WHERE device_id = $1 AND epoch = $2', ['device-a', 'epoch-a'])).rows[0])
        .toMatchObject({ contiguous_sequence: '5', incomplete: true, gap_detected: true });
      expect((await pool.query('SELECT state FROM sessions WHERE device_id = $1 AND session_id = $2', ['device-a', 'session-a'])).rows[0]?.state)
        .toMatchObject({ state: 'WORKING', turnId: 'turn-current', confidence: 'unconfirmed' });
      expect(Number((await pool.query('SELECT count(*) AS count FROM devices')).rows[0]?.count)).toBe(1);
      expect(Number((await pool.query('SELECT count(*) AS count FROM provider_accounts')).rows[0]?.count)).toBe(1);
      expect(Number((await pool.query('SELECT count(*) AS count FROM quota_latest')).rows[0]?.count)).toBe(1);
      expect(Number((await pool.query('SELECT count(*) AS count FROM quota_snapshots')).rows[0]?.count)).toBe(1);
    });
  });
});
