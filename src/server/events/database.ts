import type { Pool } from 'pg';
import { createDatabasePool } from '../db/pool';

let pool: Pool | undefined;

export function eventDatabasePool(): Pool {
  pool ??= createDatabasePool();
  return pool;
}
