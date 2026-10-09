import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const TEST_PASSWORD = 'cdu_' + 'a'.repeat(43);

function testConnectionString(): string {
  const value = process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
  const database = decodeURIComponent(new URL(value).pathname.replace(/^\//, ''));
  if (!database.endsWith('_test')) throw new Error('TEST_DATABASE_NAME_REQUIRED');
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = testConnectionString();
  const schema = `e2e_${randomUUID().replaceAll('-', '')}`;
  const port = process.env.E2E_PORT ?? '3119';
  const origin = process.env.APP_ORIGIN ?? `http://127.0.0.1:${port}`;
  const migrationDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
  const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const owner = new Pool({ connectionString: databaseUrl, max: 1 });
  let app: Pool | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let stopping = false;
  const tokenDirectory = await mkdtemp(resolve(tmpdir(), 'codex-e2e-token-'));
  const tokenFile = resolve(tokenDirectory, 'user-token');

  try {
    await owner.query(`CREATE SCHEMA ${schema}`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
    app = new Pool({ connectionString: scopedUrl.toString(), max: 5 });
    const migrations = (await readdir(migrationDir)).filter(file => /^\d{3}-.*\.sql$/.test(file)).sort();
    for (const migration of migrations) {
      await app.query(await readFile(resolve(migrationDir, migration), 'utf8'));
    }
    await writeFile(tokenFile, `${TEST_PASSWORD}\n`, { mode: 0o600 });
    const accountId = 'e2e-history-account';
    await app.query(`INSERT INTO provider_accounts(id, provider_id, label, credential_ref, options)
      VALUES ($1, 'fake', 'E2E 历史账号', 'unused', '{}'::jsonb)`, [accountId]);
    await app.query('INSERT INTO quota_refresh_status(account_id, last_attempt_at, last_success_at, next_attempt_at) VALUES ($1, now(), now(), now())', [accountId]);
    const observedAt = (offsetMinutes: number) => new Date(Date.now() - offsetMinutes * 60_000).toISOString();
    const snapshot = (at: string, usedPercent: number) => ({
      accountId, providerId: 'fake', observedAt: at, serviceAvailable: true,
      metrics: [{ kind: 'quota-window', key: 'primary', label: '5H', usedPercent, windowDurationSeconds: 18_000, resetsAt: null }],
    });
    const samples = [snapshot(observedAt(60), 20), snapshot(observedAt(30), 65), snapshot(observedAt(10), 5)];
    await app.query('INSERT INTO quota_latest(account_id, snapshot) VALUES ($1, $2::jsonb)', [accountId, JSON.stringify(samples.at(-1))]);
    for (const sample of samples) await app.query('INSERT INTO quota_snapshots(account_id, observed_at, snapshot) VALUES ($1, $2, $3::jsonb)', [accountId, sample.observedAt, JSON.stringify(sample)]);
    child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', port], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DATABASE_URL: scopedUrl.toString(),
        DATABASE_DIRECT_URL: scopedUrl.toString(),
        APP_ORIGIN: origin,
        DASHBOARD_USER_TOKEN_FILE: tokenFile,
        NODE_ENV: 'development',
      },
      stdio: 'inherit',
    });
    const forwardSignal = (signal: NodeJS.Signals) => {
      if (!stopping) child?.kill(signal);
    };
    process.once('SIGINT', forwardSignal);
    process.once('SIGTERM', forwardSignal);
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      child?.once('error', reject);
      child?.once('exit', code => resolveExit(code ?? 1));
    });
    process.exitCode = exitCode;
  } finally {
    stopping = true;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(resolveExit => child!.once('exit', () => resolveExit()));
    }
    await app?.end();
    await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await owner.end();
    await rm(tokenDirectory, { recursive: true, force: true });
  }
}

void main().catch(error => {
  process.stderr.write(`Playwright web server setup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
