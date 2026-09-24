import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openQueue } from '../../collector/src/queue';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryDirectories: string[] = [];
const marker = '--managed-by=codex-status-dashboard';
const cli = join(root, 'collector/src/cli.ts');
const tsx = join(root, 'node_modules/tsx/dist/cli.mjs');

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('collector command-line hooks', () => {
  it('always returns a non-interfering JSON response for Stop, including capture failure', () => {
    const result = spawnSync(process.execPath, [tsx, cli, 'hook', 'Stop', marker], { cwd: root, input: '{}', encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"continue":true}\n');
  });

  it('persists only approved event fields and never prints hook payload to model output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'collector-cli-'));
    temporaryDirectories.push(directory);
    const queuePath = join(directory, 'queue.sqlite');
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1, deviceId: 'device-cli', deviceToken: 'c'.repeat(64),
      serverUrl: 'https://dashboard.example.test', queuePath,
    }), { mode: 0o600 });
    const raw = {
      hook_event_name: 'UserPromptSubmit', session_id: 'session-cli', turn_id: 'turn-cli',
      cwd: '/path/that/must/not/be/sent', transcript_path: '/private/transcript.jsonl',
      prompt: 'PROMPT_SECRET', model: 'MODEL_SECRET', permission_mode: 'PERMISSION_SECRET',
      tool_input: { command: 'COMMAND_SECRET' }, tool_response: 'OUTPUT_SECRET',
    };
    const result = spawnSync(process.execPath, [tsx, cli, 'hook', 'UserPromptSubmit', marker], {
      cwd: root, input: JSON.stringify(raw), encoding: 'utf8', env: { ...process.env, COLLECTOR_CONFIG: configPath },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const queue = openQueue(queuePath, 1_000_000, 'device-cli');
    const stored = queue.peek(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ sessionId: 'session-cli', turnId: 'turn-cli', type: 'turn.started' });
    const serialized = JSON.stringify(stored);
    for (const secret of ['PROMPT_SECRET', 'MODEL_SECRET', 'PERMISSION_SECRET', 'COMMAND_SECRET', 'OUTPUT_SECRET', '/path/that/must/not/be/sent', '/private/transcript.jsonl']) {
      expect(serialized).not.toContain(secret);
    }
    queue.close();
  });
});

it('runs the entry point when installed beneath a symlinked directory', async () => {
 const directory=await mkdtemp(join(tmpdir(),'collector-entry-'));temporaryDirectories.push(directory);
 const link=join(directory,'linked-cli.ts');await symlink(cli,link);
 const result=spawnSync(process.execPath,['--import','tsx',link,'hook','Stop',marker],{cwd:root,input:'{}',encoding:'utf8'});
 expect(result.stdout).toBe('{"continue":true}\n');
});
