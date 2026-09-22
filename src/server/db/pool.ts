import { Pool } from 'pg';

export function createDatabasePool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error('DATABASE_URL_REQUIRED');
  return new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
}

export function createDirectDatabasePool(): Pool {
  const connectionString = process.env.DATABASE_DIRECT_URL;
  if (!connectionString) throw new Error('DATABASE_DIRECT_URL_REQUIRED');
  return createDatabasePool(connectionString);
}
