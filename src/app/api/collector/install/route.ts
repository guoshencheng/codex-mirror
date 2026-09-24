import { eventDatabasePool } from '../../../../server/events/database';
import { hasUsableDeviceInstallGrant } from '../../../../server/events/devices';
import { collectorPublicOrigin } from '../../../../server/events/install-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = {
  'Cache-Control': 'no-store, private',
  'Content-Type': 'text/x-shellscript; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const grants = url.searchParams.getAll('grant');
  if (grants.length !== 1 || [...url.searchParams.keys()].some(key => key !== 'grant') || !/^[A-Za-z0-9_-]{43}$/.test(grants[0]!)) {
    return new Response('Invalid or expired installer link. Generate a new one from the Dashboard.\n', { status: 410, headers: NO_STORE });
  }
  const grant = grants[0]!;
  const pool = eventDatabasePool();
  try {
    if (!(await hasUsableDeviceInstallGrant(grant, pool))) {
      return new Response('Invalid or expired installer link. Generate a new one from the Dashboard.\n', { status: 410, headers: NO_STORE });
    }
    const origin = collectorPublicOrigin();
    const script = `#!/usr/bin/env bash
set -euo pipefail
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' ${shellQuote(`${origin}/install.sh?v=${Date.now()}`)} | COLLECTOR_SERVER_URL=${shellQuote(origin)} COLLECTOR_ENROLLMENT_GRANT=${shellQuote(grant)} bash -s -- "$@"
`;
    return new Response(script, { status: 200, headers: NO_STORE });
  } catch {
    return new Response('Installer temporarily unavailable. Try again later.\n', { status: 503, headers: NO_STORE });
  }
}
