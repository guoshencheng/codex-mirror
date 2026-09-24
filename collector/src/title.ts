import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

interface RpcReply { id?: unknown; result?: unknown; error?: unknown }
interface Pending { resolve(value: unknown): void; reject(error: Error): void }

export async function readThreadTitles(sessionIds: readonly string[], options: {
  command?: string;
  args?: string[];
  home?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<Map<string, string | null>> {
  const titles = new Map<string, string | null>();
  if (sessionIds.length === 0) return titles;
  const home = resolve(options.home ?? process.env.CODEX_HOME ?? resolve(homedir(), '.codex'));
  const child = spawn(options.command ?? process.env.CODEX_COMMAND ?? 'codex',
    options.args ?? ['app-server', '--listen', 'stdio://'], {
      cwd: home, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: home, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter) },
    });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  const fail = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const onAbort = () => { fail(new Error('TITLE_READ_ABORTED')); child.kill(); };
  const timer = setTimeout(() => { fail(new Error('TITLE_READ_TIMEOUT')); child.kill(); }, options.timeoutMs ?? 5_000);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  lines.on('line', line => {
    if (Buffer.byteLength(line, 'utf8') > 1_048_576) return;
    let reply: RpcReply;
    try { reply = JSON.parse(line) as RpcReply; } catch { return; }
    if (typeof reply.id !== 'number') return;
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (reply.error !== undefined) waiter.reject(new Error('TITLE_RPC_ERROR'));
    else waiter.resolve(reply.result);
  });
  child.stderr.resume();
  child.stdin.on('error', () => fail(new Error('TITLE_RPC_UNAVAILABLE')));
  child.once('error', () => fail(new Error('TITLE_RPC_UNAVAILABLE')));
  child.once('exit', () => fail(new Error('TITLE_RPC_EXITED')));
  const send = (method: string, params?: unknown): Promise<unknown> => new Promise((resolveReply, rejectReply) => {
    const id = nextId++;
    pending.set(id, { resolve: resolveReply, reject: rejectReply });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`, error => {
      if (!error) return;
      pending.delete(id);
      rejectReply(new Error('TITLE_RPC_UNAVAILABLE'));
    });
  });
  try {
    if (options.signal?.aborted) throw new Error('TITLE_READ_ABORTED');
    await send('initialize', { clientInfo: { name: 'codex_status_dashboard_collector', title: 'Codex Status Dashboard Collector', version: '0.1.0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    for (const sessionId of sessionIds) {
      if (options.signal?.aborted) break;
      try {
        const result = await send('thread/read', { threadId: sessionId, includeTurns: false });
        const thread = result && typeof result === 'object' && 'thread' in result ? result.thread : null;
        const name = thread && typeof thread === 'object' && 'name' in thread ? thread.name : null;
        titles.set(sessionId, typeof name === 'string' ? name : null);
      } catch {
        // A missing or not-yet-persisted thread can be retried on the next collector pass.
      }
    }
    return titles;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    lines.close();
    fail(new Error('TITLE_RPC_CLOSED'));
    if (child.exitCode === null && !child.killed) child.kill();
  }
}
