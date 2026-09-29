import { authorizeDisplayRequest, displayPreflight } from '../../../../server/auth/display';
import { getDashboard } from '../../../../server/read-model/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const authorization = authorizeDisplayRequest(request);
  if ('response' in authorization) return authorization.response;
  try {
    return Response.json(await getDashboard(), { headers: authorization.headers });
  } catch {
    return Response.json({ error: 'UNAVAILABLE' }, { status: 503, headers: authorization.headers });
  }
}

export async function OPTIONS(request: Request): Promise<Response> {
  return displayPreflight(request);
}
