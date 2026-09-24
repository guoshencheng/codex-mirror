import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { defaultConfigPath, loadCollectorConfig } from './config';
import { createCollectorClient } from './client';
import { normalizeHook, normalizeKimiHook } from './hook';
import { defaultHooksConfigPath, installHooks, uninstallHooks } from './install';
import { defaultKimiConfigPath, installKimiHooks } from './install-kimi';
import { resolveProject } from './project';
import { openQueue } from './queue';
import { runCollectorLoop } from './heartbeat';
import { readThreadTitles } from './title';

const maxHookInputBytes = 1_000_000;

async function readHookInput(): Promise<{ value: unknown; oversized: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let oversized = false;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxHookInputBytes) {
      oversized = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (oversized) return { value: null, oversized: true };
  try { return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, oversized: false }; }
  catch { return { value: null, oversized: false }; }
}

function hookName(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = (value as Record<string, unknown>).hook_event_name;
  return typeof event === 'string' ? event : null;
}

async function runHook(eventArgument?: string, source: 'codex' | 'kimi' = 'codex'): Promise<void> {
  const stopEvent = source === 'codex' && eventArgument === 'Stop';
  let queue: ReturnType<typeof openQueue> | null = null;
  try {
    const input = await readHookInput();
    if (input.oversized || input.value === null || (eventArgument && hookName(input.value) !== eventArgument)) {
      process.stderr.write('codex-status-dashboard: invalid hook input\n');
      return;
    }
    const event = source === 'kimi' ? normalizeKimiHook(input.value) : normalizeHook(input.value);
    if (!event) return;
    const config = loadCollectorConfig();
    queue = openQueue(config.queuePath, 100_000_000, config.deviceId);
    const raw = input.value as Record<string, unknown>;
    const project = event.type === 'tool.finished' ? null : resolveProject(raw.cwd, config.deviceId, queue);
    const metadata = { ...event.metadata, ...(project ?? {}) };
    queue.appendHook({ ...event, metadata });
    if (source === 'kimi' && typeof event.metadata.title === 'string') {
      queue.recordTitleCheck(event.sessionId, event.metadata.title, event.occurredAt);
    }
  } catch {
    // Keep hook failures out of model context and never make tracking control Codex.
    process.stderr.write('codex-status-dashboard: event capture failed\n');
  } finally {
    try { queue?.close(); } catch { /* best-effort local cleanup */ }
    if (stopEvent) process.stdout.write('{"continue":true}\n');
  }
}

async function runDaemon(): Promise<void> {
  const config = loadCollectorConfig();
  const queue = openQueue(config.queuePath, 100_000_000, config.deviceId);
  const client = createCollectorClient(config);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runCollectorLoop({
      queue,
      bootId: randomUUID(),
      heartbeat: input => client.heartbeat(input),
      upload: client.upload,
      refreshMetadata: async () => {
        const now = new Date().toISOString();
        const candidates = queue.titleCandidates(now, 10).filter(sessionId => !sessionId.startsWith('kimi:'));
        if (candidates.length === 0) return;
        const titles = await readThreadTitles(candidates, { signal: controller.signal });
        for (const [sessionId, title] of titles) queue.recordTitleCheck(sessionId, title, new Date().toISOString());
      },
      signal: controller.signal,
      onError: code => process.stderr.write(`codex-status-dashboard: ${code}\n`),
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    queue.close();
  }
}

function codexHome(): string {
  return process.env.CODEX_HOME || `${process.env.HOME ?? ''}/.codex`;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, option] = argv;
  if (command === 'hook') return runHook(option);
  if (command === 'hook-kimi') return runHook(option, 'kimi');
  if (command === 'run') return runDaemon();
  if (command === 'install-kimi') {
    const result = await installKimiHooks(defaultKimiConfigPath(process.env.HOME ?? ''), {
      nodePath: process.execPath, cliPath: process.argv[1], dryRun: argv.includes('--dry-run'),
    });
    if (argv.includes('--dry-run')) process.stdout.write(result.toml);
    else process.stdout.write(result.changed ? 'Kimi Code hooks installed. Start a new Kimi session to activate them.\n' : 'Kimi Code hooks already installed.\n');
    return;
  }
  if (command === 'install') {
    const result = await installHooks(defaultHooksConfigPath(codexHome()), { dryRun: argv.includes('--dry-run') });
    if (argv.includes('--dry-run')) process.stdout.write(result.json);
    else process.stdout.write(`Codex hooks installed. ${result.trustNotice}\n`);
    return;
  }
  if (command === 'uninstall') {
    const result = await uninstallHooks(defaultHooksConfigPath(codexHome()), argv.includes('--dry-run'));
    if (argv.includes('--dry-run')) process.stdout.write(result.json);
    else process.stdout.write(result.changed ? 'Managed hooks removed.\n' : 'No managed hooks found.\n');
    return;
  }
  process.stderr.write(`Usage: collector <hook EventName|hook-kimi EventName|run|install [--dry-run]|install-kimi [--dry-run]|uninstall [--dry-run]>\nConfig: ${defaultConfigPath()}\n`);
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write('codex-status-dashboard: command failed\n');
    process.exitCode = 1;
  });
}
