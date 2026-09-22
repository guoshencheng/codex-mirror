import { mkdtemp, chmod, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCollectorConfig } from '../../collector/src/config';

const directories: string[] = [];
async function makeConfig(content: object, mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), 'collector-config-'));
  directories.push(directory);
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify(content), { mode });
  await chmod(path, mode);
  return { path, directory };
}
const base = {
  schemaVersion: 1, deviceId: 'device-a', deviceToken: 'a'.repeat(64),
  serverUrl: 'https://dashboard.example.test', queuePath: './queue.sqlite',
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('collector configuration', () => {
  it('loads strict config and resolves local queue paths against the config directory', async () => {
    const { path, directory } = await makeConfig(base);
    expect(loadCollectorConfig(path)).toEqual({ ...base, serverUrl: 'https://dashboard.example.test', queuePath: join(directory, 'queue.sqlite') });
  });

  it('rejects credentials in config files readable by group or other users', async () => {
    const { path } = await makeConfig(base, 0o640);
    expect(() => loadCollectorConfig(path)).toThrow('CONFIG_FILE_PERMISSIONS');
  });

  it('requires HTTPS outside local development', async () => {
    const { path } = await makeConfig({ ...base, serverUrl: 'http://dashboard.example.test' });
    expect(() => loadCollectorConfig(path, true)).toThrow('HTTPS_REQUIRED');
  });

  it('allows localhost HTTP only in non-production and rejects unexpected keys', async () => {
    const { path } = await makeConfig({ ...base, serverUrl: 'http://127.0.0.1:3000' });
    expect(loadCollectorConfig(path, false).serverUrl).toBe('http://127.0.0.1:3000');
    const { path: invalid } = await makeConfig({ ...base, prompt: 'must not be stored' });
    expect(() => loadCollectorConfig(invalid, false)).toThrow('INVALID_CONFIG');
  });

  it('rejects a symbolic link as a credentials file', async () => {
    const { path, directory } = await makeConfig(base);
    const alias = join(directory, 'alias.json');
    await symlink(path, alias);
    expect(() => loadCollectorConfig(alias)).toThrow('CONFIG_FILE_UNAVAILABLE');
  });
});
