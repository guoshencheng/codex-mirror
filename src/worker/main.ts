import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { FileSecretStore } from '../server/providers/secret-store';
import { makeProviderRegistry, readProviderAccountsConfig, validateProviderAccounts } from '../server/providers/bootstrap';
import { createDirectDatabasePool } from '../server/db/pool';
import { QuotaRepository } from '../server/quota/repository';
import { runAccountRefresh } from '../server/quota/refresh';
import { cleanupAgentEvents } from '../server/events/retention';
import { managedStrategy } from '../server/providers/managed';
import { readManagedCredential } from '../server/providers/managed-credentials';
import { CodexLoginRepository } from '../server/providers/codex/login-repository';
import { cleanupCodexLoginHome, processCodexLoginOnce } from './codex-login';
import type { ProviderAccountConfig } from '../contracts/quota';
import type { Pool } from 'pg';

export async function refreshDueAccountsOnce(
  pool: Pool,
  repository: QuotaRepository,
  accounts: readonly ProviderAccountConfig[],
  signal: AbortSignal,
): Promise<void> {
  const due = await repository.listDueAccounts(new Date(), 12);
  const registry = makeProviderRegistry();
  const secretStore = new FileSecretStore(process.env.PROVIDER_SECRETS_ROOT ?? '/run/secrets');
  for (let offset = 0; offset < due.length && !signal.aborted; offset += 3) {
    await Promise.all(due.slice(offset, offset + 3).map(async accountId => {
      const client = await pool.connect();
      let account: ProviderAccountConfig | null;
      try { account = await repository.loadAccount(client, accountId); }
      finally { client.release(); }
      if (!account) return;
      const managed = account.credentialRef === `db:${account.id}`;
      const managedCodex = account.providerId === 'codex' && account.credentialRef === 'managed-codex-login';
      const configured = accounts.some(candidate => candidate.id === accountId);
      if (!managed && !managedCodex && !configured) return;
      const strategy = managed ? managedStrategy(account.providerId) : registry.get(account.providerId);
      if (!strategy) return;
      try {
        await runAccountRefresh(accountId, {
          pool, repository, strategy, signal,
          context: (_config, requestSignal) => ({
            signal: requestSignal,
            readSecret: ref => managed ? readManagedCredential(accountId, pool) : secretStore.read(ref),
          }),
        });
      } catch {
        // Refresh status records retryable failures without exposing upstream credentials.
      }
    }));
  }
}

export async function runWorker(signal: AbortSignal): Promise<void> {
  const pool = createDirectDatabasePool();
  const repository = new QuotaRepository(pool);
  const registry = makeProviderRegistry();
  const accounts = await readProviderAccountsConfig();
  validateProviderAccounts(accounts, registry);
  await repository.upsertConfiguredAccounts(accounts);
  const loginRepository = new CodexLoginRepository(pool);
  const recovered = await loginRepository.recoverStale(true);
  for (const accountId of recovered) {
    await cleanupCodexLoginHome(process.env.CODEX_RUNTIME_ROOT ?? '/var/lib/dashboard-auth/codex', accountId);
  }
  let loginTask: Promise<void> | null = null;

  let nextCleanupAt = Date.now() + 24 * 60 * 60 * 1000;
  try {
    while (!signal.aborted) {
      const now = new Date();
      try {
        await loginRepository.recoverStale();
        if (!loginTask) {
          loginTask = processCodexLoginOnce(pool, signal).then(() => undefined).catch(() => undefined).finally(() => { loginTask = null; });
        }
        await refreshDueAccountsOnce(pool, repository, accounts, signal);
        if (Date.now() >= nextCleanupAt) {
          await cleanupAgentEvents(pool, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
          await repository.cleanupHistory(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
          nextCleanupAt = Date.now() + 24 * 60 * 60 * 1000;
        }
      } catch {
        // Keep the worker alive through transient database failures without exposing connection details.
      }
      if (!signal.aborted) {
        try { await delay(1_000, undefined, { signal }); }
        catch { if (!signal.aborted) throw new Error('WORKER_DELAY_FAILED'); }
      }
    }
  } finally {
    await loginTask?.catch(() => undefined);
    await pool.end();
  }
}

async function main(): Promise<void> {
  const shutdown = new AbortController();
  process.once('SIGTERM', () => shutdown.abort());
  process.once('SIGINT', () => shutdown.abort());
  await runWorker(shutdown.signal);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { process.exitCode = 1; });
}
