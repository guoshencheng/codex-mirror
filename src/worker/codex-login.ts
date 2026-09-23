import { mkdir, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Pool } from 'pg';
import { CodexLoginRepository } from '../server/providers/codex/login-repository';
import { startCodexDeviceLogin, type DeviceCode } from '../server/providers/codex/login-rpc';
import { normalizeCodex } from '../server/providers/codex/strategy';

interface LoginDeps {
  runtimeRoot?: string;
  login?: typeof startCodexDeviceLogin;
}

function runtimeHome(root: string, accountId: string): string {
  if (!/^codex_[a-f0-9]{32}$/.test(accountId)) throw new Error('INVALID_ACCOUNT_ID');
  const base = resolve(root);
  const home = resolve(base, accountId);
  if (!home.startsWith(`${base}${sep}`)) throw new Error('INVALID_ACCOUNT_ID');
  return home;
}

export async function cleanupCodexLoginHome(root: string, accountId: string): Promise<void> {
  await rm(runtimeHome(root, accountId), { recursive: true, force: true });
}

export async function processCodexLoginOnce(pool: Pool, signal: AbortSignal, deps: LoginDeps = {}): Promise<boolean> {
  const repository = new CodexLoginRepository(pool);
  const request = await repository.claimNext();
  if (!request) return false;
  const home = runtimeHome(deps.runtimeRoot ?? process.env.CODEX_RUNTIME_ROOT ?? '/var/lib/dashboard-auth/codex', request.accountId);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const poll = setInterval(() => {
    void repository.status(request.id).then(status => {
      if (status !== 'starting' && status !== 'awaiting') controller.abort();
    }).catch(() => controller.abort());
  }, 1000);
  let saved = false;
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const outcome = await (deps.login ?? startCodexDeviceLogin)(home, controller.signal, async (code: DeviceCode) => {
      const updated = await repository.markAwaiting(request.id, code.verificationUrl, code.userCode, code.loginId);
      if (!updated) { controller.abort(); throw new Error('LOGIN_CANCELLED'); }
    });
    if (controller.signal.aborted) throw new Error('LOGIN_CANCELLED');
    const snapshot = normalizeCodex(outcome.rateLimits, request.accountId, new Date().toISOString());
    saved = await repository.complete(request.id, snapshot);
    if (!saved) throw new Error('LOGIN_CANCELLED');
  } catch (error) {
    const code = error instanceof Error && /^(LOGIN_EXPIRED|LOGIN_CANCELLED|CODEX_AUTH_UNAVAILABLE|CODEX_AUTH_FAILED|CODEX_UNAVAILABLE|INVALID_VERIFICATION_URL)$/.test(error.message)
      ? error.message : 'LOGIN_FAILED';
    await repository.fail(request.id, code);
  } finally {
    clearInterval(poll);
    signal.removeEventListener('abort', abort);
    controller.abort();
    if (!saved) await cleanupCodexLoginHome(deps.runtimeRoot ?? process.env.CODEX_RUNTIME_ROOT ?? '/var/lib/dashboard-auth/codex', request.accountId).catch(() => undefined);
  }
  return true;
}
