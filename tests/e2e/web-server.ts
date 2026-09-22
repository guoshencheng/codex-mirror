import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createAdmin } from '../../src/server/auth/admin';
import { createDevice } from '../../src/server/events/devices';

const TEST_USERNAME = 'owner@example.test';
const TEST_PASSWORD = 'correct horse battery staple 7';

function testConnectionString(): string {
  const value = process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql:///codex_status_dashboard_test';
  const database = decodeURIComponent(new URL(value).pathname.replace(/^\//, ''));
  if (!database.endsWith('_test')) throw new Error('TEST_DATABASE_NAME_REQUIRED');
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = testConnectionString();
  const schema = `e2e_${randomUUID().replaceAll('-', '')}`;
  const fixtureFile = process.env.E2E_FIXTURE_FILE;
  if (!fixtureFile) throw new Error('E2E_FIXTURE_FILE_REQUIRED');
  const port = process.env.E2E_PORT ?? '3119';
  const origin = process.env.APP_ORIGIN ?? `http://127.0.0.1:${port}`;
  const migrationDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
  const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const owner = new Pool({ connectionString: databaseUrl, max: 1 });
  let app: Pool | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let stopping = false;

  try {
    await owner.query(`CREATE SCHEMA ${schema}`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
    app = new Pool({ connectionString: scopedUrl.toString(), max: 5 });
    const migrations = (await readdir(migrationDir)).filter(file => /^\d{3}-.*\.sql$/.test(file)).sort();
    if (migrations.length !== 3) throw new Error('EXPECTED_THREE_MIGRATIONS');
    for (const migration of migrations) {
      await app.query(await readFile(resolve(migrationDir, migration), 'utf8'));
    }
    await createAdmin(TEST_USERNAME, TEST_PASSWORD, app);
    const device = await createDevice('Playwright test device', app);
    await writeFile(fixtureFile, JSON.stringify({ deviceId: device.id, deviceToken: device.token, epoch: randomUUID() }), { mode: 0o600 });

    child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', port], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DATABASE_URL: scopedUrl.toString(),
        DATABASE_SESSION_URL: scopedUrl.toString(),
        DATABASE_DIRECT_URL: scopedUrl.toString(),
        APP_ORIGIN: origin,
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
    await unlink(fixtureFile).catch(() => undefined);
  }
}

void main().catch(error => {
  process.stderr.write(`Playwright web server setup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
