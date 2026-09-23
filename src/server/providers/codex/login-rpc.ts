import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface DeviceCode {
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

function validVerificationUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'auth.openai.com' && !url.username && !url.password;
  } catch { return false; }
}

export async function startCodexDeviceLogin(
  home: string,
  signal: AbortSignal,
  onCode: (code: DeviceCode) => void | Promise<void>,
  command = 'codex',
  timeoutMs = 600_000,
): Promise<{ rateLimits: unknown }> {
  if (signal.aborted) throw new Error('LOGIN_CANCELLED');
  const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
    cwd: home, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: home,
      NODE_ENV: process.env.NODE_ENV ?? 'production', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 1;
  let closed = false;
  let loginCompletion: { loginId: string; success: boolean } | null = null;
  let wakeCompletion: (() => void) | null = null;
  let fatalReject: ((error: Error) => void) | null = null;
  const fatal = new Promise<never>((_resolve, reject) => { fatalReject = reject; });
  const stop = (error: Error) => {
    if (closed) return;
    closed = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    fatalReject?.(error);
    wakeCompletion?.();
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  };
  const timeout = setTimeout(() => stop(new Error('LOGIN_EXPIRED')), timeoutMs);
  const abort = () => stop(new Error('LOGIN_CANCELLED'));
  signal.addEventListener('abort', abort, { once: true });
  child.once('error', () => stop(new Error('CODEX_UNAVAILABLE')));
  child.once('exit', () => stop(new Error('CODEX_UNAVAILABLE')));
  lines.on('line', line => {
    if (Buffer.byteLength(line, 'utf8') > 1_048_576) { stop(new Error('INVALID_PROTOCOL')); return; }
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; }
    catch { stop(new Error('INVALID_PROTOCOL')); return; }
    if (!message || (message.jsonrpc !== undefined && message.jsonrpc !== '2.0')) { stop(new Error('INVALID_PROTOCOL')); return; }
    if (message.method === 'account/login/completed') {
      const params = message.params as Record<string, unknown> | undefined;
      if (params && typeof params.loginId === 'string') {
        loginCompletion = { loginId: params.loginId, success: params.success === true };
        wakeCompletion?.();
      }
      return;
    }
    if (typeof message.method === 'string') return;
    if (!Number.isSafeInteger(message.id)) return;
    const waiter = pending.get(message.id as number);
    if (!waiter) return;
    pending.delete(message.id as number);
    if (message.error !== undefined) waiter.reject(new Error('CODEX_AUTH_UNAVAILABLE'));
    else if (!('result' in message)) waiter.reject(new Error('INVALID_PROTOCOL'));
    else waiter.resolve(message.result);
  });
  const send = (method: string, params?: unknown): Promise<unknown> => {
    if (closed) return Promise.reject(new Error('CODEX_UNAVAILABLE'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`, error => {
        if (error) { pending.delete(id); reject(new Error('CODEX_UNAVAILABLE')); }
      });
    });
  };
  try {
    const work = (async () => {
      await send('initialize', { clientInfo: { name: 'codex_status_dashboard', title: 'Codex Status Dashboard', version: '0.1.0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
      const result = await send('account/login/start', { type: 'chatgptDeviceCode' }) as Record<string, unknown>;
      if (!result || result.type !== 'chatgptDeviceCode' || typeof result.loginId !== 'string' ||
        !/^[0-9a-fA-F-]{36}$/.test(result.loginId) || typeof result.userCode !== 'string' ||
        !/^[A-Za-z0-9-]{4,32}$/.test(result.userCode)) throw new Error('INVALID_PROTOCOL');
      if (!validVerificationUrl(result.verificationUrl)) throw new Error('INVALID_VERIFICATION_URL');
      const code: DeviceCode = { loginId: result.loginId, verificationUrl: result.verificationUrl, userCode: result.userCode };
      await onCode(code);
      while (!loginCompletion) await new Promise<void>(resolve => { wakeCompletion = resolve; });
      const completion = loginCompletion as { loginId: string; success: boolean } | null;
      if (!completion || completion.loginId !== code.loginId || !completion.success) throw new Error('CODEX_AUTH_FAILED');
      const account = await send('account/read', { refreshToken: false }) as Record<string, unknown>;
      if ((account?.account as Record<string, unknown> | undefined)?.type !== 'chatgpt') throw new Error('CODEX_AUTH_FAILED');
      return { rateLimits: await send('account/rateLimits/read') };
    })();
    return await Promise.race([work, fatal]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    closed = true;
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      if (!child.killed) child.kill('SIGTERM');
      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const force = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 250);
        child.once('exit', () => { clearTimeout(force); resolve(); });
      });
    }
  }
}
