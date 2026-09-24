import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readThreadTitles } from '../../collector/src/title';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

it('reads only thread names for known IDs from one app-server process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collector-title-'));
  directories.push(directory);
  const script = join(directory, 'rpc.mjs');
  await writeFile(script, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'thread/read'
    ? { thread: { id: message.params.threadId, name: message.params.threadId === 's1' ? 'Real task' : null, turns: ['SECRET_BODY'] } }
    : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`, { mode: 0o700 });
  await chmod(script, 0o700);
  vi.stubEnv('PATH', '');
  const titles = await readThreadTitles(['s1', 's2'], { command: script, args: [], home: directory, timeoutMs: 3_000 });
  expect(titles).toEqual(new Map([['s1', 'Real task'], ['s2', null]]));
});
