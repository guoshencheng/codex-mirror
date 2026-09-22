import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { FileSecretStore } from '../server/providers/secret-store';
import { makeProviderRegistry, readProviderAccountsConfig, validateProviderAccounts } from '../server/providers/bootstrap';
import { createDirectDatabasePool } from '../server/db/pool';
import { QuotaRepository } from '../server/quota/repository';
import { runAccountRefresh } from '../server/quota/refresh';
import { cleanupAgentEvents } from '../server/events/retention';

export async function runWorker(signal: AbortSignal): Promise<void> {
  const pool = createDirectDatabasePool();
  const repository = new QuotaRepository(pool);
  const registry = makeProviderRegistry();
  const accounts = await readProviderAccountsConfig();
  validateProviderAccounts(accounts, registry);
  const secretStore = new FileSecretStore(process.env.PROVIDER_SECRETS_ROOT ?? '/run/secrets');
  await repository.upsertConfiguredAccounts(accounts);

  let nextCleanupAt = Date.now() + 24 * 60 * 60 * 1000;
  try {
    while (!signal.aborted) {
      const now = new Date();
      try {
        const due = await repository.listDueAccounts(now, 12);
        for (let offset = 0; offset < due.length && !signal.aborted; offset += 3) {
          await Promise.all(due.slice(offset, offset + 3).map(async accountId => {
            const account = accounts.find(candidate => candidate.id === accountId);
            if (!account) return;
            try {
              await runAccountRefresh(accountId, {
                pool,
                repository,
                strategy: registry.get(account.providerId),
                signal,
                context: (_config, requestSignal) => ({
                  signal: requestSignal,
                  readSecret: ref => secretStore.read(ref),
                }),
              });
            } catch {
              // Do not log upstream or filesystem error text; retry is represented in the database when possible.
            }
          }));
        }
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
