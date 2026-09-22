import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_PASSWORD_BYTES = 1_024;

function deriveKey(password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, key) => {
      if (error) reject(error);
      else resolve(Buffer.from(key));
    });
  });
}

export function validatePassword(password: string): void {
  const bytes = Buffer.byteLength(password, 'utf8');
  if (Array.from(password).length < 12 || bytes > MAX_PASSWORD_BYTES) throw new Error('INVALID_ADMIN_PASSWORD');
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
  }) as Buffer;
  return `$scrypt$N=${COST},r=${BLOCK_SIZE},p=${PARALLELIZATION}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = /^\$scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(encoded);
  if (!match) return false;
  const cost = Number(match[1]);
  const blockSize = Number(match[2]);
  const parallelization = Number(match[3]);
  const salt = Buffer.from(match[4]!, 'base64url');
  const expected = Buffer.from(match[5]!, 'base64url');
  if (cost < 2_048 || cost > 65_536 || (cost & (cost - 1)) !== 0 || blockSize < 1 || blockSize > 16 || parallelization < 1 || parallelization > 4 || salt.length < 16 || salt.length > 64 || expected.length < 32 || expected.length > 128) return false;
  try {
    const actual = await deriveKey(password, salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
    }) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
