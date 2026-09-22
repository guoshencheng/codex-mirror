import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

function testConnectionString(): string {
  const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
  const database = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
  if (!database.endsWith('_test')) throw new Error('TEST_DATABASE_NAME_REQUIRED');
  return connectionString;
}

export async function withTestDb<T>(callback: (db: { pool: Pool }) => Promise<T>): Promise<T> {
  const connectionString = testConnectionString();
  const schema = `quota_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, max: 1 });
  const setup = await admin.connect();
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
  } finally {
    setup.release();
  }

  const pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` });
  try {
    const migration = await readFile(new URL('../../migrations/001-quota.sql', import.meta.url), 'utf8');
    await pool.query(migration);
    return await callback({ pool });
  } finally {
    await pool.end();
    const cleanup = await admin.connect();
    try { await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { cleanup.release(); await admin.end(); }
  }
}
