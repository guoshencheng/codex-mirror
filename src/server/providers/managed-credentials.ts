import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

function key(): Buffer {
  const encoded = process.env.PROVIDER_CREDENTIAL_KEY?.trim();
  if (!encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error('PROVIDER_CREDENTIAL_KEY_REQUIRED');
  const value = Buffer.from(encoded, 'base64url');
  if (value.length !== 32) throw new Error('PROVIDER_CREDENTIAL_KEY_INVALID');
  return value;
}

export function encryptCredential(plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

function decryptCredential(ciphertext: string): string {
  const [version, nonce, tag, body, extra] = ciphertext.split('.');
  if (version !== 'v1' || !nonce || !tag || !body || extra !== undefined) throw new Error('INVALID_CREDENTIAL');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(nonce, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

export async function readManagedCredential(accountId: string, pool: Pool): Promise<string> {
  const result = await pool.query('SELECT ciphertext FROM provider_credentials WHERE account_id = $1', [accountId]);
  const row = result.rows[0] as { ciphertext?: string } | undefined;
  if (!row?.ciphertext) throw new Error('SECRET_NOT_FOUND');
  return decryptCredential(row.ciphertext);
}
