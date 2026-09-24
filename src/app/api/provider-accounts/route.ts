import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eventDatabasePool } from '../../../server/events/database';
import { createDashboardHandlers } from '../../../server/read-model/handlers';
import { requireAdmin, verifyCsrf } from '../../../server/auth/session';
import { readBoundedJson } from '../../../server/auth/request';
import { managedStrategy, type ManagedProviderId } from '../../../server/providers/managed';
import { encryptCredential } from '../../../server/providers/managed-credentials';
import type { ProviderSnapshot } from '../../../contracts/quota';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const accountInput = z.object({
  providerId: z.enum(['deepseek', 'kimi-code-cn']).default('deepseek'),
  label: z.string().trim().min(1).max(120),
  apiKey: z.string().trim().min(1).max(500),
}).strict();
const batchInput = z.object({ accounts: z.array(accountInput).min(1).max(10) }).strict();
type Prepared = { ok: true; id: string; providerId: ManagedProviderId; label: string; ciphertext: string; snapshot: ProviderSnapshot }
  | { ok: false; error: string };

export async function GET(request: Request): Promise<Response> {
  return createDashboardHandlers(eventDatabasePool()).accounts(request);
}

export async function POST(request: Request): Promise<Response> {
  const pool = eventDatabasePool();
  let admin;
  try { admin = await requireAdmin(request, pool); }
  catch { return Response.json({ error: 'AUTH_UNAVAILABLE' }, { status: 503, headers: NO_STORE }); }
  if (!admin) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: NO_STORE });
  if (!await verifyCsrf(request, admin.sessionId, pool)) return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers: NO_STORE });
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
    return Response.json({ error: 'INVALID_INPUT' }, { status: 400, headers: NO_STORE });
  const body = await readBoundedJson(request, 8192);
  if (!body.ok) return Response.json({ error: 'INVALID_INPUT' }, { status: 400, headers: NO_STORE });
  const parsed = batchInput.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: 'INVALID_INPUT' }, { status: 400, headers: NO_STORE });

  const candidates: { id: string; providerId: ManagedProviderId; label: string; apiKey: string; ciphertext: string }[] = [];
  try {
    for (const { providerId, label, apiKey } of parsed.data.accounts) {
      candidates.push({ id: `api_${randomUUID()}`, providerId, label, apiKey, ciphertext: encryptCredential(apiKey) });
    }
  } catch {
    return Response.json({ error: 'CREDENTIAL_STORE_UNAVAILABLE' }, { status: 503, headers: NO_STORE });
  }

  const prepared: Prepared[] = await Promise.all(candidates.map(async ({ id, providerId, label, apiKey, ciphertext }) => {
    const strategy = managedStrategy(providerId)!;
    const result = await strategy.fetchSnapshot({ id, providerId, label, credentialRef: `db:${id}`, options: {} }, {
      signal: new AbortController().signal, readSecret: async () => apiKey,
    });
    return result.ok ? { ok: true, id, providerId, label, ciphertext, snapshot: result.snapshot } : { ok: false, error: result.error.code };
  }));
  const succeeded = prepared.filter((item): item is Extract<Prepared, { ok: true }> => item.ok);
  if (succeeded.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const now = new Date();
      for (const item of succeeded) {
        await client.query('INSERT INTO provider_accounts (id, provider_id, label, credential_ref) VALUES ($1, $2, $3, $4)', [item.id, item.providerId, item.label, `db:${item.id}`]);
        await client.query('INSERT INTO provider_credentials (account_id, ciphertext) VALUES ($1, $2)', [item.id, item.ciphertext]);
        await client.query('INSERT INTO quota_refresh_status (account_id, last_attempt_at, last_success_at, next_attempt_at) VALUES ($1, $2, $2, $3)', [item.id, now, new Date(now.getTime() + 300_000)]);
        await client.query('INSERT INTO quota_latest (account_id, snapshot) VALUES ($1, $2::jsonb)', [item.id, JSON.stringify(item.snapshot)]);
      }
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      return Response.json({ error: 'SAVE_UNAVAILABLE' }, { status: 503, headers: NO_STORE });
    } finally { client.release(); }
  }
  return Response.json({ results: prepared.map(item => item.ok ? { ok: true, id: item.id } : item) }, {
    status: succeeded.length === prepared.length ? 201 : succeeded.length ? 207 : 422, headers: NO_STORE,
  });
}
