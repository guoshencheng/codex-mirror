import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { QuotaRepository } from '../../src/server/quota/repository';

function connectionString(): string {
  const value = process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
  const db = decodeURIComponent(new URL(value).pathname.replace(/^\//, ''));
  if (!db.endsWith('_test')) throw new Error('TEST_DATABASE_NAME_REQUIRED');
  return value;
}

async function withQuotaDb<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  const schema = `quota_retention_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: connectionString(), max: 1 });
  const setup = await admin.connect();
  try { await setup.query(`CREATE SCHEMA ${schema}`); } finally { setup.release(); }
  const pool = new Pool({ connectionString: connectionString(), max: 4, options: `-c search_path=${schema}` });
  try {
    await pool.query(await readFile(new URL('../../migrations/001-quota.sql', import.meta.url), 'utf8'));
    return await run(pool);
  } finally {
    await pool.end();
    const cleanup = await admin.connect();
    try { await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { cleanup.release(); await admin.end(); }
  }
}

describe('quota history retention cleanup', () => {
  it('removes expired samples and keeps the latest account snapshot', async () => {
    await withQuotaDb(async pool => {
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

      const historyCount = await new QuotaRepository(pool).cleanupHistory(new Date('2026-06-24T00:00:00.000Z'));
      expect(historyCount).toBe(1);
      expect((await pool.query('SELECT observed_at FROM quota_snapshots')).rows.map(row => new Date(row.observed_at).toISOString()))
        .toEqual(['2026-06-25T00:00:00.000Z']);
      expect(Number((await pool.query('SELECT count(*) AS count FROM provider_accounts')).rows[0]?.count)).toBe(1);
      expect(Number((await pool.query('SELECT count(*) AS count FROM quota_latest')).rows[0]?.count)).toBe(1);
    });
  });
});
