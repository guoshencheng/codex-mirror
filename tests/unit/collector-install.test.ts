import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installHooks, uninstallHooks } from '../../collector/src/install';

const directories: string[] = [];
async function makeConfig(input?: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'collector-install-'));
  directories.push(directory);
  const path = join(directory, 'hooks.json');
  if (input !== undefined) await writeFile(path, JSON.stringify(input), { mode: 0o600 });
  return { path, directory };
}
const ownCommand = (event: string) => `'/usr/bin/node' '/path with space/cli.js' hook ${event} --managed-by=codex-status-dashboard`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('Codex Hooks installer', () => {
  it('merges event hooks and preserves unrelated user configuration', async () => {
    const existing = { description: 'personal hooks', extra: { kept: true }, hooks: {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo personal' }] }],
    } };
    const { path } = await makeConfig(existing);
    const result = await installHooks(path, { nodePath: '/usr/bin/node', cliPath: '/path with space/cli.js' });
    const stored = JSON.parse(await readFile(path, 'utf8'));
    expect(stored.description).toBe('personal hooks');
    expect(stored.extra).toEqual({ kept: true });
    expect(stored.hooks.PostToolUse[0].hooks[0].command).toBe('echo personal');
    expect(stored.hooks.Stop[0].hooks[0]).toMatchObject({ type: 'command', command: ownCommand('Stop'), timeout: 3 });
    expect(stored.hooks.SessionEnd[0].hooks[0]).toMatchObject({ command: ownCommand('SessionEnd'), timeout: 3 });
    expect(result.trustNotice).toContain('/hooks');
    expect(result.backupPath).toContain('.bak');
  });

  it('is idempotent and a dry run never writes files', async () => {
    const { path } = await makeConfig({ hooks: {} });
    const before = await readFile(path, 'utf8');
    const dry = await installHooks(path, { nodePath: '/node', cliPath: '/cli.js', dryRun: true });
    expect(dry.changed).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(before);
    await installHooks(path, { nodePath: '/node', cliPath: '/cli.js' });
    const first = await readFile(path, 'utf8');
    await installHooks(path, { nodePath: '/node', cliPath: '/cli.js' });
    expect(await readFile(path, 'utf8')).toBe(first);
  });

  it('removes only its own handler and retains unrelated handlers in the same event group', async () => {
    const { path } = await makeConfig({ hooks: {
      Stop: [{ hooks: [
        { type: 'command', command: ownCommand('Stop'), timeout: 3 },
        { type: 'command', command: 'echo keep' },
      ] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: ownCommand('SessionEnd'), timeout: 3 }] }],
    } });
    await uninstallHooks(path);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    expect(stored.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'echo keep' }] }]);
    expect(stored.hooks.SessionEnd).toBeUndefined();
  });

  it('fails closed on malformed hook shapes without replacing the original file', async () => {
    const { path } = await makeConfig({ hooks: { Stop: 'not-an-array' } });
    const before = await readFile(path, 'utf8');
    await expect(installHooks(path, { nodePath: '/node', cliPath: '/cli.js' })).rejects.toThrow('INVALID_HOOKS_CONFIG');
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});
