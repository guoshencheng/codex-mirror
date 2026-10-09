import type { Pool } from 'pg';
import { createDatabasePool } from './pool';

let pool: Pool | undefined;

export function applicationDatabasePool(): Pool {
  pool ??= createDatabasePool();
  return pool;
}
