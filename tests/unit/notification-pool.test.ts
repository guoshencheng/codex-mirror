import { afterEach, describe, expect, it } from 'vitest';
import { notificationDatabasePool } from '../../src/server/db/notifications';

const originalSessionUrl = process.env.DATABASE_SESSION_URL;
const originalDirectUrl = process.env.DATABASE_DIRECT_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalSessionUrl === undefined) delete process.env.DATABASE_SESSION_URL;
  else process.env.DATABASE_SESSION_URL = originalSessionUrl;
  if (originalDirectUrl === undefined) delete process.env.DATABASE_DIRECT_URL;
  else process.env.DATABASE_DIRECT_URL = originalDirectUrl;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe('Vercel SSE database connections', () => {
  it('requires the documented session-capable URL and does not fall back to the worker direct URL', async () => {
    delete process.env.DATABASE_SESSION_URL;
    process.env.DATABASE_DIRECT_URL = 'postgresql://worker.example.com/dashboard';

    expect(() => notificationDatabasePool()).toThrow('DATABASE_SESSION_URL_REQUIRED');

    delete process.env.DATABASE_DIRECT_URL;
    process.env.DATABASE_SESSION_URL = 'postgresql://session.example.com/dashboard';
    process.env.DATABASE_URL = 'postgresql://transaction-pooler.example.com/dashboard';
    const pool = notificationDatabasePool();
    expect(pool.options.connectionString).toBe('postgresql://session.example.com/dashboard');
    expect(pool.options.max).toBe(6);
    await pool.end();
  });
});
