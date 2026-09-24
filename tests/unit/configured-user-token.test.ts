import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredUserTokenFingerprint, matchesConfiguredUserToken } from '../../src/server/auth/configured-token';

const directory = mkdtempSync(join(tmpdir(), 'dashboard-token-test-'));
const tokenFile = join(directory, 'user-token');
const tokenA = 'cdu_' + 'a'.repeat(43);
const tokenB = 'cdu_' + 'b'.repeat(43);

afterEach(() => {
  delete process.env.DASHBOARD_USER_TOKEN_FILE;
  rmSync(tokenFile, { force: true });
});

describe('configured user Token', () => {
  it('authenticates only the configured Token without a database lookup', () => {
    writeFileSync(tokenFile, `${tokenA}\n`, { mode: 0o600 });
    process.env.DASHBOARD_USER_TOKEN_FILE = tokenFile;
    expect(matchesConfiguredUserToken(tokenA)).toBe(true);
    expect(matchesConfiguredUserToken(tokenB)).toBe(false);
    expect(matchesConfiguredUserToken('bad')).toBe(false);
  });

  it('fails closed when the private Token file is missing', () => {
    process.env.DASHBOARD_USER_TOKEN_FILE = tokenFile;
    expect(() => matchesConfiguredUserToken(tokenA)).toThrow('USER_TOKEN_FILE_UNAVAILABLE');
  });

  it('changes the session fingerprint when the configured Token rotates', () => {
    writeFileSync(tokenFile, `${tokenA}\n`, { mode: 0o600 });
    process.env.DASHBOARD_USER_TOKEN_FILE = tokenFile;
    const before = configuredUserTokenFingerprint();
    writeFileSync(tokenFile, `${tokenB}\n`, { mode: 0o600 });
    expect(configuredUserTokenFingerprint()).not.toBe(before);
  });
});
