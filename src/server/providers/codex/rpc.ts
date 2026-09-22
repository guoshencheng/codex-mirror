import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ProviderTransportError } from '../http';

interface RpcMessage {
  jsonrpc?: unknown;
  id?: number;
  method?: unknown;
  result?: unknown;
  error?: unknown;
}

/** A short-lived, isolated Codex App Server connection for a single quota read. */
export class CodexRpc {
  constructor(
    private readonly home: string,
    private readonly command = 'codex',
  ) {}

  readRateLimits(signal: AbortSignal, timeoutMs = 30_000): Promise<unknown> {
    if (signal.aborted) return Promise.reject(new Error('REQUEST_ABORTED'));

    return new Promise((resolve, reject) => {
      const child = spawn(this.command, ['app-server', '--listen', 'stdio://'], {
        cwd: this.home,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] as const,
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: process.env.NODE_ENV ?? 'production',
          HOME: this.home,
          CODEX_HOME: this.home,
          ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
          ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        },
      });
      const lines = createInterface({ input: child.stdout });
      const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
      let nextId = 1;
      let settled = false;
      const timeout = setTimeout(() => finish(undefined, new ProviderTransportError('TIMEOUT')), timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        lines.close();
        for (const waiter of pending.values()) waiter.reject(new ProviderTransportError('UNAVAILABLE'));
        pending.clear();
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
      };

      const finish = (value?: unknown, error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };

      const onAbort = () => finish(undefined, new Error('REQUEST_ABORTED'));
      signal.addEventListener('abort', onAbort, { once: true });

      const send = (method: string, params?: unknown): Promise<unknown> => {
        const id = nextId++;
        return new Promise((resolveMessage, rejectMessage) => {
          pending.set(id, { resolve: resolveMessage, reject: rejectMessage });
          const message = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
          child.stdin.write(`${message}\n`, error => {
            if (!error) return;
            pending.delete(id);
            rejectMessage(new ProviderTransportError('UNAVAILABLE'));
          });
        });
      };

      lines.on('line', line => {
        if (Buffer.byteLength(line, 'utf8') > 1_048_576) {
          finish(undefined, new ProviderTransportError('SCHEMA_CHANGED'));
          return;
        }
        let message: RpcMessage;
        try {
          message = JSON.parse(line) as RpcMessage;
        } catch {
          finish(undefined, new ProviderTransportError('SCHEMA_CHANGED'));
          return;
        }
        if (!message || message.jsonrpc !== '2.0') {
          finish(undefined, new ProviderTransportError('SCHEMA_CHANGED'));
          return;
        }
        if (message.method !== undefined) {
          if (typeof message.method !== 'string') {
            finish(undefined, new ProviderTransportError('SCHEMA_CHANGED'));
          }
          return;
        }
        if (!Number.isSafeInteger(message.id)) return;
        const waiter = pending.get(message.id as number);
        if (!waiter) return;
        pending.delete(message.id as number);
        if (message.error !== undefined) waiter.reject(new ProviderTransportError('UNSUPPORTED'));
        else if (!('result' in message)) waiter.reject(new ProviderTransportError('SCHEMA_CHANGED'));
        else waiter.resolve(message.result);
      });

      // Do not retain, parse, or log stderr. The App Server can emit diagnostics there.
      child.stderr.resume();
      child.once('error', () => finish(undefined, new ProviderTransportError('UNAVAILABLE')));
      child.once('exit', () => {
        if (!settled) finish(undefined, new ProviderTransportError('UNAVAILABLE'));
      });

      void (async () => {
        try {
          await send('initialize', {
            clientInfo: { name: 'codex_status_dashboard', title: 'Codex Status Dashboard', version: '0.1.0' },
          });
          if (settled) return;
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
          const result = await send('account/rateLimits/read');
          finish(result);
        } catch (error) {
          if (settled) return;
          finish(undefined, error instanceof ProviderTransportError
            ? error
            : new ProviderTransportError('UNAVAILABLE'));
        }
      })();
    });
  }
}
