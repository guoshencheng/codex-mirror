import { pathToFileURL } from 'node:url';
import { FileSecretStore } from '../src/server/providers/secret-store';
import { makeProviderRegistry, readProviderAccountsConfig } from '../src/server/providers/bootstrap';

async function probe(): Promise<void> {
  const provider = process.argv[process.argv.indexOf('--provider') + 1];
  if (!['codex', 'deepseek', 'kimi-code'].includes(provider ?? '')) {
    throw new Error('USAGE: providers:probe -- --provider codex|deepseek|kimi-code');
  }
  const accounts = (await readProviderAccountsConfig()).filter(account => account.providerId === provider);
  if (!accounts.length) throw new Error('NO_CONFIGURED_PROVIDER_ACCOUNTS');
  const registry = makeProviderRegistry();
  const strategy = registry.get(provider!);
  const secrets = new FileSecretStore(process.env.PROVIDER_SECRETS_ROOT ?? '/srv/dashboard/secrets');
  const results = [];
  for (const account of accounts) {
    const errors = strategy.validateConfig(account);
    if (errors.length) {
      results.push({ provider, account: account.label, ok: false, code: 'UNSUPPORTED' });
      continue;
    }
    const controller = new AbortController();
    const result = await strategy.fetchSnapshot(account, {
      signal: controller.signal,
      readSecret: ref => secrets.read(ref),
    });
    results.push(result.ok
      ? { provider, account: account.label, ok: true, metricCount: result.snapshot.metrics.length, observedAt: result.snapshot.observedAt }
      : { provider, account: account.label, ok: false, code: result.error.code });
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (results.some(result => !result.ok)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void probe().catch(error => {
    process.stderr.write(`${error instanceof Error && error.message.startsWith('USAGE:') ? error.message : 'PROVIDER_PROBE_FAILED'}\n`);
    process.exitCode = 1;
  });
}
