import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'dashboard-integration-token-'));
const path = join(directory, 'user-token');
const token = `cdu_${'a'.repeat(43)}`;
process.env.DASHBOARD_USER_TOKEN_FILE = path;
writeFileSync(path, `${token}\n`, { mode: 0o600 });

beforeEach(() => writeFileSync(path, `${token}\n`, { mode: 0o600 }));
afterAll(() => {
  delete process.env.DASHBOARD_USER_TOKEN_FILE;
  rmSync(directory, { recursive: true, force: true });
});
