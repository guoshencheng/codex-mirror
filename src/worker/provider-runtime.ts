import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { runWorker } from './main';

async function superviseKimi(signal: AbortSignal): Promise<void> {
  const home = process.env.KIMI_RUNTIME_HOME ?? '/var/lib/dashboard-auth/kimi';
  await mkdir(home, { recursive: true, mode: 0o700 });
  let retrySeconds = 1;
  while (!signal.aborted) {
    const child = spawn(process.env.KIMI_CLI_COMMAND ?? 'kimi', ['web', '--no-open', '--host', '127.0.0.1'], {
      cwd: home,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: home,
        NODE_ENV: process.env.NODE_ENV ?? 'production',
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      },
    });
    const stop = () => { if (child.exitCode === null && !child.killed) child.kill('SIGTERM'); };
    signal.addEventListener('abort', stop, { once: true });
    await new Promise<void>(resolve => {
      child.once('error', () => resolve());
      child.once('exit', () => resolve());
    });
    signal.removeEventListener('abort', stop);
    if (signal.aborted) break;
    try { await delay(retrySeconds * 1000, undefined, { signal }); }
    catch { break; }
    retrySeconds = Math.min(retrySeconds * 2, 30);
  }
}

async function main(): Promise<void> {
  const shutdown = new AbortController();
  process.once('SIGTERM', () => shutdown.abort());
  process.once('SIGINT', () => shutdown.abort());
  const worker = runWorker(shutdown.signal);
  try {
    await Promise.race([worker, superviseKimi(shutdown.signal)]);
  } finally {
    shutdown.abort();
    await worker.catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { process.exitCode = 1; });
}
