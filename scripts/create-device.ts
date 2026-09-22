import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDirectDatabasePool } from '../src/server/db/pool';
import { createDevice } from '../src/server/events/devices';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const name = args.join(' ').trim();
  if (!name) throw new Error('DEVICE_NAME_REQUIRED');
  const pool = createDirectDatabasePool();
  try {
    const device = await createDevice(name, pool);
    process.stdout.write(`Device: ${device.name}\nID: ${device.id}\nToken (shown once): ${device.token}\n`);
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => { process.stderr.write('Could not create device. Check database configuration and migration status.\n'); process.exitCode = 1; });
}
