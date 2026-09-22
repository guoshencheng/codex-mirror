import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { defaultConfigPath, loadCollectorConfig } from './config';
import { createCollectorClient } from './client';
import { normalizeHook } from './hook';
import { defaultHooksConfigPath, installHooks, uninstallHooks } from './install';
import { resolveProject } from './project';
import { openQueue } from './queue';
import { runCollectorLoop } from './heartbeat';

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

async function runHook(eventArgument?: string): Promise<void> {
  const stopEvent = eventArgument === 'Stop';
  let queue: ReturnType<typeof openQueue> | null = null;
  try {
    const input = await readHookInput();
    if (input.oversized || input.value === null || (eventArgument && hookName(input.value) !== eventArgument)) {
      process.stderr.write('codex-status-dashboard: invalid hook input\n');
      return;
    }
    const event = normalizeHook(input.value);
    if (!event) return;
    const config = loadCollectorConfig();
    queue = openQueue(config.queuePath, 100_000_000, config.deviceId);
    const raw = input.value as Record<string, unknown>;
    const project = resolveProject(raw.cwd, config.deviceId, queue);
    const metadata = { ...event.metadata, ...(project ?? {}) };
    queue.append({ ...event, metadata });
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
  if (command === 'run') return runDaemon();
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
  process.stderr.write(`Usage: collector <hook EventName|run|install [--dry-run]|uninstall [--dry-run]>\nConfig: ${defaultConfigPath()}\n`);
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('codex-status-dashboard: command failed\n');
    process.exitCode = 1;
  });
}
