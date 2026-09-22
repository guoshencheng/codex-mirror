import type { Pool } from 'pg';
import { createDatabasePool } from '../db/pool';

let pool: Pool | undefined;

export function authDatabasePool(): Pool {
  pool ??= createDatabasePool();
  return pool;
}

export async function closeAuthDatabasePool(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
