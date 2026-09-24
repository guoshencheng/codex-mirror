import { afterEach, describe, expect, it } from 'vitest';
import { encryptCredential, readManagedCredential } from '../../src/server/providers/managed-credentials';

const previous = process.env.PROVIDER_CREDENTIAL_KEY;
afterEach(() => {
  if (previous === undefined) delete process.env.PROVIDER_CREDENTIAL_KEY;
  else process.env.PROVIDER_CREDENTIAL_KEY = previous;
});

describe('managed provider credentials', () => {
  it('encrypts API keys with a fresh nonce and decrypts only with the configured key', async () => {
    process.env.PROVIDER_CREDENTIAL_KEY = `${Buffer.alloc(32, 7).toString('base64url')}\n`;
    const first = encryptCredential('sk-private-value');
    const second = encryptCredential('sk-private-value');
    expect(first).not.toBe(second);
    expect(first).not.toContain('sk-private-value');
    const pool = { query: async () => ({ rows: [{ ciphertext: first }] }) };
    expect(await readManagedCredential('api-one', pool as never)).toBe('sk-private-value');
    process.env.PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 8).toString('base64url');
    await expect(readManagedCredential('api-one', pool as never)).rejects.toThrow();
  });
});
