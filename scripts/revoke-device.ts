import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDirectDatabasePool } from '../src/server/db/pool';
import { revokeDevice } from '../src/server/events/devices';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const id = args[0]?.trim();
  if (!id || args.length !== 1) throw new Error('DEVICE_ID_REQUIRED');
  const pool = createDirectDatabasePool();
  try {
    const revoked = await revokeDevice(id, pool);
    process.stdout.write(revoked ? 'Device token revoked.\n' : 'Device was already revoked or does not exist.\n');
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => { process.stderr.write('Could not revoke device. Check the device ID and database configuration.\n'); process.exitCode = 1; });
}
