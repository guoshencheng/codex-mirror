import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDirectDatabasePool } from '../src/server/db/pool';

async function migrate(): Promise<void> {
  const pool = createDirectDatabasePool();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', ['codex-status-dashboard:migrations']);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
    const files = (await readdir(directory)).filter(file => /^\d{3}-[a-z0-9-]+\.sql$/.test(file)).sort();
    for (const file of files) {
      const alreadyApplied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
      if (alreadyApplied.rowCount) continue;
      const sql = await readFile(resolve(directory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['codex-status-dashboard:migrations']).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void migrate().catch(() => { process.exitCode = 1; });
}
