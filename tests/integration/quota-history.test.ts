import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { QuotaRepository } from '../../src/server/quota/repository';
import type { ProviderSnapshot } from '../../src/contracts/quota';
import { withTestDb } from '../support/database';

const accountId = 'history-account';
const otherAccountId = 'other-account';
const to = new Date('2026-09-29T00:00:00.000Z');

function snapshot(observedAt: string, total = '0.50'): ProviderSnapshot {
  return {
    accountId,
    providerId: 'fake',
    observedAt,
    serviceAvailable: true,
    metrics: [{
      kind: 'balance', key: 'wallet', label: '余额', currency: 'USD',
      total, granted: null, toppedUp: null,
    }],
  };
}

async function applyHistoryMigration(pool: Pool): Promise<void> {
  await pool.query(await readFile(new URL('../../migrations/010-quota-history-index.sql', import.meta.url), 'utf8'));
}

async function seedAccount(pool: Pool, id: string, enabled = true): Promise<void> {
  await pool.query(`INSERT INTO provider_accounts(id, provider_id, label, credential_ref, options, enabled)
    VALUES ($1, 'fake', $1, 'unused', '{}'::jsonb, $2)`, [id, enabled]);
  await pool.query('INSERT INTO quota_refresh_status(account_id) VALUES ($1)', [id]);
}

describe('quota history repository', () => {
  it('reads an account-scoped, bounded, deterministic history and preserves latest cleanup', async () => {
    await withTestDb(async ({ pool }) => {
      await applyHistoryMigration(pool);
      const repository = new QuotaRepository(pool);
      await seedAccount(pool, accountId);
      await seedAccount(pool, otherAccountId);
      await seedAccount(pool, 'disabled-account', false);

      const boundary = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const before = new Date(Date.parse(boundary) - 1).toISOString();
      const after = new Date(to.getTime() + 1).toISOString();
      await pool.query('INSERT INTO quota_latest(account_id, snapshot) VALUES ($1, $2::jsonb)', [accountId, JSON.stringify(snapshot(to.toISOString(), '0.25'))]);
      const first = await pool.query(
        'INSERT INTO quota_snapshots(account_id, observed_at, snapshot) VALUES ($1, $2, $3::jsonb) RETURNING id',
        [accountId, before, JSON.stringify(snapshot(before))],
      );
      const boundaryInsert = await pool.query(
        'INSERT INTO quota_snapshots(account_id, observed_at, snapshot) VALUES ($1, $2, $3::jsonb) RETURNING id',
        [accountId, boundary, JSON.stringify(snapshot(boundary, '0.10'))],
      );
      const duplicate = await pool.query(
        'INSERT INTO quota_snapshots(account_id, observed_at, snapshot) VALUES ($1, $2, $3::jsonb) RETURNING id',
        [accountId, boundary, JSON.stringify(snapshot(boundary, '0.20'))],
      );
      const end = await pool.query(
        'INSERT INTO quota_snapshots(account_id, observed_at, snapshot) VALUES ($1, $2, $3::jsonb) RETURNING id',
        [accountId, to.toISOString(), JSON.stringify(snapshot(to.toISOString(), '0.30'))],
      );
      await pool.query(
        'INSERT INTO quota_snapshots(account_id, observed_at, snapshot) VALUES ($1, $2, $3::jsonb), ($1, $4, $5::jsonb)',
        [otherAccountId, boundary, JSON.stringify({ ...snapshot(boundary), accountId: otherAccountId }), after, JSON.stringify({ ...snapshot(after), accountId: otherAccountId })],
      );

      const rows = await repository.readHistory(accountId, new Date('2020-01-01T00:00:00.000Z'), to);
      expect(rows?.map(row => row.id)).toEqual([
        String(duplicate.rows[0].id), String(end.rows[0].id),
      ]);
      expect(rows?.find(row => row.id === String(duplicate.rows[0].id))?.snapshot.metrics[0]).toMatchObject({ total: '0.20' });
      expect(await repository.readHistory('missing-account', new Date('2026-01-01T00:00:00Z'), to)).toBeNull();
      expect(await repository.readHistory('disabled-account', new Date('2026-01-01T00:00:00Z'), to)).toBeNull();

      const old = await pool.query(
        'INSERT INTO quota_snapshots(account_id, observed_at, snapshot) VALUES ($1, $2, $3::jsonb)',
        [accountId, before, JSON.stringify(snapshot(before, '0.01'))],
      );
      expect(old.rowCount).toBe(1);
      expect(await repository.cleanupHistory(new Date(boundary))).toBe(2);
      expect((await repository.readLatest(accountId)).snapshot).toEqual(snapshot(to.toISOString(), '0.25'));
      expect(first.rows[0].id).toBeDefined();

      const indexes = await pool.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'quota_snapshots' AND indexname = 'quota_history_account_time'`,
      );
      expect(indexes.rows).toHaveLength(1);
      expect(indexes.rows[0]?.indexdef).toMatch(/\(account_id, observed_at, id\)/);
    });
  });
});
