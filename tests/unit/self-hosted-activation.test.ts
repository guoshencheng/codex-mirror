import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const activation = readFileSync(new URL('../../deploy/self-hosted/activate.mjs', import.meta.url), 'utf8');

describe('self-hosted activation', () => {
  it('recreates PM2 apps so their cwd follows the new release', () => {
    expect(activation).toContain("run('pm2', ['delete', ...managedRunning]);");
    expect(activation).toContain("run('pm2', ['start', ECOSYSTEM_PATH, '--only', 'dashboard-web,dashboard-worker']);");
    expect(activation).not.toContain("run('pm2', ['startOrReload'");
  });
});
