import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const SHORT_USER_TOKEN = /^[23456789abcdefghjkmnpqrstvwxyz]{8}$/;
const LEGACY_USER_TOKEN = /^cdu_[A-Za-z0-9_-]{43}$/;

function configuredUserToken(): string {
  const path = process.env.DASHBOARD_USER_TOKEN_FILE;
  if (!path || !isAbsolute(path)) throw new Error('USER_TOKEN_FILE_UNAVAILABLE');
  let content: string;
  try { content = readFileSync(path, 'utf8'); }
  catch { throw new Error('USER_TOKEN_FILE_UNAVAILABLE'); }
  const token = content.replace(/\r?\n$/, '');
  if (!SHORT_USER_TOKEN.test(token) && !LEGACY_USER_TOKEN.test(token)) throw new Error('USER_TOKEN_FILE_INVALID');
  return token;
}

export function matchesConfiguredUserToken(candidate: string): boolean {
  const expected = Buffer.from(configuredUserToken());
  const actual = Buffer.from(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function configuredUserTokenFingerprint(): string {
  return createHash('sha256').update('dashboard-session-key-v1:').update(configuredUserToken()).digest('hex');
}
