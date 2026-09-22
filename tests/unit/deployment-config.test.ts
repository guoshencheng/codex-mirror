import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFile(resolve(root, path), 'utf8');

describe('deployment artifacts', () => {
  it('configures Vercel as a Next.js web/API deployment without a polling cron', async () => {
    const config = JSON.parse(await read('vercel.json')) as Record<string, unknown>;
    expect(config.framework).toBe('nextjs');
    expect(config.crons).toBeUndefined();
    expect(config.outputDirectory).toBeUndefined();
    expect(config.functions).toBeUndefined();
  });

  it('defines remote runtime images and Compose mounts without publishing provider ports', async () => {
    const [dockerfile, compose, accounts, env, ignore] = await Promise.all([
      read('deploy/Dockerfile.provider-runtime'),
      read('deploy/compose.provider-runtime.yaml'),
      read('deploy/provider-accounts.example.json'),
      read('.env.example'),
      read('.dockerignore'),
    ]);
    expect(dockerfile).toMatch(/USER\s+node/);
    expect(dockerfile).toMatch(/@openai\/codex@\$\{CODEX_CLI_VERSION\}/);
    expect(dockerfile).toMatch(/@moonshot-ai\/kimi-code@\$\{KIMI_CODE_VERSION\}/);
    expect(dockerfile).toContain('KIMI_CODE_NO_AUTO_UPDATE=1');
    expect(dockerfile).toContain('HOME=/var/lib/dashboard-auth/kimi');
    expect(dockerfile).not.toMatch(/COPY\s+.*(?:secrets|\.env|auth)/i);
    expect(compose).toMatch(/DATABASE_DIRECT_URL/);
    expect(compose).not.toMatch(/^\s*DATABASE_URL\s*:/m);
    expect(compose).toMatch(/runtime-auth/);
    expect(compose).toMatch(/source: \.\/provider-accounts\.json\n\s+target: \/run\/config\/provider-accounts\.json\n\s+read_only: true/);
    expect(compose).toMatch(/source: \.\/secrets\n\s+target: \/run\/secrets\n\s+read_only: true/);
    expect(compose).not.toMatch(/^\s*ports\s*:/m);
    expect(accounts).toContain('credentialRef');
    expect(accounts).not.toMatch(/(sk-[A-Za-z0-9]{12,}|Bearer\s+\S+)/i);
    expect(env).toContain('DATABASE_URL=');
    expect(env).not.toContain('DATABASE_SESSION_URL=');
    expect(env).toContain('DATABASE_DIRECT_URL=');
    expect(env).not.toMatch(/NEXT_PUBLIC_(?:DATABASE|PROVIDER|CODEX|DEEPSEEK|KIMI)/i);
    expect(env).not.toMatch(/(sk-[A-Za-z0-9]{12,}|refresh_token\s*=\s*[^<])/i);
    expect(ignore).toMatch(/\.env\*/);
    expect(ignore).toMatch(/secrets/);
  });

  it('keeps the health endpoint minimal and uncached', async () => {
    const route = await import('../../src/app/api/health/route');
    const response = await route.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('documents pooled Vercel and direct runtime database URLs separately', async () => {
    const deployment = await read('docs/deployment.md');
    expect(deployment).not.toContain('`DATABASE_SESSION_URL`');
    expect(deployment).toContain('页面可见时每 10 秒');
    expect(deployment).toContain('不要把 worker 使用的 `DATABASE_DIRECT_URL` 配到 Vercel');
  });

  it('documents a pinned Kimi CLI token flow without printing or passing the bearer token in an environment variable', async () => {
    const deployment = await read('docs/deployment.md');
    expect(deployment).toContain('-e HOME=/var/lib/dashboard-auth/kimi');
    expect(deployment).toContain('kimi web rotate-token >/dev/null 2>&1');
    expect(deployment).toContain('cat "$HOME/.kimi-code/server.token"');
    expect(deployment).toContain('KIMI_CODE_NO_AUTO_UPDATE=1');
    expect(deployment).toContain('RESTORE_DATABASE_DIRECT_URL');
    expect(deployment).not.toMatch(/(?:KIMI|KIMICODE)_TOKEN\s*=/i);
  });

  it('backs up with restrictive modes and restores only into an explicit target without clean/drop', async () => {
    const [backup, restore] = await Promise.all([read('scripts/backup.sh'), read('scripts/restore.sh')]);
    expect(backup).toContain('umask 077');
    expect(backup).toContain('pg_dump');
    expect(backup).toContain('/var/lib/dashboard-auth');
    expect(backup).toContain('auth.tar.gz');
    expect(restore).toContain('RESTORE_DATABASE_DIRECT_URL');
    expect(restore).toContain('restore-into-isolated-empty-database');
    expect(restore).toContain('existing_tables');
    expect(restore).toContain('pg_restore');
    expect(restore).not.toMatch(/pg_restore[^\n]*(--clean|--create)|\bDROP\s+DATABASE\b/i);
  });
});
