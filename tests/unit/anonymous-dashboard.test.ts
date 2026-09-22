import { describe, expect, it, vi } from 'vitest';

const authDatabasePool = vi.hoisted(() => vi.fn(() => { throw new Error('DATABASE_URL_REQUIRED'); }));
vi.mock('../../src/server/auth/database', () => ({ authDatabasePool }));

import { requireAdmin } from '../../src/server/auth/session';

describe('anonymous dashboard request', () => {
  it('redirects unauthenticated visitors without initializing the database connection', async () => {
    const authenticated = await requireAdmin(new Request('https://dashboard.example/'));
    expect(authenticated).toBeNull();
    expect(authDatabasePool).not.toHaveBeenCalled();
  });
});
