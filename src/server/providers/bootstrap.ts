import { mkdir, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ProviderAccountConfig } from '../../contracts/quota';
import { CodexRpc } from './codex/rpc';
import { CodexQuotaStrategy } from './codex/strategy';
import { DeepSeekBalanceStrategy } from './deepseek/strategy';
import { KimiCodeQuotaStrategy } from './kimi-code/strategy';
import { ProviderRegistry } from './registry';

const accountSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  providerId: z.enum(['codex', 'deepseek', 'kimi-code']),
  label: z.string().min(1).max(120),
  credentialRef: z.string().min(1).max(240),
  options: z.record(z.string(), z.unknown()).default({}),
}).strict();

export async function readProviderAccountsConfig(path = process.env.PROVIDER_ACCOUNTS_FILE ?? '/etc/dashboard/provider-accounts.json'): Promise<ProviderAccountConfig[]> {
  try {
    return parseProviderAccounts(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    throw new Error('PROVIDER_ACCOUNTS_CONFIG_UNAVAILABLE_OR_INVALID');
  }
}

export function parseProviderAccounts(value: unknown): ProviderAccountConfig[] {
  const parsed = z.array(accountSchema).max(100).safeParse(value);
  if (!parsed.success || new Set(parsed.data?.map(account => account.id)).size !== parsed.data?.length) {
    throw new Error('INVALID_PROVIDER_ACCOUNTS_CONFIG');
  }
  return parsed.data;
}

export function validateProviderAccounts(accounts: readonly ProviderAccountConfig[], registry: ProviderRegistry): void {
  for (const account of accounts) {
    if (registry.get(account.providerId).validateConfig(account).length) throw new Error('INVALID_PROVIDER_ACCOUNTS_CONFIG');
  }
}

function accountRuntimeHome(accountId: string, root = process.env.CODEX_RUNTIME_ROOT ?? '/var/lib/dashboard-auth/codex'): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(accountId)) throw new Error('INVALID_ACCOUNT_ID');
  const base = resolve(root);
  const home = resolve(base, accountId);
  if (!home.startsWith(`${base}${sep}`)) throw new Error('INVALID_ACCOUNT_ID');
  return home;
}

export function makeProviderRegistry(options: {
  codexRuntimeRoot?: string;
  deepSeekApiUrl?: string;
} = {}): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new CodexQuotaStrategy(accountId => {
    const home = accountRuntimeHome(accountId, options.codexRuntimeRoot);
    return {
      readRateLimits: async signal => {
        await mkdir(home, { recursive: true, mode: 0o700 });
        return new CodexRpc(home).readRateLimits(signal);
      },
    };
  }));
  registry.register(new DeepSeekBalanceStrategy(options.deepSeekApiUrl));
  registry.register(new KimiCodeQuotaStrategy());
  return registry;
}
