import { z } from 'zod';
import { isJsonRequest } from '../../../../server/auth/csrf';
import { readBoundedJson } from '../../../../server/auth/request';
import { requireAdmin, verifyCsrf } from '../../../../server/auth/session';
import { eventDatabasePool } from '../../../../server/events/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const renameInput = z.object({
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().trim().min(1).max(120),
}).strict();

export async function POST(request: Request): Promise<Response> {
  if (!isJsonRequest(request)) return Response.json({ error: 'JSON_REQUIRED' }, { status: 415, headers: NO_STORE });
  const admin = await requireAdmin(request);
  if (!admin) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: NO_STORE });
  if (!await verifyCsrf(request, admin.sessionId)) return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers: NO_STORE });
  const body = await readBoundedJson(request, 1_024);
  const parsed = body.ok ? renameInput.safeParse(body.value) : null;
  if (!parsed?.success) return Response.json({ error: 'INVALID_INPUT' }, { status: 400, headers: NO_STORE });
  try {
    const result = await eventDatabasePool().query(
      'UPDATE devices SET name = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id, name',
      [parsed.data.id, parsed.data.name],
    );
    if (!result.rowCount) return Response.json({ error: 'DEVICE_NOT_FOUND' }, { status: 404, headers: NO_STORE });
    return Response.json(result.rows[0], { headers: NO_STORE });
  } catch {
    return Response.json({ error: 'SAVE_UNAVAILABLE' }, { status: 503, headers: NO_STORE });
  }
}
